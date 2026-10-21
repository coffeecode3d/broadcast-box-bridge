import type { BBConfig, Capabilities, DisplayInfo, ResolutionPreset, WindowInfo } from "./types";

export const CONFIG_STORAGE_KEY = "bbBridge.config.v1";
const BITRATE_DEFAULT_MIGRATION_KEY = "bbBridge.bitrateDefault.v1";

export const DEFAULT_SERVER = "";

export const DEFAULT_CONFIG: BBConfig = {
    server: DEFAULT_SERVER,
    resolution: "1080p",
    fps: 60,
    codec: "h264",
    encoder: "auto",
    bitrateKbps: 9_500,
    capture: "screen",
    window: "",
    audio: "mic",
    audioExcludeDiscord: true,
    audioApp: "",
    audioDevice: "",
    monitor: "",
    region: "",
    pollIntervalMs: 10_000,
    autoWatchSelf: true,
    onlyInVoice: true,
    showDiagnostics: false
};

export const RESOLUTIONS: Array<{ value: ResolutionPreset; label: string }> = [
    { value: "native", label: "Native source" },
    { value: "720p", label: "1280 x 720" },
    { value: "1080p", label: "1920 x 1080" },
    { value: "1440p", label: "2560 x 1440" },
    { value: "2160p", label: "3840 x 2160" }
];

export const FPS_CHOICES = [30, 60, 120];

const RESOLUTION_SIZES: Record<Exclude<ResolutionPreset, "native">, [number, number]> = {
    "720p": [1280, 720],
    "1080p": [1920, 1080],
    "1440p": [2560, 1440],
    "2160p": [3840, 2160]
};

export function normalizeServer(server: string): string {
    let value = (server || "").trim();
    if (!value) return "";
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    return value.replace(/\/+$/, "");
}

function pickWindow(config: BBConfig, windows: WindowInfo[]): WindowInfo | null {
    if (!windows.length) return null;
    if (config.window) {
        const match = windows.find(window => window.id === config.window);
        if (match) return match;
    }
    return windows[0];
}

function pickDisplay(config: BBConfig, displays: DisplayInfo[]): DisplayInfo | null {
    if (!displays.length) return null;
    if (config.monitor) {
        const match = displays.find(d => d.name === config.monitor);
        if (match) return match;
    }
    return displays[0];
}

export function resolutionSize(
    config: BBConfig,
    capabilities?: Capabilities | null
): { width: number; height: number } {
    if (config.resolution === "native") {
        if (config.capture === "window") {
            const window = pickWindow(config, capabilities?.windows ?? []);
            if (window?.width && window?.height) {
                return evenSize(window.width, window.height);
            }
        }
        const display = pickDisplay(config, capabilities?.displays ?? []);
        if (display?.width && display?.height) {
            return evenSize(display.width, display.height);
        }
        return { width: 1920, height: 1080 };
    }
    const [width, height] = RESOLUTION_SIZES[config.resolution] ?? RESOLUTION_SIZES["1080p"];
    return { width, height };
}

export function evenSize(width: number, height: number): { width: number; height: number } {
    return {
        width: Math.max(2, Math.round(width / 2) * 2),
        height: Math.max(2, Math.round(height / 2) * 2)
    };
}

export function autoBitrateKbps(width: number, height: number, fps: number): number {
    // ~0.07 bits per pixel per frame is a good screen-content baseline for H.264.
    const estimate = Math.round((width * height * fps * 0.07) / 1000);
    return clamp(Math.round(estimate / 500) * 500, 1500, 40_000);
}

export function effectiveBitrateKbps(config: BBConfig, capabilities?: Capabilities | null): number {
    if (config.bitrateKbps > 0) return clamp(Math.round(config.bitrateKbps), 200, 100_000);
    const { width, height } = resolutionSize(config, capabilities);
    return autoBitrateKbps(width, height, config.fps);
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function normalizeConfig(input: Partial<BBConfig> | null | undefined): BBConfig {
    const raw = { ...DEFAULT_CONFIG, ...(input || {}) } as BBConfig;

    return {
        ...raw,
        server: normalizeServer(raw.server),
        resolution: RESOLUTIONS.some(r => r.value === raw.resolution) ? raw.resolution : DEFAULT_CONFIG.resolution,
        fps: FPS_CHOICES.includes(Number(raw.fps)) ? Number(raw.fps) : DEFAULT_CONFIG.fps,
        codec: "h264",
        encoder: ["auto", "vaapi", "nvenc", "qsv", "amf", "x264"].includes(raw.encoder)
            ? raw.encoder
            : "auto",
        bitrateKbps: Number.isFinite(Number(raw.bitrateKbps))
            ? Math.max(0, Math.round(Number(raw.bitrateKbps)))
            : DEFAULT_CONFIG.bitrateKbps,
        capture: raw.capture === "window" ? "window" : "screen",
        window: typeof raw.window === "string" ? raw.window : "",
        audio: ["none", "mic", "system", "app"].includes(raw.audio) ? raw.audio : DEFAULT_CONFIG.audio,
        audioExcludeDiscord: raw.audioExcludeDiscord !== false,
        audioApp: typeof raw.audioApp === "string" ? raw.audioApp : "",
        audioDevice: typeof raw.audioDevice === "string" ? raw.audioDevice : "",
        monitor: typeof raw.monitor === "string" ? raw.monitor : "",
        region: typeof raw.region === "string" ? raw.region.trim() : "",
        pollIntervalMs: clamp(
            Number.isFinite(Number(raw.pollIntervalMs)) ? Number(raw.pollIntervalMs) : DEFAULT_CONFIG.pollIntervalMs,
            5_000,
            60_000
        ),
        autoWatchSelf: Boolean(raw.autoWatchSelf),
        onlyInVoice: Boolean(raw.onlyInVoice),
        showDiagnostics: Boolean(raw.showDiagnostics)
    };
}

export function loadConfig(): BBConfig {
    try {
        const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
        if (!raw) {
            localStorage.setItem(BITRATE_DEFAULT_MIGRATION_KEY, "1");
            return { ...DEFAULT_CONFIG };
        }
        const parsed = JSON.parse(raw) as Partial<BBConfig>;
        // Older builds used 0 (auto) as the default. Move those users to the
        // new 9500 kbps default once, without rewriting a later explicit 0.
        let migrated = false;
        if (!localStorage.getItem(BITRATE_DEFAULT_MIGRATION_KEY)) {
            if (Number(parsed.bitrateKbps) === 0) {
                parsed.bitrateKbps = DEFAULT_CONFIG.bitrateKbps;
                migrated = true;
            }
            localStorage.setItem(BITRATE_DEFAULT_MIGRATION_KEY, "1");
        }
        const config = normalizeConfig(parsed);
        // Persist the migrated default immediately. Otherwise a restart before
        // the next settings change would read the old 0 back from storage.
        if (migrated) saveConfig(config);
        return config;
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

export function saveConfig(config: BBConfig): void {
    try {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch {
        // Storage might be unavailable or full; the in-memory config still works.
    }
}

export function parseRegion(region: string): { x: number; y: number; width: number; height: number } | null {
    const match = region.trim().match(/^(-?\d+)\s*,\s*(-?\d+)\s+(\d+)\s*[xX]\s*(\d+)$/);
    if (!match) return null;
    const [, x, y, width, height] = match;
    return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
}
