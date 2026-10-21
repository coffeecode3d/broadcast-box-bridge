import { tmpdir } from "os";
import { join } from "path";
import { effectiveBitrateKbps, evenSize, parseRegion, resolutionSize } from "../core/config";
import type { AudioMode, BBConfig, Capabilities, EncoderId, WindowInfo } from "../core/types";
import { portalCaptureCommand } from "./portalCapture";

export interface SpawnSpec {
    cmd: string;
    args: string[];
    label: string;
}

export type WindowsCaptureMode = "auto" | "amf" | "ddagrab";

export interface PublishPlan {
    /** Optional capture process whose stdout is piped into `encoder`. */
    capture: SpawnSpec | null;
    encoder: SpawnSpec;
    piped: boolean;
    /** wf-recorder encodes H.264 itself; FFmpeg only remuxes it into WHIP. */
    videoPassthrough: boolean;
    /** Wait for the first capture bytes before reporting startup success. */
    waitForCaptureStart?: boolean;
    /** Extra capture processes (per-application PipeWire audio). */
    audioCaptures: SpawnSpec[];
    /** Named pipes that must exist before the audio captures spawn. */
    fifos: string[];
    /** Temporary directory to remove after the attempt. */
    tempDir: string | null;
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number;
    encoderId: Exclude<EncoderId, "auto">;
    audio: boolean;
    audioMode: AudioMode;
    warnings: string[];
    description: string;
    proxyUrl: string;
    /** Windows only: how the desktop frames were captured. */
    windowsCapture?: "amf" | "ddagrab" | "gdigrab";
}

type ConcreteEncoder = Exclude<EncoderId, "auto">;

interface ResolvedAudio {
    enabled: boolean;
    mode: AudioMode;
    inputArgs: string[];
    captures: SpawnSpec[];
    fifos: string[];
    tempDir: string | null;
    filter: string | null;
    map: string;
}

const VAAPI_PREFERENCE: ConcreteEncoder[] = ["vaapi", "nvenc", "qsv", "x264"];

export function resolveEncoder(config: BBConfig, capabilities: Capabilities): {
    encoder: ConcreteEncoder;
    warning?: string;
} {
    const available = capabilities.availableEncoders;
    if (!available.length) {
        throw new Error("No H.264 encoder is available in this FFmpeg installation.");
    }

    if (config.encoder !== "auto") {
        if (available.includes(config.encoder)) return { encoder: config.encoder };
        const fallback = capabilities.recommendedEncoder ?? available[0];
        return {
            encoder: fallback,
            warning: `${config.encoder} is not available; using ${fallback} instead.`
        };
    }

    const preferred =
        capabilities.platform === "win32"
            ? (["nvenc", "qsv", "amf", "x264"] as ConcreteEncoder[])
            : VAAPI_PREFERENCE;

    return {
        encoder: preferred.find(encoder => available.includes(encoder)) ?? available[0]
    };
}

export function buildPlan(
    config: BBConfig,
    capabilities: Capabilities,
    key: string,
    proxyBaseUrl: string,
    options: { windowsCapture?: WindowsCaptureMode } = {}
): PublishPlan {
    if (!capabilities.ffmpeg) throw new Error("FFmpeg was not found in PATH.");

    const warnings: string[] = [];
    const { encoder, warning } = resolveEncoder(config, capabilities);
    if (warning) warnings.push(warning);

    const { width, height } = resolutionSize(config, capabilities);
    const fps = config.fps;
    const bitrateKbps = effectiveBitrateKbps(config, capabilities);
    const proxyUrl = `${proxyBaseUrl}/whip/${encodeURIComponent(key)}`;
    const sessionType = capabilities.sessionType;

    const audio = resolveAudio(config, capabilities, warnings);

    const commonOutput = buildOutputArgs(
        config,
        encoder,
        capabilities,
        width,
        height,
        fps,
        bitrateKbps,
        audio,
        proxyUrl,
        false
    );

    let capture: SpawnSpec | null = null;
    let encoderArgs: string[];
    let piped = false;
    let videoPassthrough = false;
    let waitForCaptureStart = false;
    let windowsCapture: "amf" | "ddagrab" | "gdigrab" | undefined;

    const useVaapiPassthrough =
        process.platform === "linux" &&
        sessionType === "wayland" &&
        capabilities.capture.wfRecorder &&
        encoder === "vaapi" &&
        Boolean(capabilities.vaapiDevice);

    const portalWindow =
        process.platform === "linux" &&
        sessionType === "wayland" &&
        config.capture === "window" &&
        capabilities.capture.windowMethod === "wayland-portal";

    if (portalWindow) {
        // The portal helper owns the window picker and the PipeWire stream, and
        // emits H.264 MPEG-TS. Unlike a wf-recorder region, this stream follows
        // the selected window when the compositor moves or resizes it.
        const portal = portalCaptureCommand(width, height, fps, bitrateKbps, encoder === "x264");
        capture = {
            cmd: portal.cmd,
            args: portal.args,
            label: "system portal"
        };
        encoderArgs = [
            ...ffmpegPrelude(encoder, capabilities, true),
            "-f",
            "mpegts",
            "-i",
            "pipe:0",
            ...(audio.enabled ? audio.inputArgs : []),
            ...buildOutputArgs(
                config,
                encoder,
                capabilities,
                width,
                height,
                fps,
                bitrateKbps,
                audio,
                proxyUrl,
                true
            )
        ];
        piped = true;
        videoPassthrough = true;
        waitForCaptureStart = true;
    } else if (useVaapiPassthrough) {
        const monitor = config.monitor || capabilities.displays[0]?.name || "";
        const selected = config.capture === "window" ? selectedWindow(config, capabilities) : null;
        if (config.capture === "window" && !selected) {
            warnings.push("The selected window is no longer open; capturing the whole screen instead.");
        }
        const region = selected ? windowRegion(selected) : config.region ? parseRegion(config.region) : null;
        const display = capabilities.displays.find(item => item.name === monitor) ?? capabilities.displays[0];
        const sourceWidth = region?.width ?? display?.width ?? width;
        const sourceHeight = region?.height ?? display?.height ?? height;
        const fitted = fitEven(sourceWidth, sourceHeight, width, height);
        const geometryArgs = selected ? windowGeometryArgs(selected) : config.region ? ["-g", normalizeRegion(config.region)] : [];
        // Let wf-recorder encode from its DMA-BUF frames. The VAAPI filter graph
        // keeps scaling and format conversion on the GPU, so no raw frames ever
        // travel through the CPU. FFmpeg then only remuxes the resulting H.264
        // into WHIP. Keep the filter to a single VAAPI scale: wf-recorder adds
        // an auto_scale + fps stage after it, and hardware-frame outputs from
        // pad_vaapi cannot be converted back to software there.
        const filters = `scale_vaapi=w=${fitted.width}:h=${fitted.height}:format=nv12:out_range=tv`;

        capture = {
            cmd: "wf-recorder",
            label: "wf-recorder",
            args: [
                "-y",
                "-D",
                // Window/region mode passes global coordinates; wf-recorder
                // detects the containing output itself. An explicit -o would
                // conflict when the window is on a different monitor.
                ...(selected || config.region ? [] : monitor ? ["-o", monitor] : []),
                ...geometryArgs,
                "-c",
                "h264_vaapi",
                "-d",
                capabilities.vaapiDevice || "/dev/dri/renderD128",
                "-r",
                String(fps),
                "-p",
                "rc_mode=CBR",
                "-p",
                "profile=high",
                "-p",
                "color_range=tv",
                "-p",
                "colorspace=bt709",
                "-p",
                "color_primaries=bt709",
                "-p",
                "color_trc=bt709",
                "-p",
                `b=${bitrateKbps}k`,
                "-p",
                `g=${Math.max(1, Math.round(fps * 2))}`,
                "-b",
                "0",
                "-F",
                filters,
                "-m",
                "mpegts",
                "-f",
                "pipe:1"
            ]
        };

        encoderArgs = [
            ...ffmpegPrelude(encoder, capabilities, true),
            "-f",
            "mpegts",
            "-i",
            "pipe:0",
            ...(audio.enabled ? audio.inputArgs : []),
            ...buildOutputArgs(
                config,
                encoder,
                capabilities,
                width,
                height,
                fps,
                bitrateKbps,
                audio,
                proxyUrl,
                true
            )
        ];
        piped = true;
        videoPassthrough = true;
    } else if (process.platform === "linux" && sessionType === "wayland" && capabilities.capture.wfRecorder) {
        const monitor = config.monitor || capabilities.displays[0]?.name || "";
        const selected = config.capture === "window" ? selectedWindow(config, capabilities) : null;
        if (config.capture === "window" && !selected) {
            warnings.push("The selected window is no longer open; capturing the whole screen instead.");
        }
        const geometryArgs = selected ? windowGeometryArgs(selected) : config.region ? ["-g", normalizeRegion(config.region)] : [];
        const filters = [
            `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
            `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
            `fps=${fps}`,
            "format=nv12"
        ].join(",");

        capture = {
            cmd: "wf-recorder",
            label: "wf-recorder",
            args: [
                "-y",
                "-D",
                ...(selected || config.region ? [] : monitor ? ["-o", monitor] : []),
                ...geometryArgs,
                "-c",
                "rawvideo",
                "-x",
                "nv12",
                "-F",
                filters,
                "-f",
                // Node spawns children with a socketpair as fd 1, so reopening
                // /dev/stdout fails with ENXIO. FFmpeg's pipe:1 writes to the
                // descriptor directly and works with any stdio type.
                "pipe:1",
                "-m",
                "rawvideo"
            ]
        };
        encoderArgs = [
            ...ffmpegPrelude(encoder, capabilities),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "nv12",
            "-s",
            `${width}x${height}`,
            "-r",
            String(fps),
            "-i",
            "pipe:0",
            ...(audio.enabled ? audio.inputArgs : []),
            ...videoFilterArgs(encoder, "piped", width, height, fps),
            ...commonOutput
        ];
        piped = true;
    } else if (process.platform === "win32") {
        const useAmf =
            encoder === "amf" &&
            capabilities.capture.amfCapture &&
            options.windowsCapture !== "ddagrab";
        const captureSource = buildWindowsCapture(config, capabilities, width, height, fps, warnings, useAmf);
        windowsCapture = captureSource.mode;
        encoderArgs = [
            ...ffmpegPrelude(encoder, capabilities),
            ...captureSource.inputArgs,
            ...(audio.enabled ? audio.inputArgs : []),
            ...(captureSource.videoFilter
                ? ["-vf", captureSource.videoFilter]
                : videoFilterArgs(encoder, "direct", width, height, fps)),
            ...commonOutput
        ];
    } else if (process.platform === "linux") {
        const captureSource = buildX11Capture(config, capabilities, width, height, fps, warnings);
        encoderArgs = [
            ...ffmpegPrelude(encoder, capabilities),
            ...captureSource.inputArgs,
            ...(audio.enabled ? audio.inputArgs : []),
            ...videoFilterArgs(encoder, "direct", width, height, fps),
            ...commonOutput
        ];
    } else {
        throw new Error(`Publishing is not supported on ${process.platform}.`);
    }

    if (config.region && config.capture !== "window" && !["wayland", "x11"].includes(sessionType)) {
        warnings.push("Capture regions are ignored on this platform.");
    }
    if (config.region && config.capture === "window") {
        warnings.push("Capture regions are ignored in window mode; the window itself defines the capture area.");
    }

    const encoderSpec: SpawnSpec = {
        cmd: "ffmpeg",
        label: "ffmpeg",
        args: encoderArgs
    };

    const sourceLabel = capture
        ? `${capture.label}${config.capture === "window" ? " (window)" : ""}`
        : windowsCapture === "amf"
          ? "AMF screen capture"
          : windowsCapture === "ddagrab"
            ? "ddagrab"
            : windowsCapture === "gdigrab"
              ? config.capture === "window"
                  ? "gdigrab (window)"
                  : "gdigrab"
              : sessionType === "windows"
                ? "desktop"
                : "screen";
    const description = `${sourceLabel} -> ${encoder} · ${width}x${height}@${fps} · ${bitrateKbps} kbps`;

    return {
        capture,
        encoder: encoderSpec,
        piped,
        videoPassthrough,
        waitForCaptureStart,
        audioCaptures: audio.captures,
        fifos: audio.fifos,
        tempDir: audio.tempDir,
        width,
        height,
        fps,
        bitrateKbps,
        encoderId: encoder,
        audio: audio.enabled,
        audioMode: audio.mode,
        warnings,
        description,
        proxyUrl,
        windowsCapture
    };
}

function ffmpegPrelude(
    encoder: ConcreteEncoder,
    capabilities: Capabilities,
    passthrough = false
): string[] {
    const args = ["-hide_banner", "-loglevel", "info", "-nostats", "-progress", "pipe:1"];
    if (encoder === "vaapi" && !passthrough) {
        const device = capabilities.vaapiDevice || "/dev/dri/renderD128";
        // Binding the filter graph's hardware device explicitly makes encoder
        // initialisation independent of when the first captured frame arrives.
        args.push("-init_hw_device", `vaapi=va:${device}`, "-filter_hw_device", "va");
    }
    return args;
}

function buildOutputArgs(
    config: BBConfig,
    encoder: ConcreteEncoder,
    capabilities: Capabilities,
    width: number,
    height: number,
    fps: number,
    bitrateKbps: number,
    audio: ResolvedAudio,
    proxyUrl: string,
    passthrough = false
): string[] {
    const gop = Math.max(1, Math.round(fps * 2));
    const bitrate = `${bitrateKbps}k`;
    const maxrate = `${bitrateKbps}k`;
    const bufsize = `${Math.round(bitrateKbps * 2)}k`;

    const args: string[] = [];
    if (audio.filter) args.push("-filter_complex", audio.filter);
    args.push("-map", "0:v:0");
    if (audio.enabled) args.push("-map", audio.map);

    if (passthrough) {
        args.push("-c:v", "copy");
    } else {
        switch (encoder) {
        case "vaapi":
            args.push(
                "-c:v", "h264_vaapi",
                "-profile:v", "high",
                "-bf", "0",
                "-g", String(gop),
                "-b:v", bitrate,
                "-maxrate", maxrate,
                "-bufsize", bufsize
            );
            break;
        case "nvenc":
            args.push(
                "-c:v", "h264_nvenc",
                "-preset", "p5",
                "-tune", "ll",
                "-profile:v", "high",
                "-rc", "cbr",
                "-bf", "0",
                "-rc-lookahead", "0",
                "-g", String(gop),
                "-b:v", bitrate,
                "-maxrate", maxrate,
                "-bufsize", bufsize
            );
            break;
        case "qsv":
            args.push(
                "-c:v", "h264_qsv",
                "-preset", "medium",
                "-profile:v", "high",
                "-bf", "0",
                "-g", String(gop),
                "-b:v", bitrate,
                "-maxrate", maxrate,
                "-bufsize", bufsize
            );
            break;
        case "amf":
            args.push(
                "-c:v", "h264_amf",
                "-usage", "lowlatency",
                "-quality", "quality",
                "-profile:v", "high",
                "-rc", "cbr",
                "-bf", "0",
                "-async_depth", "1",
                "-g", String(gop),
                "-b:v", bitrate,
                "-maxrate", maxrate,
                "-bufsize", bufsize
            );
            break;
        case "x264":
        default:
            args.push(
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-tune", "zerolatency",
                "-profile:v", "high",
                "-pix_fmt", "yuv420p",
                "-bf", "0",
                "-g", String(gop),
                "-b:v", bitrate,
                "-maxrate", maxrate,
                "-bufsize", bufsize
            );
            break;
        }
        // Keep the stream tagged as limited-range BT.709 so players do not
        // expand the range or guess the matrix (which makes dark games washed
        // out). The Linux wf-recorder path already tags this itself.
        args.push(
            "-color_range", "tv",
            "-colorspace", "bt709",
            "-color_primaries", "bt709",
            "-color_trc", "bt709"
        );
    }

    if (audio.enabled) {
        if (!audio.filter) args.push("-af", "aresample=async=1:first_pts=0");
        args.push("-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2");
    }

    // New FFmpeg builds need a larger UDP send buffer for 1080p60, but older
    // Windows builds reject the option outright. Detect support at capability
    // time instead of assuming every WHIP muxer exposes it.
    if (capabilities.whipTsBuffer) {
        args.push("-ts_buffer_size", "8388608");
    }
    args.push(
        "-pkt_size", "1200",
        "-f", "whip",
        proxyUrl
    );

    void config;
    void width;
    void height;
    return args;
}

function videoFilterArgs(
    encoder: ConcreteEncoder,
    mode: "piped" | "direct",
    width: number,
    height: number,
    fps: number
): string[] {
    const scaleDirect = [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
    ].join(",");

    if (encoder === "vaapi") {
        return mode === "piped"
            ? ["-vf", "format=nv12,hwupload"]
            : ["-vf", `${scaleDirect},format=nv12,hwupload`];
    }

    if (encoder === "x264") {
        return mode === "piped"
            ? ["-vf", "format=yuv420p"]
            : ["-vf", `${scaleDirect},format=yuv420p`];
    }

    return mode === "piped" ? [] : ["-vf", `${scaleDirect},format=nv12`];
}

function resolveAudio(
    config: BBConfig,
    capabilities: Capabilities,
    warnings: string[]
): ResolvedAudio {
    const none = (mode: AudioMode = config.audio): ResolvedAudio => ({
        enabled: false,
        mode,
        inputArgs: [],
        captures: [],
        fifos: [],
        tempDir: null,
        filter: null,
        map: "1:a:0"
    });

    if (config.audio === "none") return none("none");

    if (capabilities.platform === "linux") {
        const captureNodes = (
            nodes: Array<{ id: number; name: string }>,
            label: string,
            mode: AudioMode
        ): ResolvedAudio => {
            if (!nodes.length) {
                warnings.push(`${label} is not producing audio right now; publishing without audio.`);
                return none(mode);
            }

            const tempDir = join(
                tmpdir(),
                `bb-bridge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            );
            const captures: SpawnSpec[] = [];
            const fifos: string[] = [];
            const inputArgs: string[] = [];

            nodes.forEach((node, index) => {
                const fifo = join(tempDir, `app-${index}.pcm`);
                fifos.push(fifo);
                captures.push({
                    cmd: "pw-record",
                    label: `pw-record (${label})`,
                    args: [
                        "--target",
                        String(node.id),
                        "--raw",
                        "--latency",
                        "20ms",
                        "--rate",
                        "48000",
                        "--channels",
                        "2",
                        fifo
                    ]
                });
                inputArgs.push(
                    "-use_wallclock_as_timestamps",
                    "1",
                    "-f",
                    "s16le",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-i",
                    fifo
                );
            });

            const single = nodes.length === 1;
            const filter = single
                ? null
                : `${nodes.map((_, index) => `[${index + 1}:a]`).join("")}amix=inputs=${nodes.length}:normalize=0,aresample=async=1:first_pts=0[aout]`;

            return {
                enabled: true,
                mode,
                inputArgs,
                captures,
                fifos,
                tempDir,
                filter,
                map: single ? "1:a:0" : "[aout]"
            };
        };

        if (config.audio === "app") {
            const app = capabilities.audio.apps.find(item => item.id === config.audioApp);
            if (!app) {
                warnings.push(
                    config.audioApp
                        ? `"${config.audioApp}" is not playing audio right now; publishing without audio. Pick the application again from the share dialog.`
                        : "Choose an application for application audio; publishing without audio."
                );
                return none("app");
            }
            return captureNodes(app.nodes, app.name, "app");
        }

        if (config.audio === "system" && config.audioExcludeDiscord) {
            const seen = new Set<number>();
            const nodes: Array<{ id: number; name: string }> = [];
            for (const app of capabilities.audio.apps) {
                for (const node of app.nodes) {
                    if (seen.has(node.id)) continue;
                    seen.add(node.id);
                    nodes.push(node);
                }
            }
            return captureNodes(nodes, "system audio excluding Discord", "system");
        }

        const device =
            config.audioDevice ||
            (config.audio === "system" ? capabilities.audio.monitor : capabilities.audio.mic);

        if (!device) {
            warnings.push(
                config.audio === "system"
                    ? "No default output monitor was found; publishing without audio."
                    : "No default microphone was found; publishing without audio."
            );
            return none();
        }

        return {
            enabled: true,
            mode: config.audio,
            inputArgs: ["-f", "pulse", "-i", device],
            captures: [],
            fifos: [],
            tempDir: null,
            filter: null,
            map: "1:a:0"
        };
    }

    if (capabilities.platform === "win32") {
        const device = config.audioDevice || capabilities.audio.devices[0] || "";
        if (!device) {
            warnings.push(
                config.audio === "app"
                    ? "Application audio on Windows needs a virtual audio cable. Install one, route the game to it, then select it in the share dialog."
                    : "No DirectShow audio device was found. Install a loopback/virtual cable or enter a device name in the plugin settings."
            );
            return none(config.audio);
        }
        return {
            enabled: true,
            mode: config.audio,
            inputArgs: ["-f", "dshow", "-i", `audio=${device}`],
            captures: [],
            fifos: [],
            tempDir: null,
            filter: null,
            map: "1:a:0"
        };
    }

    warnings.push("Audio capture is not supported on this platform.");
    return none();
}

function buildWindowsCapture(
    config: BBConfig,
    capabilities: Capabilities,
    width: number,
    height: number,
    fps: number,
    warnings: string[],
    useAmf: boolean
): { inputArgs: string[]; videoFilter?: string; mode: "amf" | "ddagrab" | "gdigrab" } {
    if (config.capture === "window") {
        const window = selectedWindow(config, capabilities);
        if (window) {
            return {
                inputArgs: [
                    "-f",
                    "gdigrab",
                    "-framerate",
                    String(fps),
                    "-draw_mouse",
                    "1",
                    "-i",
                    `title=${window.title}`
                ],
                mode: "gdigrab"
            };
        }
        warnings.push("The selected window is no longer open; capturing the desktop instead.");
    }

    const index = Math.max(
        0,
        capabilities.displays.findIndex(display => display.name === config.monitor)
    );

    if (useAmf && capabilities.capture.amfCapture) {
        const display = capabilities.displays[index] ?? capabilities.displays[0];
        const fitted = fitEven(display?.width ?? width, display?.height ?? height, width, height);
        // vsrc_amf hands AMF surfaces straight to vpp_amf and h264_amf. No
        // hwdownload and no CPU scale, so this is the AMD equivalent of OBS's
        // D3D11 -> AMF texture path.
        const filter = [
            `vpp_amf=w=${fitted.width}:h=${fitted.height}:format=nv12`,
            "color_profile=bt709",
            "in_color_range=full",
            "out_color_range=studio",
            "in_primaries=bt709",
            "out_primaries=bt709",
            "in_trc=bt709",
            "out_trc=bt709"
        ].join(":");
        return {
            inputArgs: [
                "-f",
                "lavfi",
                "-i",
                `vsrc_amf=monitor_index=${index}:framerate=${fps}`
            ],
            videoFilter: filter,
            mode: "amf"
        };
    }

    if (capabilities.capture.ddagrab) {
        const source = `ddagrab=output_idx=${index}:framerate=${fps}:draw_mouse=1,hwdownload,format=bgra`;
        return { inputArgs: ["-f", "lavfi", "-i", source], mode: "ddagrab" };
    }

    if (config.region) {
        warnings.push("Capture regions are ignored by the Windows gdigrab fallback.");
    }

    const screen = capabilities.displays[0];
    const captureSize = evenSize(screen?.width ?? width, screen?.height ?? height);
    return {
        inputArgs: [
            "-f", "gdigrab",
            "-framerate", String(fps),
            "-draw_mouse", "1",
            "-video_size", `${captureSize.width}x${captureSize.height}`,
            "-i", "desktop"
        ],
        mode: "gdigrab"
    };
}

function buildX11Capture(
    config: BBConfig,
    capabilities: Capabilities,
    width: number,
    height: number,
    fps: number,
    warnings: string[]
): { inputArgs: string[] } {
    const display = process.env.DISPLAY || ":0.0";
    const target = display.includes(".") ? display : `${display}.0`;

    if (config.capture === "window") {
        const window = selectedWindow(config, capabilities);
        const numeric = window ? (/^0x/i.test(window.id) ? Number.parseInt(window.id, 16) : Number(window.id)) : NaN;
        if (window && Number.isFinite(numeric) && numeric > 0) {
            return {
                inputArgs: [
                    "-f", "x11grab",
                    "-draw_mouse", "1",
                    "-framerate", String(fps),
                    "-window_id", String(numeric),
                    "-i", target
                ]
            };
        }
        warnings.push("The selected window is no longer open or has an invalid X11 id; capturing the screen instead.");
    }

    const region = config.region ? parseRegion(config.region) : null;

    if (config.region && !region) {
        warnings.push(`Could not parse region "${config.region}". Expected "x,y WxH".`);
    }

    const screen = capabilities.displays.find(item => item.name === config.monitor) ?? capabilities.displays[0];
    const captureWidth = region?.width ?? screen?.width ?? width;
    const captureHeight = region?.height ?? screen?.height ?? height;
    const x = region?.x ?? screen?.x ?? 0;
    const y = region?.y ?? screen?.y ?? 0;
    const size = evenSize(captureWidth, captureHeight);

    return {
        inputArgs: [
            "-f", "x11grab",
            "-draw_mouse", "1",
            "-framerate", String(fps),
            "-video_size", `${size.width}x${size.height}`,
            "-i", `${target}+${x},${y}`
        ]
    };
}

function selectedWindow(config: BBConfig, capabilities: Capabilities): WindowInfo | null {
    if (config.capture !== "window") return null;
    const windows = capabilities.windows ?? [];
    if (config.window) {
        const match = windows.find(window => window.id === config.window);
        if (match) return match;
    }
    return windows[0] ?? null;
}

function windowRegion(window: WindowInfo): { x: number; y: number; width: number; height: number } | null {
    if (!window.width || !window.height) return null;
    return {
        x: Math.round(window.x ?? 0),
        y: Math.round(window.y ?? 0),
        width: Math.round(window.width),
        height: Math.round(window.height)
    };
}

function windowGeometryArgs(window: WindowInfo): string[] {
    const region = windowRegion(window);
    if (!region) return [];
    return ["-g", `${region.x},${region.y} ${region.width}x${region.height}`];
}

function normalizeRegion(region: string): string {
    const parsed = parseRegion(region);
    if (!parsed) return region;
    return `${parsed.x},${parsed.y} ${parsed.width}x${parsed.height}`;
}

/** Fit a source inside the target box without stretching, rounded to even pixels. */
function fitEven(
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number
): { width: number; height: number } {
    if (sourceWidth <= 0 || sourceHeight <= 0) return evenSize(targetWidth, targetHeight);
    const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
    return evenSize(sourceWidth * scale, sourceHeight * scale);
}
