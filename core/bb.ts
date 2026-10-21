import { normalizeServer } from "./config";
import type { BBStatus } from "./types";

export interface StatusOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    return {
        signal: controller.signal,
        dispose: () => clearTimeout(timer)
    };
}

/**
 * Returns the stream status, or null when the stream is not live.
 * Throws only for network/server errors so callers can distinguish "offline"
 * from "the server is unreachable".
 */
export async function fetchStatus(server: string, key: string, options: StatusOptions = {}): Promise<BBStatus | null> {
    const base = normalizeServer(server);
    const { signal, dispose } = withTimeout(options.signal, options.timeoutMs ?? 6_000);
    try {
        const response = await fetch(`${base}/api/status?key=${encodeURIComponent(key)}`, {
            method: "GET",
            cache: "no-store",
            signal
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Status request failed: HTTP ${response.status}`);
        const data = (await response.json()) as Partial<BBStatus>;
        if (!data || typeof data !== "object") return null;
        return {
            streamKey: String(data.streamKey ?? key),
            motd: data.motd,
            viewers: Number(data.viewers ?? 0),
            isOnline: Boolean(data.isOnline),
            streamStart: data.streamStart
        };
    } finally {
        dispose();
    }
}

export async function serverReachable(server: string, timeoutMs = 5_000): Promise<boolean> {
    try {
        const base = normalizeServer(server);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(`${base}/api/status?key=probe`, {
            method: "GET",
            cache: "no-store",
            signal: controller.signal
        });
        clearTimeout(timer);
        // Any HTTP response means the instance is up; 404 is the expected answer.
        return response.status > 0;
    } catch {
        return false;
    }
}

export function watchUrl(server: string, key: string): string {
    return `${normalizeServer(server)}/watch/${encodeURIComponent(key)}`;
}
