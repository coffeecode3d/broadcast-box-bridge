/*
 * BetterDiscord native adapter.
 *
 * BetterDiscord's renderer sandbox does not expose Node's child_process
 * module. This adapter never imports it. Instead it writes a small helper
 * bundle to a temporary directory, starts it as a separate Node process using
 * Discord's own Electron binary with ELECTRON_RUN_AS_NODE=1, and exchanges
 * commands/results through JSON files.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { shell } from "electron";

import type { BBConfig, Capabilities, PublishState, StartResult } from "../core/types";
import { HELPER_SOURCE, HELPER_VERSION } from "./helperSource";

const IS_WINDOWS = process.platform === "win32";

function rootDir(): string {
    if (IS_WINDOWS) {
        return join(process.env.TEMP || process.env.LOCALAPPDATA || ".", "BroadcastBoxBridge");
    }
    return join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || "/tmp", "BroadcastBoxBridge");
}

const baseDir = rootDir();
const commandsDir = join(baseDir, "commands");
const resultsDir = join(baseDir, "results");
const helperFile = join(baseDir, "helper.cjs");
const stateFile = join(baseDir, "state.json");
const versionFile = join(baseDir, "version");
const launcherFile = join(baseDir, IS_WINDOWS ? "launch.vbs" : "launch.sh");

let filesReady = false;
let helperUpdated = false;
let commandQueue: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function read(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}

/**
 * Find a real Node.js executable. Discord ships with Electron's RunAsNode
 * fuse disabled, so the Discord binary cannot be used as a Node runtime.
 */
function findNode(): string | null {
    const candidates: string[] = [];
    const env = process.env;
    if (env.BROADCASTBOX_NODE) candidates.push(env.BROADCASTBOX_NODE);

    const pluginsFolder = (globalThis as { BdApi?: { Plugins?: { folder?: string } } }).BdApi?.Plugins?.folder;
    if (pluginsFolder) {
        candidates.push(join(pluginsFolder, "BroadcastBoxBridge", IS_WINDOWS ? "node.exe" : "node"));
        candidates.push(join(pluginsFolder, IS_WINDOWS ? "node.exe" : "node"));
    }

    if (IS_WINDOWS) {
        const programFiles = env.ProgramFiles || "C:\\Program Files";
        const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
        const localAppData = env.LOCALAPPDATA || "";
        candidates.push(join(programFiles, "nodejs", "node.exe"));
        candidates.push(join(programFilesX86, "nodejs", "node.exe"));
        if (localAppData) candidates.push(join(localAppData, "Programs", "nodejs", "node.exe"));
        if (env.APPDATA) candidates.push(join(env.APPDATA, "npm", "node.exe"));
    } else {
        candidates.push("/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node");
    }

    const separator = IS_WINDOWS ? ";" : ":";
    for (const directory of (env.PATH || "").split(separator)) {
        if (directory) candidates.push(join(directory, IS_WINDOWS ? "node.exe" : "node"));
    }

    for (const candidate of candidates) {
        if (candidate && existsSync(candidate)) return candidate;
    }
    return null;
}

function ensureFiles() {
    if (filesReady) return;
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(commandsDir, { recursive: true });
    mkdirSync(resultsDir, { recursive: true });

    const versionChanged = read(versionFile) !== HELPER_VERSION;
    if (versionChanged || !existsSync(helperFile)) {
        const node = findNode();
        if (!node) {
            throw new Error(
                "BetterDiscord needs Node.js to run the publishing helper. Install Node.js LTS " +
                    "from nodejs.org (or place node.exe next to the plugin) and restart Discord."
            );
        }
        writeFileSync(helperFile, HELPER_SOURCE);
        if (IS_WINDOWS) {
            const cmdFile = join(baseDir, "launch.cmd");
            writeFileSync(
                cmdFile,
                [
                    "@echo off",
                    `cd /d "${baseDir}"`,
                    `"${node}" "${helperFile}" "${baseDir}"`,
                    ""
                ].join("\r\n")
            );
            writeFileSync(
                launcherFile,
                [
                    'Set sh = CreateObject("WScript.Shell")',
                    `sh.Run "cmd /c ""${cmdFile}""", 0, False`,
                    ""
                ].join("\r\n")
            );
        } else {
            writeFileSync(
                launcherFile,
                [
                    "#!/bin/sh",
                    `exec "${node}" "${helperFile}" "${baseDir}"`,
                    ""
                ].join("\n")
            );
            try {
                chmodSync(launcherFile, 0o755);
            } catch {
                // Some BetterDiscord fs wrappers do not expose chmodSync.
            }
        }
        writeFileSync(versionFile, HELPER_VERSION);
        helperUpdated = versionChanged;
    }
    filesReady = true;
}

function spawnDetached(node: string) {
    const binding = (process as unknown as { binding?: (name: string) => unknown }).binding;
    if (typeof binding !== "function") {
        throw new Error("process.binding is not available");
    }
    const { spawn } = binding("spawn_sync") as {
        spawn(options: {
            file: string;
            args: string[];
            cwd: string;
            envPairs: string[];
            stdio: Array<{ type: "pipe"; readable: boolean; writable: boolean }>;
        }): { status: number; output?: Array<Buffer | null> };
    };
    const envPairs = Object.entries(process.env)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => `${key}=${value}`);
    const stdio = [
        { type: "pipe" as const, readable: true, writable: false },
        { type: "pipe" as const, readable: false, writable: true },
        { type: "pipe" as const, readable: false, writable: true }
    ];

    const result = IS_WINDOWS
        ? spawn({
              file: process.env.ComSpec || "cmd.exe",
              args: [
                  process.env.ComSpec || "cmd.exe",
                  "/d",
                  "/s",
                  "/c",
                  `start "" /b "${node}" "${helperFile}" "${baseDir}"`
              ],
              cwd: baseDir,
              envPairs,
              stdio
          })
        : spawn({
              file: "/bin/sh",
              args: [
                  "/bin/sh",
                  "-c",
                  `nohup "${node}" "${helperFile}" "${baseDir}" >/dev/null 2>&1 &`
              ],
              cwd: baseDir,
              envPairs,
              stdio
          });

    if (result.status !== 0) {
        const stderr = result.output?.[2]?.toString() ?? "";
        throw new Error(stderr.trim() || `process launcher exited with ${result.status}`);
    }
}

async function launchHelper() {
    ensureFiles();
    const node = findNode();
    if (!node) {
        throw new Error(
            "BetterDiscord needs Node.js to run the publishing helper. Install Node.js LTS " +
                "from nodejs.org (or place node.exe next to the plugin) and restart Discord."
        );
    }

    try {
        spawnDetached(node);
        return;
    } catch (spawnError) {
        try {
            const error = await shell.openPath(launcherFile);
            if (error) throw new Error(error);
        } catch (error) {
            throw new Error(
                `Could not start the Broadcast Box helper: ${
                    error instanceof Error ? error.message : String(error)
                }. Direct spawn: ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`
            );
        }
    }
}

async function sendRaw(
    op: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 30_000,
    allowLaunch = true
): Promise<unknown> {
    ensureFiles();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const commandFile = join(commandsDir, `cmd-${id}.json`);
    const resultFile = join(resultsDir, `res-${id}.json`);
    writeFileSync(commandFile, JSON.stringify({ id, op, payload }));

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const raw = read(resultFile);
        if (raw) {
            try {
                const result = JSON.parse(raw) as { id?: string; ok?: boolean; data?: unknown; error?: string };
                if (result.id === id) {
                    if (result.ok) return result.data;
                    throw new Error(result.error || "Broadcast Box helper failed");
                }
            } catch (error) {
                if (error instanceof SyntaxError) {
                    // The helper may still be writing the file.
                } else {
                    throw error;
                }
            }
        }
        await sleep(100);
    }
    throw new Error(
        `Broadcast Box helper did not respond to ${op}. Check ${join(baseDir, "helper.log")} for details.`
    );
}

async function ensureHelper() {
    // A detached helper from a previous plugin version may still be running
    // after Discord restarts. It would keep answering with the old command
    // implementation, so retire it before starting the new helper.
    if (helperUpdated) {
        helperUpdated = false;
        const alive = await sendRaw("ping", {}, 800, false).then(() => true, () => false);
        if (alive) {
            await sendRaw("shutdown", {}, 1_500, false).catch(() => undefined);
            const deadline = Date.now() + 2_500;
            while (Date.now() < deadline) {
                if (!(await sendRaw("ping", {}, 400, false).then(() => true, () => false))) break;
                await sleep(100);
            }
        }
    }
    if (await sendRaw("ping", {}, 1_500, false).then(() => true, () => false)) return;
    await launchHelper();
    const started = Date.now();
    while (Date.now() - started < 20_000) {
        if (await sendRaw("ping", {}, 1_500, false).then(() => true, () => false)) return;
        await sleep(250);
    }
    throw new Error(
        `The Broadcast Box helper did not start. Check ${join(baseDir, "helper.log")} for details.`
    );
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = commandQueue.then(task, task);
    commandQueue = next.then(
        () => undefined,
        () => undefined
    );
    return next;
}

export function detect(force = false): Promise<Capabilities> {
    return enqueue(async () => {
        await ensureHelper();
        return (await sendRaw("detect", { force }, 40_000, false)) as Capabilities;
    });
}

export function start(options: { config: BBConfig; key: string }): Promise<StartResult> {
    return enqueue(async () => {
        await ensureHelper();
        return (await sendRaw(
            "start",
            options as unknown as Record<string, unknown>,
            40_000,
            false
        )) as StartResult;
    });
}

export function stop(): Promise<{ ok: boolean; error?: string }> {
    return enqueue(async () => {
        await ensureHelper();
        return (await sendRaw("stop", {}, 20_000, false)) as { ok: boolean; error?: string };
    });
}

export async function state(): Promise<PublishState> {
    const raw = read(stateFile);
    if (!raw) {
        return { running: false, warnings: [], logs: [], error: null };
    }
    try {
        return JSON.parse(raw) as PublishState;
    } catch {
        return { running: false, warnings: [], logs: [], error: null };
    }
}
