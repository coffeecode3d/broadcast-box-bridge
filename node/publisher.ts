import { spawn, execFileSync, type ChildProcess } from "child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { serverReachable } from "../core/bb";
import { isValidStreamKey } from "../core/keys";
import type { BBConfig, PublishState, PublishStats, StartResult } from "../core/types";
import { detectCapabilities } from "./capabilities";
import type { PublishPlan, WindowsCaptureMode } from "./commands";
import { buildPlan } from "./commands";
import { createWhipProxy, type WhipProxy } from "./proxy";

const MAX_LOG_LINES = 400;
const STARTUP_GRACE_MS = 5_000;
const PORTAL_START_TIMEOUT_MS = 120_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function publisherLogPath(): string {
    if (process.env.BB_BRIDGE_LOG) return process.env.BB_BRIDGE_LOG;
    const directory =
        process.env.BB_BRIDGE_LOG_DIR ||
        (process.platform === "win32"
            ? join(process.env.LOCALAPPDATA || tmpdir(), "BroadcastBoxBridge")
            : join(homedir(), ".cache", "BroadcastBoxBridge"));
    return join(directory, "publisher.log");
}

function sanitizeLogLine(line: string): string {
    return line.replace(/\/whip\/[A-Za-z0-9_-]+/g, "/whip/<key>");
}

interface Attempt {
    encoderId: PublishPlan["encoderId"];
    audio: BBConfig["audio"];
    windowsCapture: WindowsCaptureMode;
    warnings: string[];
}

/**
 * Owns the capture and encode processes. One publisher per process; the plugin
 * starts and stops it through the native helper.
 */
export class Publisher {
    private encoder: ChildProcess | null = null;
    private capture: ChildProcess | null = null;
    private audioCaptures: ChildProcess[] = [];
    private proxy: WhipProxy | null = null;
    private plan: PublishPlan | null = null;

    private logs: string[] = [];
    private stats: PublishStats = {};
    private warnings: string[] = [];
    private error: string | null = null;
    private key = "";
    private startedAt = 0;
    private stopRequested = false;
    private generation = 0;
    private progressBuffer = "";
    private captureError: string | null = null;
    private starting: Promise<StartResult> | null = null;
    private readonly logPath = publisherLogPath();

    async start(config: BBConfig, key: string): Promise<StartResult> {
        if (this.starting) return this.starting;
        this.starting = this.doStart(config, key).finally(() => {
            this.starting = null;
        });
        return this.starting;
    }

    state(): PublishState {
        const running = Boolean(this.encoder && this.encoder.exitCode === null);
        return {
            running,
            key: this.key,
            startedAt: this.startedAt || undefined,
            pid: this.encoder?.pid,
            encoder: this.plan?.encoderId,
            command: this.plan ? formatCommand(this.plan) : undefined,
            error: this.error,
            warnings: [...this.warnings],
            logs: this.logs.slice(-MAX_LOG_LINES),
            stats: { ...this.stats }
        };
    }

    async stop(): Promise<{ ok: boolean; error?: string }> {
        this.stopRequested = true;
        this.writeLog("=== stop requested");
        if (!this.encoder && !this.capture && !this.proxy) {
            this.resetProcessState();
            return { ok: true };
        }

        try {
            await this.terminateProcesses();
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
            this.removeTempDir();
            const proxy = this.proxy;
            this.proxy = null;
            if (proxy) {
                try {
                    await proxy.close();
                } catch {
                    // ignored
                }
            }
            this.encoder = null;
            this.capture = null;
            this.plan = null;
            this.startedAt = 0;
            this.error = null;
        }

        return { ok: true };
    }

    // ---- startup ------------------------------------------------------------

    private async doStart(config: BBConfig, key: string): Promise<StartResult> {
        if (this.encoder) {
            return { ok: false, error: "A stream is already being published.", state: this.state() };
        }
        if (!isValidStreamKey(key)) {
            return { ok: false, error: "The derived stream key is not valid.", state: this.state() };
        }

        this.stopRequested = false;
        this.logs = [];
        this.stats = {};
        this.error = null;
        this.warnings = [];
        this.captureError = null;
        this.key = key;
        this.prepareLogFile();
        this.writeLog(
            `=== start server=${config.server} capture=${config.capture} encoder=${config.encoder} ` +
                `resolution=${config.resolution} fps=${config.fps} bitrate=${config.bitrateKbps} audio=${config.audio}`
        );

        const capabilities = await detectCapabilities();
        if (!capabilities.ffmpeg) {
            return { ok: false, error: "FFmpeg was not found in PATH.", state: this.state() };
        }

        const reachable = await serverReachable(config.server);
        if (!reachable) {
            return {
                ok: false,
                error: `Broadcast Box is unreachable at ${config.server}. Check the server URL and your connection.`,
                state: this.state()
            };
        }

        const attempts = buildAttempts(config, capabilities);
        const failures: string[] = [];

        attemptLoop: for (let index = 0; index < attempts.length; index++) {
            const attempt = attempts[index];
            const attemptConfig: BBConfig = { ...config, encoder: attempt.encoderId, audio: attempt.audio };
            let conflictRetries = 0;

            for (;;) {
                let proxy: WhipProxy | null = null;
                let plan: PublishPlan;

                try {
                    proxy = await createWhipProxy(config.server);
                    plan = buildPlan(attemptConfig, capabilities, key, proxy.baseUrl, {
                        windowsCapture: attempt.windowsCapture
                    });
                } catch (error) {
                    failures.push(error instanceof Error ? error.message : String(error));
                    if (proxy) await proxy.close().catch(() => undefined);
                    break attemptLoop;
                }

                if (index > 0 || conflictRetries > 0) {
                    const captureNote =
                        plan.windowsCapture === "amf"
                            ? " (AMF capture)"
                            : plan.windowsCapture === "ddagrab"
                              ? " (ddagrab fallback)"
                              : plan.windowsCapture === "gdigrab"
                                ? " (gdigrab fallback)"
                                : "";
                    this.addLog(
                        "bridge",
                        `Retrying with ${plan.encoderId}${captureNote}${plan.audio ? "" : " (no audio)"}…`
                    );
                }

                this.proxy = proxy;
                this.plan = plan;
                this.warnings = [...plan.warnings];
                this.addLog("bridge", plan.description);
                this.writeLog(`command: ${formatCommand(plan)}`);

                const failure = await this.spawnAttempt(plan);
                if (!failure) {
                    this.startedAt = Date.now();
                    this.addLog("bridge", "Publisher started.");
                    this.writeLog(`=== publisher started encoder=${plan.encoderId}`);
                    return { ok: true, state: this.state() };
                }

                failures.push(failure);
                this.addLog("bridge", `Attempt failed: ${failure}`);

                await this.cleanupAttempt();

                // The portal capture owns a user-facing window picker. Re-running
                // fallback attempts would pop that picker again, so stop here.
                if (plan.capture?.label === "system portal") break attemptLoop;

                // A crashed or killed publisher can leave a session behind on
                // Broadcast Box until its peer connection times out. A fresh
                // attempt then fails with "session already has a host"; wait a
                // moment and try the same settings again.
                if (isHostConflict(failure) && conflictRetries < 2) {
                    conflictRetries++;
                    this.addLog(
                        "bridge",
                        "Broadcast Box still owns the previous session; waiting 2s before retrying…"
                    );
                    await delay(2_000);
                    continue;
                }

                if (isFatal(failure)) break attemptLoop;
                break;
            }
        }

        this.error = summarizeFailure(failures);
        this.writeLog(`=== start failed: ${this.error}`);
        this.resetProcessState();
        return { ok: false, error: this.error, state: this.state() };
    }

    private spawnAttempt(plan: PublishPlan): Promise<string | null> {
        const generation = ++this.generation;
        this.stopRequested = false;
        this.captureError = null;
        this.error = null;

        return new Promise<string | null>(resolve => {
            let settled = false;
            let startupFailure: string | null = null;

            const settle = (failure: string | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(failure);
            };

            const fail = (message: string) => {
                startupFailure ??= message;
                settle(message);
            };

            const timer = setTimeout(() => {
                if (plan.waitForCaptureStart) {
                    fail(
                        "The system window picker did not provide video. " +
                            "Pick a window within two minutes, or try Screen capture instead."
                    );
                } else {
                    settle(null);
                }
            }, plan.waitForCaptureStart ? PORTAL_START_TIMEOUT_MS : STARTUP_GRACE_MS);

            try {
                if (plan.tempDir) {
                    mkdirSync(plan.tempDir, { recursive: true, mode: 0o700 });
                    for (const fifo of plan.fifos) {
                        rmSync(fifo, { force: true });
                        execFileSync("mkfifo", [fifo], { stdio: "ignore" });
                    }
                }
            } catch (error) {
                fail(`Could not prepare application audio: ${errorMessage(error)}`);
                return;
            }

            let capture: ChildProcess | null = null;
            if (plan.capture) {
                try {
                    capture = spawn(plan.capture.cmd, plan.capture.args, {
                        stdio: ["ignore", "pipe", "pipe"],
                        windowsHide: true
                    });
                } catch (error) {
                    fail(`Could not start ${plan.capture.label}: ${errorMessage(error)}`);
                    return;
                }
                this.capture = capture;
                capture.stderr?.on("data", chunk => this.addLog(plan.capture!.label, chunk));
                capture.on("error", error => {
                    if (generation !== this.generation) return;
                    fail(`Could not start ${plan.capture!.label}: ${error.message}`);
                });
                capture.on("exit", (code, signal) => {
                    if (generation !== this.generation) return;
                    if (this.stopRequested) return;
                    this.captureError = `${plan.capture!.label} stopped (${code ?? signal ?? "unknown"}).`;
                    this.addLog("bridge", this.captureError);
                    if (plan.waitForCaptureStart && !settled) {
                        fail(this.captureError);
                        return;
                    }
                    // The capture process owns the video stream. If it exits after
                    // startup (portal session closed, window gone, PipeWire error),
                    // stop FFmpeg so the UI does not keep showing a frozen stream.
                    if (settled) this.encoder?.kill("SIGINT");
                });
            }

            let encoder: ChildProcess;
            for (const spec of plan.audioCaptures) {
                let audio: ChildProcess;
                try {
                    audio = spawn(spec.cmd, spec.args, {
                        stdio: ["ignore", "ignore", "pipe"],
                        windowsHide: true
                    });
                } catch (error) {
                    fail(`Could not start ${spec.label}: ${errorMessage(error)}`);
                    return;
                }
                this.audioCaptures.push(audio);
                audio.stderr?.on("data", chunk => this.addLog(spec.label, chunk));
                audio.on("error", error => {
                    if (generation !== this.generation) return;
                    fail(`Could not start ${spec.label}: ${error.message}`);
                });
                audio.on("exit", (code, signal) => {
                    if (generation !== this.generation) return;
                    if (this.stopRequested) return;
                    const message = `${spec.label} stopped (${code ?? signal ?? "unknown"}).`;
                    this.addLog("bridge", message);
                    if (!settled) fail(message);
                });
            }

            try {
                encoder = spawn(plan.encoder.cmd, plan.encoder.args, {
                    stdio: ["pipe", "pipe", "pipe"],
                    windowsHide: true
                });
            } catch (error) {
                capture?.kill("SIGKILL");
                fail(`Could not start FFmpeg: ${errorMessage(error)}`);
                return;
            }
            this.encoder = encoder;

            if (capture?.stdout && encoder.stdin) {
                if (plan.waitForCaptureStart) {
                    capture.stdout.once("data", () => {
                        if (!settled) settle(null);
                    });
                }
                capture.stdout.pipe(encoder.stdin);
                capture.stdout.on("error", () => undefined);
                encoder.stdin.on("error", () => undefined);
            }

            encoder.stderr?.on("data", chunk => this.addLog("ffmpeg", chunk));
            encoder.stdout?.on("data", chunk => this.handleProgress(chunk));

            encoder.on("error", error => {
                if (generation !== this.generation) return;
                fail(`Could not start FFmpeg: ${error.message}`);
            });

            encoder.on("exit", (code, signal) => {
                if (generation !== this.generation) return;
                const failure = startupFailure ?? this.captureError ?? describeExit(code, signal, this.logs);
                this.handleEncoderExit(failure);
                fail(failure);
            });
        });
    }

    private handleEncoderExit(failure: string) {
        const wasStopping = this.stopRequested;
        this.encoder = null;
        this.startedAt = 0;

        if (!wasStopping) {
            this.error = failure;
        }

        const capture = this.capture;
        this.capture = null;
        if (capture && capture.exitCode === null) {
            try {
                capture.kill("SIGKILL");
            } catch {
                // ignored
            }
        }

        for (const audio of this.audioCaptures) {
            if (audio.exitCode === null) {
                try {
                    audio.kill("SIGKILL");
                } catch {
                    // ignored
                }
            }
        }
        this.audioCaptures = [];
        this.removeTempDir();
    }

    private async cleanupAttempt(): Promise<void> {
        this.generation++;
        await this.terminateProcesses();
        this.removeTempDir();
        const proxy = this.proxy;
        this.proxy = null;
        if (proxy) await proxy.close().catch(() => undefined);
        this.plan = null;
    }

    private resetProcessState() {
        this.encoder = null;
        this.capture = null;
        this.audioCaptures = [];
        this.plan = null;
        this.startedAt = 0;
        this.stats = {};
        this.progressBuffer = "";
    }

    private removeTempDir() {
        const dir = this.plan?.tempDir;
        if (!dir) return;
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // Best effort.
        }
    }

    private async terminateProcesses(): Promise<void> {
        const encoder = this.encoder;
        const capture = this.capture;
        const audioCaptures = this.audioCaptures;
        this.audioCaptures = [];

        if (encoder && encoder.exitCode === null) {
            await terminate(encoder, process.platform === "win32" ? "SIGTERM" : "SIGINT", 2_000);
        }
        if (capture && capture.exitCode === null) {
            await terminate(capture, "SIGINT", 1_000);
        }
        for (const audio of audioCaptures) {
            if (audio.exitCode === null) await terminate(audio, "SIGINT", 1_000);
        }
    }

    // ---- logging / progress -------------------------------------------------

    private prepareLogFile() {
        try {
            mkdirSync(dirname(this.logPath), { recursive: true, mode: 0o700 });
            if (existsSync(this.logPath) && statSync(this.logPath).size > MAX_LOG_BYTES) {
                renameSync(this.logPath, `${this.logPath}.1`);
            }
        } catch {
            // Logging must never prevent publishing.
        }
    }

    private writeLog(line: string) {
        try {
            appendFileSync(this.logPath, `[${new Date().toISOString()}] ${sanitizeLogLine(line)}\n`);
        } catch {
            // Logging must never prevent publishing.
        }
    }

    private addLog(source: string, chunk: Buffer | string) {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
            if (!line.trim()) continue;
            this.logs.push(`[${source}] ${line}`);
            this.writeLog(`[${source}] ${line}`);
        }
        if (this.logs.length > MAX_LOG_LINES) {
            this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
        }
    }

    private handleProgress(chunk: Buffer) {
        this.progressBuffer += chunk.toString("utf8");
        const lines = this.progressBuffer.split(/\r?\n/);
        this.progressBuffer = lines.pop() ?? "";

        for (const line of lines) {
            const separator = line.indexOf("=");
            if (separator <= 0) continue;
            const key = line.slice(0, separator).trim();
            const value = line.slice(separator + 1).trim();
            switch (key) {
                case "frame":
                    this.stats.frame = Number(value) || 0;
                    break;
                case "fps":
                    this.stats.fps = Number(value) || 0;
                    break;
                case "bitrate": {
                    const numeric = Number.parseFloat(value);
                    if (Number.isFinite(numeric)) this.stats.bitrateKbps = Math.round(numeric);
                    break;
                }
                case "dup_frames":
                    this.stats.duplicated = Number(value) || 0;
                    break;
                case "drop_frames":
                    this.stats.dropped = Number(value) || 0;
                    break;
                case "speed": {
                    const numeric = Number.parseFloat(value.replace("x", ""));
                    if (Number.isFinite(numeric)) this.stats.speed = numeric;
                    break;
                }
                default:
                    break;
            }
        }
    }
}

function buildAttempts(config: BBConfig, capabilities: Awaited<ReturnType<typeof detectCapabilities>>): Attempt[] {
    const attempts: Attempt[] = [];
    const add = (
        encoderId: BBConfig["encoder"],
        audio: BBConfig["audio"],
        windowsCapture: WindowsCaptureMode = "auto"
    ) => {
        if (
            attempts.some(
                attempt =>
                    attempt.encoderId === encoderId &&
                    attempt.audio === audio &&
                    attempt.windowsCapture === windowsCapture
            )
        ) {
            return;
        }
        attempts.push({
            encoderId: encoderId as PublishPlan["encoderId"],
            audio,
            windowsCapture,
            warnings: []
        });
    };

    add(config.encoder, config.audio);
    const amfPrimary =
        config.encoder === "amf" ||
        (config.encoder === "auto" && capabilities.recommendedEncoder === "amf");
    if (capabilities.platform === "win32" && capabilities.capture.amfCapture && amfPrimary) {
        // If the zero-copy AMF capture filter cannot initialise on this driver,
        // retry the same encoder through ddagrab (which does a CPU copy) before
        // falling back to software encoding.
        add("amf", config.audio, "ddagrab");
    }
    if (config.audio !== "none") add(config.encoder, "none");
    if (config.encoder === "auto") {
        add("x264", config.audio);
        if (config.audio !== "none") add("x264", "none");
    }
    return attempts;
}

function isFatal(failure: string): boolean {
    // Retrying a Wayland portal failure would reopen the system picker and
    // interrupt the user; let them start again from the share sheet instead.
    if (/system portal|window selection was cancelled|xdg-desktop-portal/i.test(failure)) return true;
    // AMF capture/filter failures should fall through to the ddagrab attempt.
    if (/vsrc_amf|vpp_amf|AMF|hardware device context/i.test(failure)) return false;
    return /HTTP (4\d\d)|401|403|not found|unreachable/i.test(failure);
}

function isHostConflict(failure: string): boolean {
    return /session already has a host/i.test(failure);
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function summarizeFailure(failures: string[]): string {
    if (!failures.length) return "The publisher could not start.";
    const unique = [...new Set(failures.map(item => item.trim()).filter(Boolean))];
    const primary = unique[0] ?? "The publisher could not start.";
    if (unique.length === 1) return primary;
    return `${primary}\n\nFallback attempts also failed:\n${unique.slice(1).map(item => `• ${item}`).join("\n")}`;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null, logs: string[]): string {
    const tail = logs
        .slice(-10)
        .map(line => line.replace(/^\[[^\]]+\]\s*/, ""))
        .filter(Boolean)
        .join("\n");
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    return `FFmpeg stopped (${reason}).${tail ? `\n${tail}` : ""}`;
}

function formatCommand(plan: PublishPlan): string {
    const parts: string[] = [];
    if (plan.capture) parts.push(`${plan.capture.cmd} ${plan.capture.args.join(" ")}`);
    for (const capture of plan.audioCaptures) {
        parts.push(`${capture.cmd} ${capture.args.join(" ")}`);
    }
    parts.push(`${plan.encoder.cmd} ${plan.encoder.args.join(" ")}`);
    return parts.join("  |  ").replace(/\/whip\/[A-Za-z0-9_-]+/, "/whip/<key>");
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function terminate(child: ChildProcess, signal: NodeJS.Signals, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null) return Promise.resolve();

    return new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch {
                // ignored
            }
            finish();
        }, timeoutMs);

        child.once("exit", finish);
        try {
            child.kill(signal);
        } catch {
            finish();
        }
    });
}
