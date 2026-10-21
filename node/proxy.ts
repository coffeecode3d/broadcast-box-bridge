import { createServer, type Server } from "http";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import type { IncomingHttpHeaders } from "http";

/**
 * FFmpeg's WHIP muxer has two quirks that make it incompatible with Broadcast
 * Box's HTTP layer:
 *
 *  1. Broadcast Box sends the SDP answer with chunked transfer encoding.
 *     FFmpeg's muxer only reads a response when Content-Length is present and
 *     fails with "Failed to read response ... answer is (null)".
 *  2. Broadcast Box lists a private/LAN ICE candidate first and FFmpeg only
 *     honours the first candidate, so remote viewers never connect.
 *
 * This tiny loopback proxy fixes both and rewrites the Location header so the
 * muxer's DELETE request on shutdown still reaches Broadcast Box.
 */

export interface WhipProxy {
    port: number;
    baseUrl: string;
    urlFor(key: string): string;
    close(): Promise<void>;
}

interface ForwardResult {
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
}

function forward(
    url: string,
    options: { method: string; headers: Record<string, string>; body?: string; timeoutMs?: number }
): Promise<ForwardResult> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === "https:";
        const bodyBuffer = options.body != null ? Buffer.from(options.body) : undefined;
        const headers: Record<string, string> = { ...options.headers };
        if (bodyBuffer) headers["Content-Length"] = String(bodyBuffer.byteLength);

        const request = (isHttps ? httpsRequest : httpRequest)(
            {
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: `${parsed.pathname}${parsed.search}`,
                method: options.method,
                headers
            },
            response => {
                const chunks: Buffer[] = [];
                response.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                response.on("end", () => {
                    resolve({
                        status: response.statusCode ?? 0,
                        headers: response.headers,
                        body: Buffer.concat(chunks).toString("utf8")
                    });
                });
                response.on("error", reject);
            }
        );

        request.setTimeout(options.timeoutMs ?? 20_000, () => {
            request.destroy(new Error("Broadcast Box request timed out"));
        });
        request.on("error", reject);
        if (bodyBuffer) request.write(bodyBuffer);
        request.end();
    });
}

function isPrivateAddress(address: string): boolean {
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|0\.|fd|fe80|::1)/i.test(address);
}

/**
 * Stable-partition candidate lines inside each media section so that public
 * addresses come first. FFmpeg's WHIP muxer only uses the first candidate.
 */
export function preferPublicCandidates(sdp: string): string {
    const lines = sdp.split(/\r?\n/);
    const output: string[] = [];
    let candidates: string[] = [];

    const flush = () => {
        if (!candidates.length) return;
        const isPublic = (line: string) => {
            const match = line.match(/^a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ\s+/i);
            return Boolean(match && !isPrivateAddress(match[1]));
        };
        const publicLines = candidates.filter(isPublic);
        const otherLines = candidates.filter(line => !isPublic(line));
        output.push(...publicLines, ...otherLines);
        candidates = [];
    };

    for (const line of lines) {
        if (line.startsWith("a=candidate:")) {
            candidates.push(line);
        } else {
            flush();
            output.push(line);
        }
    }
    flush();

    return output.join("\r\n");
}

export async function createWhipProxy(server: string): Promise<WhipProxy> {
    const base = new URL(server.endsWith("/") ? server : `${server}/`);
    const serverOrigin = base.origin;

    const serverInstance: Server = createServer((request, response) => {
        const respond = (status: number, body = "", headers: Record<string, string> = {}) => {
            const payload = Buffer.from(body);
            response.writeHead(status, {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Length": payload.byteLength,
                Connection: "close",
                ...headers
            });
            response.end(payload);
        };

        const chunks: Buffer[] = [];
        let size = 0;
        request.on("data", chunk => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
                request.destroy();
                return;
            }
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        request.on("end", async () => {
            try {
                if (request.method === "GET" && request.url === "/health") {
                    respond(200, "ok");
                    return;
                }

                const url = new URL(request.url || "/", "http://127.0.0.1");
                const parts = url.pathname.split("/").filter(Boolean);
                if (parts[0] !== "whip" || !parts[1]) {
                    respond(404, "Not found");
                    return;
                }

                const key = decodeURIComponent(parts[1]);
                if (!/^[A-Za-z0-9_-]{1,160}$/.test(key)) {
                    respond(400, "Invalid stream key");
                    return;
                }

                if (request.method === "POST" && parts.length === 2) {
                    const upstream = await forward(`${serverOrigin}/api/whip`, {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${key}`,
                            "Content-Type": "application/sdp",
                            Accept: "application/sdp"
                        },
                        body: Buffer.concat(chunks).toString("utf8")
                    });

                    if (upstream.status < 200 || upstream.status >= 300) {
                        respond(upstream.status, upstream.body || `Broadcast Box returned HTTP ${upstream.status}`);
                        return;
                    }

                    const location = upstream.headers.location || "";
                    const sessionId = String(location).split("/").filter(Boolean).pop() || "";
                    const answer = preferPublicCandidates(upstream.body);
                    const payload = Buffer.from(answer);

                    response.shouldKeepAlive = false;
                    response.writeHead(201, {
                        "Content-Type": "application/sdp",
                        "Content-Length": payload.byteLength,
                        Location: sessionId ? `http://127.0.0.1:${address().port}/whip/${key}/${sessionId}` : "",
                        Connection: "close"
                    });
                    response.end(payload);
                    return;
                }

                if (request.method === "DELETE" && parts.length === 3) {
                    const sessionId = decodeURIComponent(parts[2]);
                    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) {
                        respond(400, "Invalid session id");
                        return;
                    }
                    const upstream = await forward(`${serverOrigin}/api/whip/${sessionId}`, {
                        method: "DELETE",
                        headers: { Authorization: `Bearer ${key}` }
                    });
                    respond(upstream.status >= 200 && upstream.status < 300 ? 204 : upstream.status, "");
                    return;
                }

                if (request.method === "OPTIONS") {
                    respond(204, "");
                    return;
                }

                respond(405, "Method not allowed");
            } catch (error) {
                respond(502, error instanceof Error ? error.message : String(error));
            }
        });

        request.on("error", () => {
            try {
                respond(400, "Bad request");
            } catch {
                // response already sent
            }
        });
    });

    const address = () => {
        const info = serverInstance.address();
        if (!info || typeof info === "string") throw new Error("WHIP proxy did not bind to a TCP port.");
        return { port: info.port };
    };

    await new Promise<void>((resolve, reject) => {
        serverInstance.once("error", reject);
        serverInstance.listen(0, "127.0.0.1", () => {
            serverInstance.off("error", reject);
            resolve();
        });
    });

    const { port } = address();

    return {
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        urlFor(key: string) {
            return `http://127.0.0.1:${port}/whip/${encodeURIComponent(key)}`;
        },
        async close() {
            await new Promise<void>(resolve => {
                serverInstance.close(() => resolve());
                // Do not let an idle keep-alive socket delay shutdown.
                setTimeout(resolve, 1_000).unref?.();
            });
        }
    };
}
