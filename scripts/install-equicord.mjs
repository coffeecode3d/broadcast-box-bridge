#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Automated Equicord installer for Broadcast Box Bridge.
 *
 * Equicord plugins are compiled into the Equicord bundle; there is no runtime
 * plugin-folder loader. This script handles the clone/copy/build/inject steps
 * so users do not have to run them by hand.
 */

import { cpSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const bundledPluginDir = join(scriptDir, "broadcastBoxBridge");
const pluginName = "broadcastBoxBridge";
const pluginFiles = ["index.ts", "native.ts", "host.ts", "LICENSE", "THIRD_PARTY_NOTICES.md"];
const pluginDirs = ["core", "node"];

const options = parseArgs(process.argv.slice(2));

if (options.help) {
    usage();
    process.exit(0);
}

const source = resolveSource();

if (options.dryRun) console.log("[install] dry run: no files will be written and no commands will run.");

main().catch(error => {
    console.error(`\n[install] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});

async function main() {
    console.log("Broadcast Box Bridge - Equicord installer");
    console.log(`Plugin source: ${source.dir}`);

    ensurePrerequisites();

    const equicordDir = resolve(
        options.equicord || process.env.EQUICORD_DIR || join(homedir(), "Equicord")
    );
    const equicordPackage = join(equicordDir, "package.json");
    const equicordSource = join(equicordDir, "src");

    if (existsSync(equicordDir) && (!existsSync(equicordPackage) || !existsSync(equicordSource))) {
        throw new Error(
            `${equicordDir} exists but does not look like an Equicord source checkout. ` +
            "Pass --equicord /path/to/Equicord or remove that directory."
        );
    }

    if (!existsSync(equicordDir)) {
        const shouldClone = await confirm(
            `No Equicord checkout was found at ${equicordDir}. Clone Equicord there?`
        );
        if (!shouldClone) {
            console.log("Aborted. Nothing was changed.");
            return;
        }
        console.log(`[install] cloning Equicord into ${equicordDir}`);
        await run("git", ["clone", "--depth", "1", "https://github.com/Equicord/Equicord.git", equicordDir], undefined, {
            shell: false
        });
    } else if (options.update) {
        console.log("[install] updating the Equicord checkout");
        await run("git", ["-C", equicordDir, "pull", "--ff-only"], undefined, { shell: false });
    } else {
        console.log(`[install] using existing Equicord checkout: ${equicordDir}`);
    }

    const destination = join(equicordDir, "src", "userplugins", pluginName);

    if (existsSync(destination)) {
        if (!options.force) {
            const shouldReplace = await confirm(
                `${destination} already exists. Replace it with this version?`
            );
            if (!shouldReplace) {
                console.log("Aborted. Nothing was changed.");
                return;
            }
        }

        if (!options.dryRun) {
            const suffix = new Date().toISOString().replace(/[:.]/g, "-");
            const backupDir = join(equicordDir, ".bb-bridge-backups");
            const backup = join(backupDir, `${pluginName}-${suffix}`);
            mkdirSync(backupDir, { recursive: true });
            renameSync(destination, backup);
            console.log(`[install] backed up the existing plugin to ${backup}`);
        }
    }

    console.log(`[install] copying plugin -> ${destination}`);
    if (!options.dryRun) {
        mkdirSync(destination, { recursive: true });
        copyPlugin(source, destination);
    }

    console.log("[install] installing Equicord dependencies");
    try {
        await run("pnpm", ["install", "--frozen-lockfile"], equicordDir);
    } catch {
        console.warn("[install] frozen install failed; retrying with a normal pnpm install");
        await run("pnpm", ["install"], equicordDir);
    }

    console.log("[install] building Equicord (this can take a few minutes)");
    await run("pnpm", ["build"], equicordDir);

    if (!options.noInject) {
        console.log("[install] injecting the built Equicord");
        await run("pnpm", ["inject", "--install"], equicordDir);
    }

    console.log("\n[install] Done.");
    console.log("[install] Start Discord and enable BroadcastBoxBridge in Settings > Equicord > Plugins.");
    console.log("[install] Set your own Broadcast Box URL in Advanced before sharing.");
    console.log("[install] Re-run this script after an Equicord or Discord update.");
}

function parseArgs(argv) {
    const parsed = {
        equicord: "",
        yes: false,
        force: false,
        update: false,
        dryRun: false,
        noInject: false,
        help: false
    };

    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];

        if (argument === "--help" || argument === "-h") {
            parsed.help = true;
        } else if (argument === "--yes" || argument === "-y") {
            parsed.yes = true;
        } else if (argument === "--force") {
            parsed.force = true;
        } else if (argument === "--update") {
            parsed.update = true;
        } else if (argument === "--dry-run") {
            parsed.dryRun = true;
        } else if (argument === "--no-inject") {
            parsed.noInject = true;
        } else if (argument === "--equicord") {
            const value = argv[++index];
            if (!value) throw new Error("--equicord needs a directory");
            parsed.equicord = value;
        } else if (argument.startsWith("--equicord=")) {
            parsed.equicord = argument.slice("--equicord=".length);
        } else {
            throw new Error(`Unknown option: ${argument}\nRun with --help for usage.`);
        }
    }

    return parsed;
}

function usage() {
    console.log(`
Broadcast Box Bridge - Equicord installer

Usage:
  node install-equicord.mjs [options]

Options:
  --equicord <path>   Existing Equicord source checkout, or where to clone it
  --update            Run "git pull --ff-only" in an existing checkout
  --force             Replace an existing BroadcastBoxBridge userplugin
  --yes, -y           Answer yes to the clone/replace prompts
  --dry-run           Print what would happen without changing anything
  --no-inject         Build but skip "pnpm inject --install"
  --help, -h          Show this help

Defaults:
  EQUICORD_DIR is used if set; otherwise Equicord is looked up at ~/Equicord.

Requirements:
  Git, Node.js 20+, and pnpm on PATH.

What it does:
  1. Clones Equicord if needed.
  2. Copies the plugin into src/userplugins/broadcastBoxBridge.
  3. Runs pnpm install, pnpm build, and pnpm inject --install.

Close Discord before injecting. You may need to re-run this after a Discord
or Equicord update.
`);
}

function resolveSource() {
    if (existsSync(join(bundledPluginDir, "index.ts"))) {
        return { dir: bundledPluginDir, bundled: true };
    }

    if (existsSync(join(repoRoot, "index.ts"))) {
        return { dir: repoRoot, bundled: false };
    }

    throw new Error(
        "Could not find the plugin source. Run this script from the repository, " +
        "or from an extracted BroadcastBoxBridge-Equicord.zip."
    );
}

function ensurePrerequisites() {
    const major = Number(process.versions.node.split(".")[0]);
    if (!Number.isFinite(major) || major < 20) {
        throw new Error(`Node.js 20 or newer is required (found ${process.versions.node}).`);
    }

    if (!hasCommand("git", ["--version"], false)) {
        throw new Error("Git is required. Install Git and make sure it is on PATH.");
    }

    if (!hasCommand("pnpm", ["--version"], process.platform === "win32")) {
        throw new Error(
            "pnpm is required. Install it with 'corepack enable' or 'npm install -g pnpm'."
        );
    }
}

function hasCommand(command, args, shell) {
    const result = spawnSync(command, args, { stdio: "ignore", shell });
    return result.status === 0;
}

function copyPlugin(from, to) {
    for (const file of pluginFiles) {
        const sourceFile = join(from.dir, file);
        if (existsSync(sourceFile)) cpSync(sourceFile, join(to, file));
    }

    for (const directory of pluginDirs) {
        const sourceDirectory = join(from.dir, directory);
        if (!existsSync(sourceDirectory)) {
            throw new Error(`Plugin source is missing ${sourceDirectory}.`);
        }
        cpSync(sourceDirectory, join(to, directory), { recursive: true });
    }
}

function run(command, args, cwd, runOptions = {}) {
    const shell = runOptions.shell ?? (process.platform === "win32" && command === "pnpm");
    const printable = `${command} ${args.join(" ")}${cwd ? `  (cwd: ${cwd})` : ""}`;

    if (options.dryRun) {
        console.log(`[dry-run] ${printable}`);
        return Promise.resolve();
    }

    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
            cwd,
            stdio: "inherit",
            shell
        });

        child.once("error", error => {
            reject(new Error(`Could not start ${command}: ${error.message}`));
        });

        child.once("exit", (code, signal) => {
            if (code === 0) {
                resolvePromise();
                return;
            }

            reject(new Error(`${command} failed (${signal ? `signal ${signal}` : `exit code ${code}`}).`));
        });
    });
}

async function confirm(question) {
    if (options.yes) return true;

    if (!process.stdin.isTTY) {
        throw new Error(`${question} Run again with --yes for a non-interactive install.`);
    }

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = (await readline.question(`${question} [y/N] `)).trim().toLowerCase();
        return answer === "y" || answer === "yes";
    } finally {
        readline.close();
    }
}
