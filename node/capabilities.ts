import { execFile } from "child_process";
import { existsSync } from "fs";
import type {
    AudioAppInfo,
    AudioDeviceInfo,
    Capabilities,
    CaptureSupport,
    DisplayInfo,
    EncoderId,
    WindowInfo
} from "../core/types";

interface RunResult {
    ok: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
}

function run(command: string, args: string[], timeoutMs = 6_000): Promise<RunResult> {
    return new Promise(resolve => {
        execFile(
            command,
            args,
            { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
            (error, stdout, stderr) => {
                resolve({
                    ok: !error,
                    code: error ? (typeof (error as { code?: number }).code === "number" ? (error as { code: number }).code : null) : 0,
                    stdout: stdout || "",
                    stderr: stderr || ""
                });
            }
        );
    });
}

let cached: Capabilities | null = null;
let cachedAt = 0;

export async function detectCapabilities(force = false): Promise<Capabilities> {
    if (!force && cached && Date.now() - cachedAt < 30_000) return cached;

    const platform = process.platform;
    const sessionType = detectSessionType();
    const warnings: string[] = [];

    const ffmpegVersion = await run("ffmpeg", ["-hide_banner", "-version"]);
    const ffmpeg = ffmpegVersion.ok;
    if (!ffmpeg) warnings.push("FFmpeg was not found in PATH. Install ffmpeg to publish.");

    const encoderList = ffmpeg ? await run("ffmpeg", ["-hide_banner", "-encoders"]) : null;
    const encoders = encoderList?.ok ? parseEncoders(encoderList.stdout) : [];

    const devices = ffmpeg ? await run("ffmpeg", ["-hide_banner", "-devices"]) : null;
    const deviceText = devices?.ok ? devices.stdout : "";

    const filters = ffmpeg ? await run("ffmpeg", ["-hide_banner", "-filters"]) : null;
    const filterText = filters?.ok ? filters.stdout : "";

    // `ts_buffer_size` was added to the WHIP muxer after the muxer itself.
    // New FFmpeg builds need it for a stable UDP send buffer; older Windows
    // builds abort with "Unrecognized option" if it is present.
    const whipHelp = ffmpeg ? await run("ffmpeg", ["-hide_banner", "-h", "muxer=whip"]) : null;
    const whipTsBuffer = Boolean(
        whipHelp?.ok && /ts_buffer_size/i.test(`${whipHelp.stdout}\n${whipHelp.stderr}`)
    );

    const wfRecorder = platform === "linux" && (await run("wf-recorder", ["-L"], 4_000)).ok;
    const amfCapture =
        platform === "win32" && /\bvsrc_amf\b/i.test(filterText) && /\bvpp_amf\b/i.test(filterText);
    const x11grab = platform === "linux" && /x11grab/i.test(deviceText);
    const ddagrab = platform === "win32" && /ddagrab/i.test(filterText);
    const gdigrab = platform === "win32" && /gdigrab/i.test(deviceText);
    // Wayland window capture must go through the portal so the compositor can
    // hand us a live PipeWire stream. Cropping a rectangle captured earlier is
    // not equivalent and breaks as soon as the window moves or resizes.
    const portal =
        platform === "linux" && sessionType === "wayland" && (await hasPortalSupport());
    const windowMethod: CaptureSupport["windowMethod"] =
        platform === "win32" && gdigrab
            ? "gdigrab"
            : platform === "linux" && sessionType === "x11" && x11grab
              ? "x11"
              : portal
                ? "wayland-portal"
                : undefined;
    const capture: CaptureSupport = {
        wfRecorder,
        x11grab,
        ddagrab,
        gdigrab,
        amfCapture,
        window: Boolean(windowMethod),
        windowMethod
    };

    const vaapiDevice = platform === "linux" ? findVaapiDevice() : null;

    const availableEncoders: Array<Exclude<EncoderId, "auto">> = [];
    if (platform !== "win32" && vaapiDevice && encoders.includes("h264_vaapi")) availableEncoders.push("vaapi");
    if (encoders.includes("h264_nvenc")) availableEncoders.push("nvenc");
    if (encoders.includes("h264_qsv")) availableEncoders.push("qsv");
    if (platform === "win32" && encoders.includes("h264_amf")) availableEncoders.push("amf");
    if (encoders.includes("libx264")) availableEncoders.push("x264");

    const gpuVendor = platform === "win32" ? await detectGpuVendor() : null;
    const windowsPreference: Array<Exclude<EncoderId, "auto">> =
        gpuVendor === "amd"
            ? ["amf", "qsv", "nvenc", "x264"]
            : gpuVendor === "intel"
              ? ["qsv", "nvenc", "amf", "x264"]
              : ["nvenc", "qsv", "amf", "x264"];
    const preferred: Array<Exclude<EncoderId, "auto">> =
        platform === "win32" ? windowsPreference : ["vaapi", "nvenc", "qsv", "x264"];
    const recommendedEncoder = preferred.find(encoder => availableEncoders.includes(encoder)) ?? null;

    if (!availableEncoders.length) {
        warnings.push("No usable H.264 encoder was found. Install ffmpeg with VAAPI/NVENC or x264 support.");
    }

    if (platform === "linux") {
        if (sessionType === "wayland" && !wfRecorder) {
            warnings.push("wf-recorder is required to capture on Wayland. Install wf-recorder.");
        }
        if (sessionType === "wayland" && !portal) {
            warnings.push(
                "Wayland window capture needs xdg-desktop-portal, python-dbus, PyGObject and GStreamer PipeWire/VAAPI support. " +
                    "Screen capture still works; install those packages to enable the system window picker."
            );
        }
        if (sessionType === "x11" && !capture.x11grab) {
            warnings.push("FFmpeg was built without x11grab; screen capture is unavailable.");
        }
    } else if (platform === "win32") {
        if (!capture.ddagrab && !capture.gdigrab) {
            warnings.push("Neither ddagrab nor gdigrab is available in this FFmpeg build.");
        }
        if (availableEncoders.includes("amf") && !capture.amfCapture) {
            warnings.push(
                "AMD AMF encoding is available, but this FFmpeg build lacks the zero-copy vsrc_amf/vpp_amf screen capture filters. " +
                    "Streaming will fall back to ddagrab with a CPU frame copy. Use a recent full FFmpeg build for OBS-style AMD capture."
            );
        }
    } else {
        warnings.push("Publishing is supported on Linux and Windows only. Watching works everywhere.");
    }

    const displays = await detectDisplays(sessionType);
    const windows = await detectWindows(sessionType, platform, windowMethod);
    const audio = await detectAudio(sessionType, platform);

    if (platform === "linux" && !audio.mic) {
        warnings.push("No default microphone was found through PulseAudio/PipeWire.");
    }

    if (platform === "linux" && sessionType === "wayland" && vaapiDevice) {
        // wf-recorder + VAAPI is the validated path; NVENC also works but needs a
        // different capture handoff, so keep VAAPI first when available.
        if (!availableEncoders.includes("vaapi")) {
            warnings.push("VAAPI is present but this FFmpeg build lacks h264_vaapi.");
        }
    }

    const result: Capabilities = {
        platform,
        sessionType,
        ffmpeg,
        ffmpegVersion: ffmpeg ? ffmpegVersion.stdout.split("\n")[0].trim() : null,
        encoders,
        whipTsBuffer,
        capture,
        vaapiDevice,
        displays,
        windows,
        audio,
        recommendedEncoder,
        availableEncoders,
        warnings,
        checkedAt: Date.now()
    };

    cached = result;
    cachedAt = Date.now();
    return result;
}

export function detectSessionType(): string {
    if (process.platform === "win32") return "windows";
    if (process.platform === "darwin") return "macos";
    if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland") return "wayland";
    if (process.env.DISPLAY || process.env.XDG_SESSION_TYPE === "x11") return "x11";
    return "unknown";
}

function parseEncoders(output: string): string[] {
    const names: string[] = [];
    for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^\s*[VAS][.A-Z]{5}\s+(\S+)/);
        if (match) names.push(match[1]);
    }
    return names;
}

function findVaapiDevice(): string | null {
    if (!existsSync("/dev/dri")) return null;
    for (let index = 128; index <= 139; index++) {
        const path = `/dev/dri/renderD${index}`;
        if (existsSync(path)) return path;
    }
    return null;
}

async function detectWindowsDisplays(): Promise<DisplayInfo[]> {
    const script = [
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
        "Add-Type -AssemblyName System.Windows.Forms;",
        "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {",
        "  [pscustomobject]@{",
        "    name=$_.DeviceName;",
        "    width=$_.Bounds.Width;",
        "    height=$_.Bounds.Height;",
        "    x=$_.Bounds.X;",
        "    y=$_.Bounds.Y;",
        "    primary=$_.Primary",
        "  }",
        "} | ConvertTo-Json -Compress"
    ].join(" ");

    const result = await run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        5_000
    );
    if (!result.ok || !result.stdout.trim()) return [];

    try {
        const parsed = JSON.parse(result.stdout.replace(/\u0000/g, "").replace(/^\uFEFF/, "").trim()) as
            | Array<{ name?: string; width?: number; height?: number; x?: number; y?: number; primary?: boolean }>
            | { name?: string; width?: number; height?: number; x?: number; y?: number; primary?: boolean };
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows
            .filter(row => Number(row.width) > 0 && Number(row.height) > 0)
            .map(row => ({
                name: row.name || "DISPLAY",
                width: Math.round(Number(row.width)),
                height: Math.round(Number(row.height)),
                x: Number.isFinite(Number(row.x)) ? Math.round(Number(row.x)) : undefined,
                y: Number.isFinite(Number(row.y)) ? Math.round(Number(row.y)) : undefined,
                primary: Boolean(row.primary)
            }))
            .sort((a, b) => Number(b.primary) - Number(a.primary));
    } catch {
        return [];
    }
}

async function detectGpuVendor(): Promise<"amd" | "nvidia" | "intel" | null> {
    const result = await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join \"`n\""
    ]);
    if (!result.ok) return null;
    const text = result.stdout;
    // Prefer a discrete GPU when a laptop reports both an iGPU and a dGPU.
    if (/AMD|Radeon|Advanced Micro Devices/i.test(text)) return "amd";
    if (/NVIDIA/i.test(text)) return "nvidia";
    if (/Intel/i.test(text)) return "intel";
    return null;
}

async function detectDisplays(sessionType: string): Promise<DisplayInfo[]> {
    if (process.platform === "win32") {
        const displays = await detectWindowsDisplays();
        if (displays.length) return displays;
    }

    if (process.platform === "linux" && sessionType === "wayland" && (await hasCommand("hyprctl"))) {
        const monitors = await run("hyprctl", ["monitors", "-j"], 4_000);
        if (monitors.ok) {
            try {
                const parsed = JSON.parse(monitors.stdout) as Array<{
                    name: string;
                    width: number;
                    height: number;
                    refreshRate?: number;
                    x?: number;
                    y?: number;
                }>;
                if (Array.isArray(parsed) && parsed.length) {
                    return parsed
                        .filter(monitor => monitor.width && monitor.height)
                        .map(monitor => ({
                            name: monitor.name,
                            width: Math.round(monitor.width),
                            height: Math.round(monitor.height),
                            refreshHz: monitor.refreshRate,
                            x: monitor.x,
                            y: monitor.y
                        }));
                }
            } catch {
                // fall through to other backends
            }
        }
    }

    if (process.platform === "linux" && sessionType === "wayland" && (await hasCommand("wlr-randr"))) {
        const randr = await run("wlr-randr", ["--json"], 4_000);
        if (randr.ok) {
            try {
                const parsed = JSON.parse(randr.stdout) as Array<{
                    name: string;
                    enabled?: boolean;
                    modes?: Array<{ width: number; height: number; refresh?: number; current?: boolean }>;
                    position?: { x: number; y: number };
                }>;
                const displays = parsed
                    .filter(output => output.enabled !== false)
                    .map((output): DisplayInfo | null => {
                        const mode = output.modes?.find(item => item.current) ?? output.modes?.[0];
                        if (!mode) return null;
                        return {
                            name: output.name,
                            width: mode.width,
                            height: mode.height,
                            refreshHz: mode.refresh,
                            x: output.position?.x,
                            y: output.position?.y
                        };
                    })
                    .filter((display): display is DisplayInfo => display !== null);
                if (displays.length) return displays;
            } catch {
                // fall through
            }
        }
    }

    if (process.platform === "linux" && (await hasCommand("xrandr"))) {
        const randr = await run("xrandr", ["--query"], 4_000);
        if (randr.ok) {
            const displays: DisplayInfo[] = [];
            for (const line of randr.stdout.split(/\r?\n/)) {
                const match = line.match(/^(\S+) connected(?: primary)?(?: \d+x\d+\+\d+\+\d+)?\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
                if (match) {
                    displays.push({
                        name: match[1],
                        width: Number(match[2]),
                        height: Number(match[3]),
                        x: Number(match[4]),
                        y: Number(match[5])
                    });
                }
            }
            return displays;
        }
    }

    return [];
}

async function detectWindowsWindows(): Promise<WindowInfo[]> {
    const script = [
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;",
        "$items = Get-Process -ErrorAction SilentlyContinue |",
        "  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |",
        "  ForEach-Object {",
        "    [pscustomobject]@{",
        "      id = $_.MainWindowHandle.ToString();",
        "      title = $_.MainWindowTitle;",
        "      app = $_.ProcessName",
        "    }",
        "  };",
        "$items | ConvertTo-Json -Compress"
    ].join(" ");

    const result = await run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        5_000
    );
    if (!result.ok || !result.stdout.trim()) return [];

    try {
        const parsed = JSON.parse(result.stdout.replace(/\u0000/g, "").replace(/^\uFEFF/, "").trim()) as
            | Array<{ id?: string; title?: string; app?: string }>
            | { id?: string; title?: string; app?: string };
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows
            .filter(row => row.title && row.id)
            .map(row => ({
                id: String(row.id),
                title: String(row.title).trim(),
                app: String(row.app || "").trim()
            }))
            .filter(row => row.title)
            .sort((a, b) => a.app.localeCompare(b.app) || a.title.localeCompare(b.title));
    } catch {
        return [];
    }
}

async function detectX11Windows(): Promise<WindowInfo[]> {
    if (!(await hasCommand("xprop"))) return [];
    const root = await run("xprop", ["-root", "_NET_CLIENT_LIST"], 4_000);
    if (!root.ok) return [];

    const ids = [...root.stdout.matchAll(/0x[0-9a-f]+/gi)].map(match => match[0].toLowerCase());
    const seen = new Set<string>();
    const windows: WindowInfo[] = [];

    await Promise.all(
        ids.map(async id => {
            if (seen.has(id)) return;
            seen.add(id);
            const [name, klass] = await Promise.all([
                run("xprop", ["-id", id, "_NET_WM_NAME", "WM_NAME"], 3_000),
                run("xprop", ["-id", id, "WM_CLASS"], 3_000)
            ]);
            const titleMatch = `${name.stdout}\n${name.stderr}`.match(/=\s*"(.*)"/);
            const title = titleMatch?.[1]?.trim() ?? "";
            if (!title) return;
            const classMatch = `${klass.stdout}\n${klass.stderr}`.match(/=\s*"([^"]*)",\s*"([^"]*)"/);
            windows.push({
                id,
                title,
                app: (classMatch?.[2] || classMatch?.[1] || "").trim()
            });
        })
    );

    return windows.sort((a, b) => a.app.localeCompare(b.app) || a.title.localeCompare(b.title));
}

async function detectWindows(
    sessionType: string,
    platform: string,
    windowMethod: CaptureSupport["windowMethod"]
): Promise<WindowInfo[]> {
    if (!windowMethod) return [];
    if (platform === "win32") return detectWindowsWindows();
    if (platform !== "linux") return [];
    // The portal popup is the window list on Wayland, so there is nothing to
    // enumerate here. On X11 we still enumerate concrete window ids.
    if (windowMethod === "wayland-portal") return [];
    if (windowMethod === "x11" || sessionType === "x11") return detectX11Windows();
    return [];
}

async function detectAudio(sessionType: string, platform: string): Promise<AudioDeviceInfo> {
    if (platform === "win32") {
        return { mic: null, monitor: null, apps: [], devices: await detectWindowsAudioDevices() };
    }
    if (platform !== "linux") return { mic: null, monitor: null, apps: [], devices: [] };
    if (!(await hasCommand("pactl"))) return { mic: null, monitor: null, apps: [], devices: [] };

    const [source, sink, apps] = await Promise.all([
        run("pactl", ["get-default-source"], 3_000),
        run("pactl", ["get-default-sink"], 3_000),
        detectPipeWireApps()
    ]);

    const mic = source.ok ? source.stdout.trim() || null : null;
    const sinkName = sink.ok ? sink.stdout.trim() : "";
    return {
        mic,
        monitor: sinkName ? `${sinkName}.monitor` : null,
        apps,
        devices: []
    };
}

/**
 * Enumerate applications that are currently producing audio. `pw-dump` gives
 * us PipeWire node ids directly, which is what `pw-record --target` needs.
 * Discord's voice engine is deliberately hidden: the bridge must never publish
 * other participants' audio back into the voice channel.
 */
async function detectPipeWireApps(): Promise<AudioAppInfo[]> {
    if (!(await hasCommand("pw-dump"))) return [];
    const dump = await run("pw-dump", [], 8_000);
    if (!dump.ok) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(dump.stdout);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];

    const groups = new Map<string, AudioAppInfo>();
    for (const entry of parsed) {
        if (!isRecord(entry) || entry.type !== "PipeWire:Interface:Node") continue;
        const info = isRecord(entry.info) ? entry.info : null;
        const props = info && isRecord(info.props) ? info.props : null;
        if (!props) continue;
        if (stringProp(props, "media.class") !== "Stream/Output/Audio") continue;

        const appName =
            stringProp(props, "application.name") ||
            stringProp(props, "node.name") ||
            "Unknown application";
        const binary = stringProp(props, "application.process.binary");
        const nodeName = stringProp(props, "node.name");
        const mediaName = stringProp(props, "media.name");
        if (isDiscordAudio(appName, binary, nodeName, mediaName)) continue;

        const nodeId = Number(entry.id);
        if (!Number.isFinite(nodeId) || nodeId <= 0) continue;

        const id = normalizeAppId(binary, appName);
        const node = { id: nodeId, name: nodeName || appName };
        const existing = groups.get(id);
        if (existing) {
            if (!existing.nodes.some(item => item.id === node.id)) existing.nodes.push(node);
        } else {
            groups.set(id, { id, name: appName, nodes: [node] });
        }
    }

    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function detectWindowsAudioDevices(): Promise<string[]> {
    const result = await run("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], 8_000);
    const text = `${result.stdout}\n${result.stderr}`;
    const devices: string[] = [];
    for (const match of text.matchAll(/\[dshow[^\]]*\]\s+"([^"]+)"\s+\(audio\)/gi)) {
        if (!devices.includes(match[1])) devices.push(match[1]);
    }
    return devices;
}

function normalizeAppId(binary: string, appName: string): string {
    const name = binary && binary !== "None" ? binary : appName;
    return name.trim().toLowerCase();
}

export function isDiscordAudio(
    appName: string,
    binary: string,
    nodeName: string,
    mediaName: string
): boolean {
    const haystack = `${appName} ${binary} ${nodeName} ${mediaName}`;
    return /discord|equicord|vesktop|equibop|webrtc voiceengine/i.test(haystack);
}

function stringProp(props: Record<string, unknown>, key: string): string {
    const value = props[key];
    return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

async function hasCommand(command: string): Promise<boolean> {
    const result = await run("sh", ["-c", `command -v ${JSON.stringify(command)}`], 3_000);
    return result.ok && Boolean(result.stdout.trim());
}

async function hasPortalSupport(): Promise<boolean> {
    const python = await run(
        "python3",
        [
            "-c",
            "import dbus, gi; gi.require_version('Gst','1.0'); from gi.repository import Gst; Gst.init(None)"
        ],
        10_000
    );
    if (!python.ok) return false;

    const [pipewire, vah264, x264] = await Promise.all([
        run("gst-inspect-1.0", ["pipewiresrc"], 4_000),
        run("gst-inspect-1.0", ["vah264enc"], 4_000),
        run("gst-inspect-1.0", ["x264enc"], 4_000)
    ]);
    return pipewire.ok && (vah264.ok || x264.ok);
}
