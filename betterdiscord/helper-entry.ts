/*
 * BetterDiscord process helper.
 *
 * BetterDiscord's renderer `require` does not expose Node's child_process
 * module, so the BetterDiscord plugin cannot spawn FFmpeg directly. This file
 * is bundled into a standalone CommonJS script and run in a separate Node
 * process (Discord's Electron binary with ELECTRON_RUN_AS_NODE=1). The plugin
 * talks to it through tiny JSON files in a temporary directory.
 */

import {
    appendFileSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync
} from "fs";
import { join } from "path";

import { detect, start, state, stop } from "../node/runtime";

const dir = process.argv[2] || process.cwd();
const commandsDir = join(dir, "commands");
const resultsDir = join(dir, "results");
const stateFile = join(dir, "state.json");
const logFile = join(dir, "helper.log");

mkdirSync(commandsDir, { recursive: true });
mkdirSync(resultsDir, { recursive: true });

function log(message: string) {
    try {
        appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
        // ignore
    }
}

function writeJson(path: string, value: unknown) {
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, path);
}

async function writeState() {
    try {
        const current = await state();
        writeJson(stateFile, current);
        // Keep the helper alive while it owns a running publisher. Idle
        // helpers still exit after a long period without commands.
        if (current.running) lastCommandAt = Date.now();
    } catch (error) {
        log(`state failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

let busy = false;
let lastCommandAt = Date.now();

async function processCommands() {
    if (busy) return;
    const files = readdirSync(commandsDir)
        .filter(file => file.startsWith("cmd-") && file.endsWith(".json"))
        .sort();
    if (files.length === 0) return;

    busy = true;
    try {
        for (const file of files) {
            const commandPath = join(commandsDir, file);
            let command: { id?: string; op?: string; payload?: Record<string, unknown> };
            try {
                command = JSON.parse(readFileSync(commandPath, "utf8"));
            } catch (error) {
                log(`bad command ${file}: ${error instanceof Error ? error.message : String(error)}`);
                try {
                    unlinkSync(commandPath);
                } catch {
                    // ignore
                }
                continue;
            }

            const id = command.id ?? file;
            lastCommandAt = Date.now();
            try {
                let data: unknown;
                switch (command.op) {
                    case "detect":
                        data = await detect(command.payload?.force === true);
                        break;
                    case "start":
                        data = await start(command.payload as never);
                        break;
                    case "stop":
                        data = await stop();
                        break;
                    case "state":
                        data = await state();
                        break;
                    case "ping":
                        data = { ok: true, pid: process.pid };
                        break;
                    case "shutdown":
                        writeJson(join(resultsDir, `res-${id}.json`), { id, ok: true, data: { ok: true } });
                        log("shutdown requested");
                        try {
                            await stop();
                        } catch {
                            // ignore
                        }
                        setTimeout(() => process.exit(0), 100);
                        return;
                    default:
                        throw new Error(`Unknown helper operation: ${command.op ?? "(none)"}`);
                }
                writeJson(join(resultsDir, `res-${id}.json`), { id, ok: true, data });
                log(`${command.op} ok`);
                await writeState();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                writeJson(join(resultsDir, `res-${id}.json`), { id, ok: false, error: message });
                log(`${command.op} failed: ${message}`);
            } finally {
                try {
                    unlinkSync(commandPath);
                } catch {
                    // ignore
                }
            }
        }
    } finally {
        busy = false;
    }
}

writeFileSync(join(dir, "helper.pid"), String(process.pid));
log(`helper started pid=${process.pid}`);
void writeState();

setInterval(() => void processCommands(), 100);
setInterval(() => void writeState(), 500);
setInterval(() => {
    // Do not leave an idle helper running forever after Discord has stopped
    // using it. An active publisher keeps the helper alive.
    if (!busy && Date.now() - lastCommandAt > 30 * 60_000) {
        log("idle timeout");
        process.exit(0);
    }
}, 60_000);
