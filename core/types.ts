/*
 * Broadcast Box Bridge - shared types.
 *
 * This file must stay browser safe: it is bundled into the Discord renderer.
 */

export type ResolutionPreset = "native" | "720p" | "1080p" | "1440p" | "2160p";
export type CodecId = "h264" | "hevc" | "vp9" | "av1";
export type AudioMode = "none" | "mic" | "system" | "app";
export type EncoderId = "auto" | "vaapi" | "nvenc" | "qsv" | "amf" | "x264";
export type CaptureSource = "screen" | "window";

export interface BBConfig {
    /** Base URL of the Broadcast Box instance, no trailing slash. */
    server: string;
    resolution: ResolutionPreset;
    fps: number;
    codec: CodecId;
    /** "auto" lets the native helper pick the best available hardware encoder. */
    encoder: EncoderId;
    /** 0 means "derive from resolution and fps". */
    bitrateKbps: number;
    /** Capture a whole screen/output or a single application window. */
    capture: CaptureSource;
    /** Window id selected for window capture. Empty means the first window. */
    window: string;
    audio: AudioMode;
    /** Capture all non-Discord applications instead of the full output monitor. */
    audioExcludeDiscord: boolean;
    /** Application key (from AudioAppInfo.id) when `audio` is "app". */
    audioApp: string;
    /** Optional audio device override (Windows dshow name, PulseAudio source name). */
    audioDevice: string;
    /** Wayland output name (wf-recorder -o) or empty for the first output. */
    monitor: string;
    /** Optional capture region, formatted as "x,y WxH". Empty captures the whole output. */
    region: string;
    /** How often the watch list refreshes stream status, in milliseconds. */
    pollIntervalMs: number;
    /** Open the player for your own stream after publishing starts. */
    autoWatchSelf: boolean;
    /** Hide the floating dock unless you are connected to a voice channel. */
    onlyInVoice: boolean;
    /** Show capture/encoder warnings in the share panel. Off by default. */
    showDiagnostics: boolean;
}

export interface DisplayInfo {
    name: string;
    width: number;
    height: number;
    refreshHz?: number;
    x?: number;
    y?: number;
    /** Windows only: the primary display. */
    primary?: boolean;
}

export interface WindowInfo {
    /** Platform-specific window id (X11 window id, Hyprland address, HWND). */
    id: string;
    title: string;
    /** Application/process name when the platform exposes it. */
    app: string;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
}

export interface AudioAppInfo {
    /** Stable key used by BBConfig.audioApp. */
    id: string;
    /** Human-readable application name. */
    name: string;
    /** PipeWire node id / name pairs captured for this application. */
    nodes: Array<{ id: number; name: string }>;
}

export interface AudioDeviceInfo {
    /** PulseAudio source name, or a dshow device name on Windows. */
    mic: string | null;
    /** PulseAudio monitor source name for system audio. */
    monitor: string | null;
    /** Applications currently producing audio (Linux/PipeWire only). */
    apps: AudioAppInfo[];
    /** DirectShow audio device names (Windows only). */
    devices: string[];
}

export interface CaptureSupport {
    wfRecorder: boolean;
    x11grab: boolean;
    ddagrab: boolean;
    gdigrab: boolean;
    /** Windows/AMD: FFmpeg has the zero-copy AMF screen capture + VPP filters. */
    amfCapture: boolean;
    /** True when this platform/backend can capture a single application window. */
    window: boolean;
    /** How window capture is implemented on this platform. */
    windowMethod?: "x11" | "wayland-portal" | "gdigrab";
}

export interface Capabilities {
    platform: string;
    sessionType: string;
    ffmpeg: boolean;
    ffmpegVersion: string | null;
    /** ffmpeg encoder names, e.g. "h264_vaapi". */
    encoders: string[];
    /** True when this FFmpeg's WHIP muxer exposes the UDP send-buffer option. */
    whipTsBuffer?: boolean;
    capture: CaptureSupport;
    vaapiDevice: string | null;
    displays: DisplayInfo[];
    /** Capturable application windows for the current desktop session. */
    windows: WindowInfo[];
    audio: AudioDeviceInfo;
    recommendedEncoder: Exclude<EncoderId, "auto"> | null;
    availableEncoders: Array<Exclude<EncoderId, "auto">>;
    warnings: string[];
    checkedAt: number;
}

export interface PublishStats {
    fps?: number;
    bitrateKbps?: number;
    frame?: number;
    duplicated?: number;
    dropped?: number;
    speed?: number;
}

export interface PublishState {
    running: boolean;
    /** True once Broadcast Box reports the stream as online. */
    live?: boolean;
    key?: string;
    startedAt?: number;
    pid?: number;
    encoder?: string;
    command?: string;
    error?: string | null;
    warnings: string[];
    logs: string[];
    stats?: PublishStats;
}

export interface StartResult {
    ok: boolean;
    error?: string;
    state?: PublishState;
}

export interface NativeApi {
    detect(force?: boolean): Promise<Capabilities>;
    start(options: { config: BBConfig; key: string }): Promise<StartResult>;
    stop(): Promise<{ ok: boolean; error?: string }>;
    state(): Promise<PublishState>;
}

export interface BBStatus {
    streamKey: string;
    motd?: string;
    viewers: number;
    isOnline: boolean;
    streamStart?: string;
}

export interface VoiceMember {
    userId: string;
    name: string;
    avatarUrl?: string | null;
    /** Discord stream key, when the member is natively streaming. */
    nativeStream?: boolean;
}

export interface WatchTarget {
    userId: string;
    name: string;
    key: string;
    /** Display name shown in Discord's voice tiles, used to dock the preview. */
    tileName?: string;
}

export interface BridgeSnapshot {
    config: BBConfig;
    capabilities: Capabilities | null;
    voiceChannelId: string | null;
    voiceChannelName: string | null;
    selfUserId: string;
    selfKey: string | null;
    members: VoiceMember[];
    /** userId -> stream status. Absent means "not checked yet". */
    live: Record<string, BBStatus | null>;
    publishing: PublishState;
    publishLive: boolean;
    busy: boolean;
    watch: WatchTarget | null;
    error: string | null;
}

export interface BridgeHost {
    readonly clientName: "equicord" | "betterdiscord";
    readonly native: NativeApi;

    getCurrentUserId(): string;
    getCurrentUserName(): string;
    getVoiceChannelId(): string | null;
    getChannelName(channelId: string): string;
    getVoiceMembers(channelId: string): VoiceMember[];
    getUserName(userId: string): string;
    getUserAvatarUrl?(userId: string): string | null;

    toast(message: string, kind?: "info" | "success" | "error" | "warning"): void;
    copyText(text: string): void;
    log(...args: unknown[]): void;

    /** Element the dock is appended to. */
    mountPoint?(): HTMLElement;
}
