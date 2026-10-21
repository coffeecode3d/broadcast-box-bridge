/*
 * Standalone diagnostics for Broadcast Box Bridge.
 *
 * Run through scripts/doctor.mjs, which bundles this file first.
 *
 *   pnpm doctor
 *   pnpm doctor --plan
 *   pnpm doctor --publish --seconds 20
 *   pnpm doctor --publish --server https://live.example.com --key doctor-test
 */

import type { BBConfig, Capabilities } from "../core/types";
import { fetchStatus } from "../core/bb";
import { DEFAULT_CONFIG, normalizeConfig, resolutionSize } from "../core/config";
import { detectCapabilities } from "../node/capabilities";
import { buildPlan } from "../node/commands";
import { Publisher } from "../node/publisher";

interface Args {
    json: boolean;
    plan: boolean;
    publish: boolean;
    help: boolean;
    server?: string;
    key?: string;
    resolution?: string;
    fps?: number;
    encoder?: string;
    audio?: string;
    audioApp?: string;
    monitor?: string;
    capture?: string;
    window?: string;
    seconds: number;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { json: false, plan: false, publish: false, help: false, seconds: 0 };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const next = () => argv[++index];
        switch (arg) {
            case "--":
                break;
            case "--json":
                args.json = true;
                break;
            case "--plan":
                args.plan = true;
                break;
            case "--publish":
                args.publish = true;
                break;
            case "--help":
            case "-h":
                args.help = true;
                break;
            case "--server":
                args.server = next();
                break;
            case "--key":
                args.key = next();
                break;
            case "--resolution":
                args.resolution = next();
                break;
            case "--fps":
                args.fps = Number(next());
                break;
            case "--encoder":
                args.encoder = next();
                break;
            case "--audio":
                args.audio = next();
                break;
            case "--audio-app":
                args.audioApp = next();
                break;
            case "--monitor":
                args.monitor = next();
                break;
            case "--capture":
                args.capture = next();
                break;
            case "--window":
                args.window = next();
                break;
            case "--seconds":
                args.seconds = Number(next());
                break;
            default:
                console.warn(`Unknown option: ${arg}`);
        }
    }
    return args;
}

function printHelp() {
    console.log(`Broadcast Box Bridge doctor

Usage:
  pnpm doctor [options]

Options:
  --json                 Machine readable capabilities
  --plan                 Print the ffmpeg / wf-recorder commands without running them
  --publish              Actually publish a test stream
  --seconds <n>          Keep the test stream running for n seconds (0 = stop once live)
  --server <url>         Broadcast Box base URL (default: ${DEFAULT_CONFIG.server})
  --key <key>            Stream key (default: doctor-<timestamp>)
  --resolution <preset>  native | 720p | 1080p | 1440p | 2160p
  --fps <n>              30 | 60 | 120
  --encoder <id>         auto | vaapi | nvenc | qsv | amf | x264
  --audio <mode>         none | mic | system | app
  --audio-app <id>       Application id for --audio app (see app list)
  --monitor <name>       Wayland output name (for example DP-2)
  --capture <mode>       screen | window
  --window <id>          Window id from the JSON/Windows list (X11/Windows only)
  --help                 Show this help

The publish test captures your real screen or a selected window. On Wayland,
window mode opens the xdg-desktop-portal picker; screen mode uses wf-recorder
without a portal dialog.
`);
}

function printCapabilities(capabilities: Capabilities) {
    const yes = (value: boolean) => (value ? "yes" : "no");
    console.log("Broadcast Box Bridge diagnostics");
    console.log("────────────────────────────────");
    console.log(`Platform        : ${capabilities.platform} (${capabilities.sessionType})`);
    console.log(`FFmpeg          : ${capabilities.ffmpegVersion ?? "not found"}`);
    console.log(`Recommended     : ${capabilities.recommendedEncoder ?? "none"}`);
    console.log(`Available       : ${capabilities.availableEncoders.join(", ") || "none"}`);
    console.log(`VAAPI device    : ${capabilities.vaapiDevice ?? "none"}`);
    console.log(
        `Capture         : wf-recorder=${yes(capabilities.capture.wfRecorder)} x11grab=${yes(
            capabilities.capture.x11grab
        )} ddagrab=${yes(capabilities.capture.ddagrab)} gdigrab=${yes(
            capabilities.capture.gdigrab
        )} amf-capture=${yes(capabilities.capture.amfCapture)} window=${yes(
            capabilities.capture.window
        )} (${capabilities.capture.windowMethod ?? "unavailable"})`
    );
    console.log(
        `Displays        : ${
            capabilities.displays.map(display => `${display.name} ${display.width}x${display.height}`).join(", ") ||
            "none detected"
        }`
    );
    console.log(
        `Windows         : ${
            capabilities.capture.windowMethod === "wayland-portal"
                ? "system picker opens when sharing starts"
                : (capabilities.windows ?? [])
                      .map(window => `${window.app || "window"} · ${window.title} [${window.id}]`)
                      .join(", ") || "none detected"
        }`
    );
    console.log(`Microphone      : ${capabilities.audio.mic ?? "none"}`);
    console.log(`System audio    : ${capabilities.audio.monitor ?? "none"}`);
    console.log(
        `Applications    : ${
            capabilities.audio.apps.map(app => `${app.name} [${app.id}]`).join(", ") || "none playing"
        }`
    );
    if (capabilities.warnings.length) {
        console.log("Warnings:");
        for (const warning of capabilities.warnings) console.log(`  • ${warning}`);
    }
}

function buildConfig(args: Args): BBConfig {
    return normalizeConfig({
        ...DEFAULT_CONFIG,
        ...(args.server ? { server: args.server } : {}),
        ...(args.resolution ? { resolution: args.resolution as BBConfig["resolution"] } : {}),
        ...(args.fps ? { fps: args.fps } : {}),
        ...(args.encoder ? { encoder: args.encoder as BBConfig["encoder"] } : {}),
        ...(args.audio ? { audio: args.audio as BBConfig["audio"] } : {}),
        ...(args.audioApp ? { audioApp: args.audioApp } : {}),
        ...(args.monitor ? { monitor: args.monitor } : {}),
        ...(args.capture ? { capture: args.capture as BBConfig["capture"] } : {}),
        ...(args.window ? { window: args.window } : {})
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }

    const capabilities = await detectCapabilities(true);
    if (args.json) {
        console.log(JSON.stringify(capabilities, null, 2));
    } else {
        printCapabilities(capabilities);
    }

    const config = buildConfig(args);
    const key = args.key || `doctor-${Date.now().toString(36)}`;

    if (args.plan) {
        console.log("\nPlan");
        console.log("────");
        const size = resolutionSize(config, capabilities);
        console.log(`Target   : ${size.width}x${size.height} @ ${config.fps} fps`);
        console.log(`Server   : ${config.server}`);
        console.log(`Key      : ${key}`);
        try {
            const plan = buildPlan(config, capabilities, key, "http://127.0.0.1:<proxy>");
            if (plan.capture) {
                console.log(`\n[capture]\n${plan.capture.cmd} ${plan.capture.args.join(" ")}`);
                console.log("\n          | stdout -> stdin\n");
            }
            console.log(`[encoder]\n${plan.encoder.cmd} ${plan.encoder.args.join(" ")}`);
            if (plan.warnings.length) {
                console.log("\nWarnings:");
                for (const warning of plan.warnings) console.log(`  • ${warning}`);
            }
        } catch (error) {
            console.error(`\nCannot build a plan: ${error instanceof Error ? error.message : error}`);
            process.exitCode = 1;
        }
        return;
    }

    if (!args.publish) return;

    if (!config.server) {
        console.error("A Broadcast Box server is required. Pass --server https://your-broadcast-box.example.");
        process.exit(1);
    }

    console.log("\nPublish test");
    console.log("────────────");
    console.log(`Server : ${config.server}`);
    console.log(`Key    : ${key}`);

    const publisher = new Publisher();
    const stop = async () => {
        console.log("\nStopping…");
        const result = await publisher.stop();
        if (!result.ok) console.error(result.error);
        process.exit(0);
    };
    process.once("SIGINT", () => void stop());

    const started = await publisher.start(config, key);
    if (!started.ok) {
        console.error(`\nFailed to start: ${started.error}`);
        if (started.state?.logs?.length) {
            console.error("\nLog tail:");
            console.error(started.state.logs.slice(-60).join("\n"));
        }
        process.exitCode = 1;
        return;
    }

    console.log(`Encoder: ${started.state?.encoder}`);
    if (started.state?.logs?.length) console.log(started.state.logs.join("\n"));
    const deadline = Date.now() + 20_000;
    let live = false;
    let printedLogs = started.state?.logs?.length ?? 0;

    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const state = publisher.state();
        const logs = state.logs.slice(printedLogs);
        if (logs.length) {
            console.log(logs.join("\n"));
            printedLogs = state.logs.length;
        }
        if (state.stats && state.stats.frame != null) {
            console.log(
                `  frames=${state.stats.frame} fps=${state.stats.fps ?? 0} bitrate=${
                    state.stats.bitrateKbps ?? 0
                }kbps`
            );
        }
        try {
            const status = await fetchStatus(config.server, key);
            if (status?.isOnline) {
                console.log(`Broadcast Box reports the stream as LIVE (viewers: ${status.viewers}).`);
                live = true;
                break;
            }
        } catch (error) {
            console.log(`Status check failed: ${error instanceof Error ? error.message : error}`);
        }
        if (!state.running) {
            console.error(`Publisher stopped early: ${state.error ?? "unknown error"}`);
            break;
        }
    }

    if (!live && publisher.state().running) {
        console.warn("Broadcast Box did not report the stream as live within 20 seconds.");
        console.warn("Check the log tail below and the server's own logs.");
    }

    if (args.seconds > 0) {
        console.log(`Keeping the stream alive for ${args.seconds}s…`);
        const until = Date.now() + args.seconds * 1_000;
        while (Date.now() < until) {
            await new Promise(resolve => setTimeout(resolve, 1_000));
            const state = publisher.state();
            const logs = state.logs.slice(printedLogs);
            if (logs.length) {
                console.log(logs.join("\n"));
                printedLogs = state.logs.length;
            }
            if (state.stats?.frame != null) {
                console.log(
                    `  frames=${state.stats.frame} fps=${state.stats.fps ?? 0} bitrate=${
                        state.stats.bitrateKbps ?? 0
                    }kbps`
                );
            }
        }
    } else {
        await new Promise(resolve => setTimeout(resolve, 2_000));
    }

    const logs = publisher.state().logs.slice(-25);
    await publisher.stop();
    if (logs.length && !live) {
        console.log("\nLog tail:");
        console.log(logs.join("\n"));
    }
    console.log("Stopped.");
}

void main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
});
