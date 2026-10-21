import { fetchStatus } from "../bb";
import { normalizeServer } from "../config";
import type { WatchTarget } from "../types";
import { WHEPConnection } from "../whep";
import { formatStats, h } from "./dom";
import { PLAYER_CSS } from "./styles";

const FLOATING_HOST_STYLE = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483001;";
const DOCKED_HOST_STYLE = "position:absolute;inset:0;width:auto;height:auto;z-index:2147483001;";
const GEOMETRY_KEY = "bbBridge.player.v1";

interface PlayerGeometry {
    left?: number;
    top?: number;
    width?: number;
    height?: number;
}

interface PlayerOptions {
    mountPoint?: HTMLElement;
    onClose?: () => void;
    showDiagnostics?: () => boolean;
}

/**
 * Floating, draggable WHEP player rendered into a shadow root so Discord's
 * stylesheet cannot interfere.
 */
export class Player {
    private host: HTMLElement;
    private shadow: ShadowRoot;
    private root!: HTMLElement;
    private titleEl!: HTMLElement;
    private badgeEl!: HTMLElement;
    private video!: HTMLVideoElement;
    private canvas!: HTMLCanvasElement;
    private canvasCtx: CanvasRenderingContext2D | null = null;
    private canvasWidth = 0;
    private canvasHeight = 0;
    private canvasObserver: ResizeObserver | null = null;
    private overlay!: HTMLElement;
    private overlayTitle!: HTMLElement;
    private overlayText!: HTMLElement;
    private statsEl!: HTMLElement;
    private muteBtn!: HTMLButtonElement;
    private volume!: HTMLInputElement;
    private volumeLabel!: HTMLElement;
    private stage!: HTMLElement;

    private connection: WHEPConnection | null = null;
    private target: WatchTarget | null = null;
    private server = "";
    private retries = 0;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private statsTimer: ReturnType<typeof setInterval> | undefined;
    private statusTimer: ReturnType<typeof setInterval> | undefined;
    private lastBytes = 0;
    private lastFrames = 0;
    private lastDropped: number | undefined;
    private lastLost: number | undefined;
    private presentedFrames = 0;
    private canvasFrames = 0;
    private canvasStalls = 0;
    private lastCanvasAt = 0;
    private presentedAt = 0;
    private presentedGeneration = 0;
    private lastSample = 0;
    private closed = true;
    private dragCleanup: (() => void) | null = null;
    private resizeCleanup: (() => void) | null = null;
    private fullscreenTimer: ReturnType<typeof setTimeout> | undefined;

    private mode: "docked" | "floating" = "floating";
    private dockElement: HTMLElement | null = null;
    private dockTimer: ReturnType<typeof setInterval> | undefined;
    private dockMisses = 0;
    private originalTilePosition: string | null = null;

    constructor(private readonly options: PlayerOptions = {}) {
        this.host = document.createElement("div");
        this.host.setAttribute("data-bb-player", "");
        this.host.style.cssText = FLOATING_HOST_STYLE;
        this.shadow = this.host.attachShadow({ mode: "open" });
        this.build();
        document.addEventListener("fullscreenchange", this.onFullscreenChange);
        this.root.addEventListener("pointermove", this.onFullscreenPointerMove);
        this.root.addEventListener("pointerdown", this.onFullscreenPointerMove);
    }

    get isOpen(): boolean {
        return !this.closed;
    }

    get currentKey(): string | null {
        return this.target?.key ?? null;
    }

    open(target: WatchTarget, server: string): void {
        const normalized = normalizeServer(server);
        const same = this.target?.key === target.key && this.server === normalized && !this.closed;
        this.target = target;
        this.server = normalized;
        this.mount();
        if (!same) {
            this.retries = 0;
            this.titleEl.textContent = target.name;
            this.badgeEl.className = "bb-badge";
            this.badgeEl.textContent = "Connecting";
            this.closed = false;
            this.host.hidden = false;
            this.root.hidden = false;
            this.mode = "floating";
            this.root.classList.add("floating");
            this.root.classList.remove("docked");
            this.applyGeometry(true);
            // The preview intentionally stays a normal floating window. It is
            // resizable, remembers its geometry, and never tries to re-parent
            // itself into Discord's voice tiles.
            void this.connect();
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.fullscreenTimer);
        this.root.classList.remove("controls-visible");
        if (document.fullscreenElement === this.root) {
            void document.exitFullscreen().catch(() => undefined);
        }
        this.stopDockTracking();
        this.leaveDockedMode();
        this.clearTimers();
        this.connection?.disconnect();
        this.connection = null;
        this.video.srcObject = null;
        this.target = null;
        this.host.hidden = true;
        this.root.hidden = true;
        this.options.onClose?.();
    }

    setOffline(): void {
        if (this.closed) return;
        this.showOverlay("Stream ended", "The broadcaster stopped sharing. Waiting for the stream to come back…");
        this.badgeEl.className = "bb-badge";
        this.badgeEl.textContent = "Offline";
    }

    destroy(): void {
        this.close();
        this.canvasObserver?.disconnect();
        this.canvasObserver = null;
        this.dragCleanup?.();
        this.resizeCleanup?.();
        document.removeEventListener("fullscreenchange", this.onFullscreenChange);
        this.root.removeEventListener("pointermove", this.onFullscreenPointerMove);
        this.root.removeEventListener("pointerdown", this.onFullscreenPointerMove);
        clearTimeout(this.fullscreenTimer);
        this.host.remove();
    }

    private mount() {
        const point = this.options.mountPoint ?? document.body;
        if (!this.host.isConnected) point.append(this.host);
    }

    private build() {
        const style = h("style", { text: PLAYER_CSS });

        this.badgeEl = h("span", { class: "bb-badge", text: "Connecting" });
        this.titleEl = h("span", { class: "bb-player-title", text: "Broadcast Box" });

        this.muteBtn = h("button", {
            class: "bb-icon",
            title: "Mute",
            text: "🔊",
            on: {
                click: () => {
                    this.video.muted = !this.video.muted;
                    this.syncVolume();
                }
            }
        });
        const popoutBtn = h("button", {
            class: "bb-icon bb-popout",
            title: "Pop out player",
            text: "⧉",
            on: { click: () => this.floatPlayer(true) }
        });
        const pipBtn = h("button", {
            class: "bb-icon bb-pip",
            title: "Picture in picture",
            text: "▣",
            on: { click: () => void this.togglePip() }
        });
        const fullBtn = h("button", {
            class: "bb-icon bb-full",
            title: "Fullscreen",
            text: "⛶",
            on: { click: () => void this.toggleFullscreen() }
        });
        const closeBtn = h("button", {
            class: "bb-icon",
            title: "Close player",
            text: "✕",
            on: { click: () => this.close() }
        });
        const bar = h("div", { class: "bb-player-bar" }, [
            h("span", { class: "bb-dot live" }),
            this.titleEl,
            this.badgeEl,
            h("span", { class: "bb-spacer", attrs: { style: "flex:1" } }),
            this.muteBtn,
            popoutBtn,
            pipBtn,
            fullBtn,
            closeBtn
        ]);

        this.video = h("video", { attrs: { autoplay: "", playsinline: "" } });
        this.video.muted = true;
        this.canvas = h("canvas", { class: "bb-preview-canvas" }) as HTMLCanvasElement;
        this.canvasCtx = this.canvas.getContext("2d", { alpha: false });
        if (!this.canvasCtx) {
            // Very old Electron builds: keep the native video element visible.
            this.canvas.style.display = "none";
            this.video.style.opacity = "1";
        }
        this.overlayTitle = h("b", { text: "Connecting…" });
        this.overlayText = h("span", { text: "Negotiating with Broadcast Box" });
        this.overlay = h("div", { class: "bb-player-overlay" }, [
            h("span", { class: "bb-spin" }),
            this.overlayTitle,
            this.overlayText
        ]);
        this.statsEl = h("div", { class: "bb-player-stats", hidden: true });
        this.stage = h("div", { class: "bb-player-stage" }, [
            this.video,
            this.canvas,
            this.overlay,
            this.statsEl
        ]);

        this.volume = h("input", {
            attrs: { type: "range", min: "0", max: "100", value: "100" },
            on: {
                input: () => {
                    this.video.volume = Number(this.volume.value) / 100;
                    if (this.video.volume > 0 && this.video.muted) {
                        this.video.muted = false;
                    }
                    this.syncVolume();
                }
            }
        });
        this.volumeLabel = h("span", { class: "bb-vol-label", text: "100%" });
        const ctl = h("div", { class: "bb-player-ctl" }, [
            this.volume,
            this.volumeLabel,
            h("span", { attrs: { style: "flex:1" } }),
            h("button", {
                class: "bb-btn",
                text: "Reconnect",
                on: { click: () => this.reconnect(true) }
            })
        ]);

        const resizeHandle = h("div", { class: "bb-resize", title: "Resize player" });
        this.root = h("div", { class: "bb-player" }, [bar, this.stage, ctl, resizeHandle]);
        this.root.hidden = true;
        this.shadow.append(style, this.root);

        this.dragCleanup = this.makeDraggable(bar);
        this.resizeCleanup = this.makeResizable(resizeHandle);
        this.canvas.addEventListener("dblclick", () => {
            void this.toggleFullscreen();
        });
        this.canvas.addEventListener("click", () => {
            if (this.mode === "floating") void this.togglePause();
        });
        this.video.addEventListener("dblclick", () => {
            void this.toggleFullscreen();
        });
        this.video.addEventListener("click", () => {
            if (this.mode === "floating") void this.togglePause();
        });

        if (typeof ResizeObserver !== "undefined") {
            this.canvasObserver = new ResizeObserver(entries => {
                const rect = entries[0]?.contentRect;
                if (!rect) return;
                this.canvasWidth = rect.width;
                this.canvasHeight = rect.height;
            });
            this.canvasObserver.observe(this.stage);
        }
        this.syncVolume();
    }

    private async connect() {
        if (this.closed || !this.target) return;
        this.connection?.disconnect();
        this.connection = null;
        this.showOverlay("Connecting…", "Negotiating with Broadcast Box");
        this.badgeEl.className = "bb-badge";
        this.badgeEl.textContent = "Connecting";

        const connection = new WHEPConnection(this.server, this.target.key, {
            onConnectionState: state => {
                if (this.closed || connection !== this.connection) return;
                if (state === "connected") {
                    this.retries = 0;
                    clearTimeout(this.retryTimer);
                    clearTimeout(this.disconnectTimer);
                    this.hideOverlay();
                    this.badgeEl.className = "bb-badge on";
                    this.badgeEl.textContent = "Live";
                } else if (state === "failed") {
                    this.scheduleRetry("Connection failed");
                } else if (state === "disconnected") {
                    this.handleDisconnected();
                }
            }
        });
        this.connection = connection;

        try {
            const result = await connection.connect();
            if (this.closed || connection !== this.connection) {
                connection.disconnect();
                return;
            }
            this.video.srcObject = result.stream;
            this.video.play().catch(() => {
                // Autoplay was blocked; the user can press play.
                this.showOverlay("Press play", "Your client blocked autoplay. Click the video to start.");
            });
            this.startStats();
            this.startStatusPolling();
        } catch (error) {
            if (this.closed || connection !== this.connection) return;
            connection.disconnect();
            this.scheduleRetry(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * `disconnected` is frequently transient (ICE consent refresh, a short
     * network hiccup). Killing a healthy stream immediately causes the exact
     * stutter we are trying to avoid, so give ICE a few seconds to recover.
     */
    private handleDisconnected() {
        if (this.closed) return;
        clearTimeout(this.disconnectTimer);
        this.badgeEl.className = "bb-badge";
        this.badgeEl.textContent = "Unstable";
        this.disconnectTimer = setTimeout(() => {
            if (this.closed) return;
            const state = this.connection?.connectionState;
            if (state === "connected" || state === "connecting") return;
            this.scheduleRetry("Connection lost");
        }, 5_000);
    }

    private scheduleRetry(reason: string) {
        if (this.closed) return;
        clearTimeout(this.disconnectTimer);
        if (this.retries >= 5) {
            this.showOverlay("Unable to play", `${reason}\n\nThe stream may have ended. Press Reconnect to try again.`);
            this.badgeEl.className = "bb-badge";
            this.badgeEl.textContent = "Error";
            return;
        }
        this.retries++;
        this.showOverlay("Reconnecting…", `Attempt ${this.retries} of 5 · ${reason}`);
        this.badgeEl.className = "bb-badge";
        this.badgeEl.textContent = "Reconnecting";
        this.clearTimers();
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            if (this.closed) return;
            const state = this.connection?.connectionState;
            if (state === "connected") {
                this.hideOverlay();
                this.badgeEl.className = "bb-badge on";
                this.badgeEl.textContent = "Live";
                return;
            }
            if (state === "connecting") return;
            void this.connect();
        }, 1500 + this.retries * 500);
    }

    private reconnect(reset: boolean) {
        if (reset) this.retries = 0;
        this.clearTimers();
        clearTimeout(this.retryTimer);
        void this.connect();
    }

    private startStats() {
        this.lastBytes = 0;
        this.lastFrames = 0;
        this.lastDropped = undefined;
        this.lastLost = undefined;
        this.presentedFrames = 0;
        this.canvasFrames = 0;
        this.canvasStalls = 0;
        this.lastCanvasAt = 0;
        this.presentedAt = performance.now();
        this.lastSample = performance.now();

        const generation = ++this.presentedGeneration;
        if (this.video.requestVideoFrameCallback) {
            const countPresented = () => {
                if (this.closed || generation !== this.presentedGeneration) return;
                this.presentedFrames++;
                this.drawPreviewFrame();
                this.video.requestVideoFrameCallback(countPresented);
            };
            this.video.requestVideoFrameCallback(countPresented);
        } else {
            const draw = () => {
                if (this.closed || generation !== this.presentedGeneration) return;
                this.presentedFrames++;
                this.drawPreviewFrame();
                requestAnimationFrame(draw);
            };
            requestAnimationFrame(draw);
        }

        clearInterval(this.statsTimer);
        this.statsTimer = setInterval(async () => {
            if (this.closed || !this.connection) return;
            const stats = await this.connection.stats();
            const now = performance.now();
            const elapsed = (now - this.lastSample) / 1000;
            let bitrateKbps: number | undefined;
            if (stats.bytesReceived != null && this.lastBytes > 0 && elapsed > 0.2) {
                bitrateKbps = Math.round(((stats.bytesReceived - this.lastBytes) * 8) / 1000 / elapsed);
            }
            if (stats.bytesReceived != null) this.lastBytes = stats.bytesReceived;
            let fps = stats.fps;
            if (!fps && stats.framesDecoded != null && this.lastFrames > 0 && elapsed > 0.2) {
                fps = (stats.framesDecoded - this.lastFrames) / elapsed;
            }
            if (stats.framesDecoded != null) this.lastFrames = stats.framesDecoded;
            this.lastSample = now;

            const elapsedPresented = Math.max(1, now - this.presentedAt);
            const presentedFps =
                this.presentedAt > 0 ? (this.presentedFrames * 1000) / elapsedPresented : undefined;
            const canvasActive = this.canvasCtx != null;
            const canvasFps = canvasActive ? (this.canvasFrames * 1000) / elapsedPresented : undefined;
            const canvasStalls = this.canvasStalls;
            this.presentedFrames = 0;
            this.canvasFrames = 0;
            this.canvasStalls = 0;
            this.presentedAt = now;

            const quality = this.video.getVideoPlaybackQuality?.();
            const rtpDropped = stats.framesDropped ?? 0;
            const playbackDropped = quality?.droppedVideoFrames ?? 0;
            const lost = stats.packetsLost ?? 0;
            const dropRate =
                this.lastDropped != null && elapsed > 0.2
                    ? Math.max(0, (rtpDropped - this.lastDropped) / elapsed)
                    : undefined;
            const lostRate =
                this.lastLost != null && elapsed > 0.2 ? Math.max(0, (lost - this.lastLost) / elapsed) : undefined;
            this.lastDropped = rtpDropped;
            this.lastLost = lost;

            const bufferMs =
                stats.jitterBufferDelay != null && stats.jitterBufferEmittedCount
                    ? (stats.jitterBufferDelay / stats.jitterBufferEmittedCount) * 1000
                    : undefined;
            const text = formatStats({
                ...stats,
                fps,
                presentedFps: canvasActive ? canvasFps : presentedFps,
                bitrateKbps,
                dropped: rtpDropped,
                playbackDropped: canvasActive ? undefined : playbackDropped,
                stalls: canvasActive ? canvasStalls : undefined,
                lost,
                dropRate,
                lostRate,
                jitterMs: stats.jitter != null ? stats.jitter * 1000 : undefined,
                bufferMs
            });
            this.statsEl.textContent = text;
            this.statsEl.title = [
                `received ${stats.framesReceived ?? "?"}`,
                `decoded ${stats.framesDecoded ?? "?"}`,
                canvasActive
                    ? `canvas ${Math.round(canvasFps ?? 0)}/s · stalls ${canvasStalls}`
                    : `presented ${Math.round(presentedFps ?? 0)}/s`,
                `rtp dropped ${rtpDropped}${dropRate != null ? ` (${dropRate.toFixed(1)}/s)` : ""}`,
                canvasActive
                    ? `native video dropped ${playbackDropped}/${quality?.totalVideoFrames ?? "?"} (hidden behind canvas)`
                    : `playback dropped ${playbackDropped}/${quality?.totalVideoFrames ?? "?"}`,
                `lost ${lost}${lostRate != null ? ` (${lostRate.toFixed(1)}/s)` : ""}`,
                `playout buffer ${bufferMs != null ? `${Math.round(bufferMs)}ms` : "?"}`,
                `decoder ${stats.decoderImplementation ?? "?"}${
                    stats.powerEfficientDecoder === true
                        ? " (hw)"
                        : stats.powerEfficientDecoder === false
                          ? " (sw)"
                          : ""
                }`,
                `rtt ${stats.rtt != null ? `${Math.round(stats.rtt * 1000)}ms` : "?"}`
            ].join(" · ");
            this.statsEl.hidden = !(this.options.showDiagnostics?.() ?? false) || !text;
        }, 1000);
    }

    /**
     * Discord/Electron on Wayland can leave the native video overlay stale
     * even while WebRTC keeps decoding at 60 fps. Drawing each new frame into
     * a normal canvas texture avoids that overlay path and keeps the preview
     * updating. The canvas is sized to the displayed preview, not the source,
     * so a docked 360p tile does not pay for a 1080p draw.
     */
    private drawPreviewFrame() {
        const ctx = this.canvasCtx;
        if (!ctx) return;
        const vw = this.video.videoWidth;
        const vh = this.video.videoHeight;
        if (!vw || !vh || this.video.readyState < 2) return;

        let cssWidth = this.canvasWidth;
        let cssHeight = this.canvasHeight;
        if (cssWidth < 2 || cssHeight < 2) {
            const rect = this.stage.getBoundingClientRect();
            cssWidth = rect.width;
            cssHeight = rect.height;
            this.canvasWidth = cssWidth;
            this.canvasHeight = cssHeight;
        }
        if (cssWidth < 2 || cssHeight < 2) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cap = Math.min(1, 1920 / Math.max(1, cssWidth * dpr));
        const cw = Math.max(2, Math.round(cssWidth * dpr * cap));
        const ch = Math.max(2, Math.round(cssHeight * dpr * cap));
        if (this.canvas.width !== cw || this.canvas.height !== ch) {
            this.canvas.width = cw;
            this.canvas.height = ch;
        }

        const scale = Math.min(cw / vw, ch / vh);
        const dw = Math.max(1, Math.round(vw * scale));
        const dh = Math.max(1, Math.round(vh * scale));
        const dx = Math.floor((cw - dw) / 2);
        const dy = Math.floor((ch - dh) / 2);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, cw, ch);
        try {
            ctx.drawImage(this.video, dx, dy, dw, dh);
            const now = performance.now();
            if (this.lastCanvasAt > 0 && now - this.lastCanvasAt > 250) {
                this.canvasStalls++;
            }
            this.lastCanvasAt = now;
            this.canvasFrames++;
        } catch {
            // The decoder may not have a frame ready yet.
        }
    }

    private startStatusPolling() {
        clearInterval(this.statusTimer);
        this.statusTimer = setInterval(async () => {
            if (this.closed || !this.target) return;
            try {
                const status = await fetchStatus(this.server, this.target.key);
                if (!status?.isOnline) this.setOffline();
                else if (this.badgeEl.textContent === "Offline") {
                    this.reconnect(false);
                }
            } catch {
                // Transient network errors are handled by the WebRTC connection state.
            }
        }, 6_000);
    }

    private async togglePip() {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
                return;
            }
            if (this.video.readyState < 2) {
                this.showOverlay("Not ready yet", "Wait for the video to start before using picture in picture.");
                return;
            }
            // The canvas covers the video in the page. Some Chromium builds
            // refuse PiP for a fully transparent video, so make it technically
            // visible only for the duration of the request.
            const previousOpacity = this.video.style.opacity;
            this.video.style.opacity = "1";
            try {
                await this.video.requestPictureInPicture();
            } finally {
                this.video.style.opacity = previousOpacity;
            }
        } catch {
            // ignored
        }
    }

    private readonly onFullscreenChange = () => {
        if (document.fullscreenElement === this.root) {
            this.showFullscreenControls();
            return;
        }
        clearTimeout(this.fullscreenTimer);
        this.fullscreenTimer = undefined;
        this.root.classList.remove("controls-visible");
    };

    private readonly onFullscreenPointerMove = () => {
        this.showFullscreenControls();
    };

    private showFullscreenControls() {
        if (document.fullscreenElement !== this.root) return;
        this.root.classList.add("controls-visible");
        clearTimeout(this.fullscreenTimer);
        this.fullscreenTimer = setTimeout(() => {
            if (document.fullscreenElement !== this.root) return;
            // Keep the controls up while the pointer is resting on them.
            if (this.root.querySelector(".bb-player-bar:hover, .bb-player-ctl:hover")) {
                this.showFullscreenControls();
                return;
            }
            this.root.classList.remove("controls-visible");
        }, 1_800);
    }

    private async toggleFullscreen() {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
                return;
            }
            // The player is always floating, so fullscreen can use the normal
            // document fullscreen element without fighting Discord's tiles.
            await this.root.requestFullscreen();
        } catch {
            // ignored
        }
    }

    private async togglePause() {
        if (this.video.paused) {
            try {
                await this.video.play();
            } catch {
                // ignored
            }
        } else {
            this.video.pause();
        }
    }

    private syncVolume() {
        const percent = Math.round((this.video.muted ? 0 : this.video.volume) * 100);
        this.muteBtn.textContent = percent === 0 ? "🔇" : percent < 45 ? "🔉" : "🔊";
        this.muteBtn.title = percent === 0 ? "Unmute" : "Mute";
        this.volume.value = String(percent);
        this.volumeLabel.textContent = `${percent}%`;
    }

    private showOverlay(title: string, text: string) {
        this.overlayTitle.textContent = title;
        this.overlayText.textContent = text;
        this.overlay.hidden = false;
        const spinner = this.overlay.querySelector(".bb-spin") as HTMLElement | null;
        if (spinner) spinner.hidden = !/connecting|reconnecting/i.test(title);
    }

    private hideOverlay() {
        this.overlay.hidden = true;
    }

    private clearTimers() {
        clearInterval(this.statsTimer);
        clearInterval(this.statusTimer);
        clearTimeout(this.disconnectTimer);
        this.statsTimer = undefined;
        this.statusTimer = undefined;
        this.disconnectTimer = undefined;
    }

    private startDockTracking() {
        this.stopDockTracking();
        this.dockMisses = 0;
        this.syncDock();
        this.dockTimer = setInterval(() => this.syncDock(), 700);
    }

    private stopDockTracking() {
        clearInterval(this.dockTimer);
        this.dockTimer = undefined;
    }

    /**
     * Dock over the broadcaster's voice tile while it is visible (the voice
     * channel grid), otherwise pop out to a floating window.
     */
    private syncDock() {
        if (this.closed || !this.target) return;

        const tile = findVoiceTile(this.target.tileName ?? this.target.name, this.target.userId);
        if (tile) {
            this.dockMisses = 0;
            if (tile !== this.dockElement || this.mode !== "docked") {
                if (this.shouldReplaceDock(tile)) this.dockTo(tile);
            }
            return;
        }

        if (this.mode !== "docked") return;
        const element = this.dockElement;
        const rect = element?.getBoundingClientRect();
        const stillVisible = Boolean(
            element &&
                element.isConnected &&
                rect &&
                rect.width >= 120 &&
                rect.height >= 80 &&
                rect.right > 0 &&
                rect.bottom > 0 &&
                rect.left < window.innerWidth &&
                rect.top < window.innerHeight &&
                isVisible(element)
        );
        if (stillVisible) {
            this.dockMisses = 0;
            return;
        }

        if (++this.dockMisses >= 2) this.floatPlayer(true);
    }

    /**
     * Discord can keep several copies of the same participant name on screen
     * (focused tile + bottom filmstrip). Re-parenting the video every tick
     * causes visible stutter, so only move to a new tile when the old one is
     * gone/hidden, no longer belongs to this user, or the new one is clearly
     * the focused/larger copy.
     */
    private shouldReplaceDock(tile: HTMLElement): boolean {
        if (this.mode !== "docked" || !this.dockElement) return true;
        if (tile === this.dockElement) return false;

        const current = this.dockElement;
        if (!current.isConnected || !isVisible(current)) return true;

        const needle = (this.target?.tileName ?? this.target?.name ?? "").trim();
        if (needle.length >= 2 && !(current.textContent ?? "").includes(needle)) return true;

        const oldRect = current.getBoundingClientRect();
        const newRect = tile.getBoundingClientRect();
        const oldArea = oldRect.width * oldRect.height;
        const newArea = newRect.width * newRect.height;
        if (oldArea <= 0) return true;
        return newArea > oldArea * 1.35;
    }

    private dockTo(tile: HTMLElement) {
        if (this.mode === "floating") this.saveGeometry();
        this.releaseTile();

        this.dockElement = tile;
        this.originalTilePosition = tile.style.position;
        if (getComputedStyle(tile).position === "static") tile.style.position = "relative";
        this.host.style.cssText = DOCKED_HOST_STYLE;
        tile.append(this.host);

        this.root.style.width = "";
        this.root.style.height = "";
        this.root.style.left = "";
        this.root.style.top = "";
        this.root.style.right = "";
        this.root.style.bottom = "";
        this.root.style.maxWidth = "";
        this.root.style.maxHeight = "";

        this.mode = "docked";
        this.dockMisses = 0;
        this.root.classList.remove("floating");
        this.root.classList.add("docked");
        this.root.hidden = false;
    }

    private releaseTile() {
        if (!this.dockElement) return;
        if (this.originalTilePosition !== null) {
            this.dockElement.style.position = this.originalTilePosition;
        }
        this.dockElement = null;
        this.originalTilePosition = null;
    }

    private leaveDockedMode() {
        const wasDocked = this.mode === "docked";
        this.releaseTile();
        this.mode = "floating";
        this.root.classList.remove("docked");
        this.root.classList.add("floating");
        if (wasDocked) {
            this.host.style.cssText = FLOATING_HOST_STYLE;
            (this.options.mountPoint ?? document.body).append(this.host);
        }
    }

    private floatPlayer(bottomRight: boolean) {
        this.releaseTile();
        this.mode = "floating";
        this.root.classList.remove("docked");
        this.root.classList.add("floating");
        this.host.style.cssText = FLOATING_HOST_STYLE;
        (this.options.mountPoint ?? document.body).append(this.host);
        if (!this.closed) this.root.hidden = false;
        this.applyGeometry(bottomRight);
        this.dockMisses = 0;
    }

    private applyGeometry(bottomRight: boolean) {
        const geometry = this.loadGeometry();
        const width = clamp(
            geometry.width ?? 400,
            280,
            Math.max(280, window.innerWidth * 0.96)
        );
        const height = clamp(
            geometry.height ?? 270,
            180,
            Math.max(180, window.innerHeight * 0.92)
        );

        this.root.style.width = `${Math.round(width)}px`;
        this.root.style.height = `${Math.round(height)}px`;
        this.root.style.maxWidth = "96vw";
        this.root.style.maxHeight = "92vh";

        if (bottomRight || geometry.left == null || geometry.top == null) {
            this.root.style.left = "auto";
            this.root.style.top = "auto";
            this.root.style.right = "16px";
            this.root.style.bottom = "16px";
            return;
        }

        this.root.style.left = `${Math.round(clamp(geometry.left, 0, Math.max(0, window.innerWidth - width)))}px`;
        this.root.style.top = `${Math.round(clamp(geometry.top, 0, Math.max(0, window.innerHeight - height)))}px`;
        this.root.style.right = "auto";
        this.root.style.bottom = "auto";
    }

    private saveGeometry() {
        if (this.closed || this.mode !== "floating") return;
        try {
            const rect = this.root.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const geometry: PlayerGeometry = {
                left: Math.round(rect.left),
                top: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
            };
            localStorage.setItem(GEOMETRY_KEY, JSON.stringify(geometry));
        } catch {
            // Storage can be unavailable in restricted profiles.
        }
    }

    private loadGeometry(): PlayerGeometry {
        try {
            const raw = localStorage.getItem(GEOMETRY_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw) as Partial<PlayerGeometry>;
            const geometry: PlayerGeometry = {};
            for (const key of ["left", "top", "width", "height"] as const) {
                const value = parsed[key];
                if (typeof value === "number" && Number.isFinite(value)) geometry[key] = value;
            }
            return geometry;
        } catch {
            return {};
        }
    }

    private makeDraggable(handle: HTMLElement): () => void {
        let startX = 0;
        let startY = 0;
        let originLeft = 0;
        let originTop = 0;
        let dragging = false;

        const onPointerDown = (event: PointerEvent) => {
            if (this.mode !== "floating") return;
            if ((event.target as HTMLElement).closest("button")) return;
            const rect = this.root.getBoundingClientRect();
            dragging = true;
            startX = event.clientX;
            startY = event.clientY;
            originLeft = rect.left;
            originTop = rect.top;
            this.root.style.left = `${rect.left}px`;
            this.root.style.top = `${rect.top}px`;
            this.root.style.right = "auto";
            this.root.style.bottom = "auto";
            handle.setPointerCapture(event.pointerId);
            event.preventDefault();
        };
        const onPointerMove = (event: PointerEvent) => {
            if (!dragging) return;
            const maxLeft = window.innerWidth - this.root.offsetWidth;
            const maxTop = window.innerHeight - this.root.offsetHeight;
            const left = Math.min(Math.max(0, originLeft + event.clientX - startX), Math.max(0, maxLeft));
            const top = Math.min(Math.max(0, originTop + event.clientY - startY), Math.max(0, maxTop));
            this.root.style.left = `${left}px`;
            this.root.style.top = `${top}px`;
        };
        const onPointerUp = (event: PointerEvent) => {
            if (!dragging) return;
            dragging = false;
            try {
                handle.releasePointerCapture(event.pointerId);
            } catch {
                // ignored
            }
            this.saveGeometry();
        };

        handle.addEventListener("pointerdown", onPointerDown);
        handle.addEventListener("pointermove", onPointerMove);
        handle.addEventListener("pointerup", onPointerUp);
        handle.addEventListener("pointercancel", onPointerUp);

        return () => {
            handle.removeEventListener("pointerdown", onPointerDown);
            handle.removeEventListener("pointermove", onPointerMove);
            handle.removeEventListener("pointerup", onPointerUp);
            handle.removeEventListener("pointercancel", onPointerUp);
        };
    }

    private makeResizable(handle: HTMLElement): () => void {
        let startX = 0;
        let startY = 0;
        let originWidth = 0;
        let originHeight = 0;
        let resizing = false;

        const onPointerDown = (event: PointerEvent) => {
            if (this.mode !== "floating") return;
            resizing = true;
            startX = event.clientX;
            startY = event.clientY;
            originWidth = this.root.offsetWidth;
            originHeight = this.root.offsetHeight;
            this.root.style.right = "auto";
            this.root.style.bottom = "auto";
            const rect = this.root.getBoundingClientRect();
            this.root.style.left = `${rect.left}px`;
            this.root.style.top = `${rect.top}px`;
            handle.setPointerCapture(event.pointerId);
            event.preventDefault();
            event.stopPropagation();
        };
        const onPointerMove = (event: PointerEvent) => {
            if (!resizing) return;
            const maxWidth = window.innerWidth * 0.96;
            const maxHeight = window.innerHeight * 0.92;
            const width = clamp(originWidth + event.clientX - startX, 280, Math.max(280, maxWidth));
            const height = clamp(originHeight + event.clientY - startY, 180, Math.max(180, maxHeight));
            this.root.style.width = `${Math.round(width)}px`;
            this.root.style.height = `${Math.round(height)}px`;
        };
        const onPointerUp = (event: PointerEvent) => {
            if (!resizing) return;
            resizing = false;
            try {
                handle.releasePointerCapture(event.pointerId);
            } catch {
                // ignored
            }
            this.saveGeometry();
        };

        handle.addEventListener("pointerdown", onPointerDown);
        handle.addEventListener("pointermove", onPointerMove);
        handle.addEventListener("pointerup", onPointerUp);
        handle.addEventListener("pointercancel", onPointerUp);

        return () => {
            handle.removeEventListener("pointerdown", onPointerDown);
            handle.removeEventListener("pointermove", onPointerMove);
            handle.removeEventListener("pointerup", onPointerUp);
            handle.removeEventListener("pointercancel", onPointerUp);
        };
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function isVisible(element: HTMLElement): boolean {
    if (element.hidden) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;

    let node: HTMLElement | null = element;
    while (node) {
        if (node.getAttribute("aria-hidden") === "true") return false;
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) <= 0.05) {
            return false;
        }
        node = node.parentElement;
    }
    return true;
}

/**
 * Best-effort locator for the broadcaster's participant tile in Discord's
 * voice view. Discord does not expose a stable user id attribute on tiles, so
 * we look for the display name inside voice/video containers and walk up to
 * the participant tile. Returns null when the voice grid is not on screen,
 * which makes the player pop out.
 */
function findVoiceTile(name: string | undefined, userId?: string): HTMLElement | null {
    const needle = name?.trim();
    if (!needle || needle.length < 2) return null;

    const viewportArea = window.innerWidth * window.innerHeight;
    const tileClass = /(tile|participant|focused|focus|videoWrapper|videoContainer|stream)/i;
    const seen = new Set<HTMLElement>();
    const candidates: Array<{ element: HTMLElement; area: number }> = [];

    const labelOf = (element: HTMLElement): string =>
        `${element.textContent ?? ""} ${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`;

    const addCandidate = (element: HTMLElement | null, allowMissingLabel = false) => {
        if (!element || seen.has(element)) return;
        if (element === document.body || element === document.documentElement) return;
        if (element.closest("[data-bb-player]")) return;
        if (!element.isConnected || !isVisible(element)) return;

        const rect = element.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 120) return;
        // The focused participant can take almost the whole voice view. Do not
        // reject it just because it is much larger than a grid tile.
        if (rect.width > window.innerWidth * 0.995 || rect.height > window.innerHeight * 0.995) return;
        const area = rect.width * rect.height;
        if (area > viewportArea * 0.97) return;

        if (!allowMissingLabel && !labelOf(element).includes(needle)) return;

        // Reject whole voice grids / call containers. A focused tile contains
        // one participant name and one video; a grid contains many.
        const videos = element.querySelectorAll("video").length;
        if (videos > 2) return;
        const tiles = element.querySelectorAll('[class*="tile"]').length;
        if (tiles > 1) return;
        const names = element.querySelectorAll('[class*="participantName"], [class*="userName"], [class*="username"]').length;
        if (names > 1) return;
        if ((element.textContent ?? "").length > needle.length + 500) return;

        seen.add(element);
        candidates.push({ element, area });
    };

    // Discord usually exposes the participant/user id on the tile or one of
    // its children. This is the only reliable way to follow the same user when
    // the focused tile no longer renders the name overlay.
    if (userId) {
        const uid = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(userId) : userId.replace(/["\\]/g, "\\$&");
        const idSelector = [
            `[data-list-item-id*="${uid}"]`,
            `[data-user-id*="${uid}"]`,
            `[data-userid*="${uid}"]`,
            `[data-member-id*="${uid}"]`,
            `[data-userid="${uid}"]`
        ].join(",");
        for (const element of Array.from(document.querySelectorAll<HTMLElement>(idSelector))) {
            let node: HTMLElement | null = element;
            for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
                if (tileClass.test(typeof node.className === "string" ? node.className : "") || node.querySelector("video")) {
                    addCandidate(node, true);
                }
                if (node === document.body) break;
            }
        }
    }

    // Walk up from the visible participant name. Discord's focused view can
    // hide the name overlay, but when it is present this is the cheapest path.
    const nameSelector = '[class*="participantName"], [class*="userName"], [class*="username"], [class*="userTag"]';
    for (const nameElement of Array.from(document.querySelectorAll<HTMLElement>(nameSelector))) {
        if (!isVisible(nameElement) || !labelOf(nameElement).includes(needle)) continue;
        let node: HTMLElement | null = nameElement.parentElement;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
            if (tileClass.test(typeof node.className === "string" ? node.className : "") || node.querySelector("video")) {
                addCandidate(node);
            }
            if (node === document.body) break;
        }
    }

    // Last resort: follow the video element up to its tile. The focused tile
    // still has a video even when its name label is rendered in a separate
    // overlay, outside the tile element.
    for (const video of Array.from(document.querySelectorAll<HTMLVideoElement>("video"))) {
        if (video.closest("[data-bb-player]") || !isVisible(video)) continue;
        let node: HTMLElement | null = video.parentElement;
        for (let depth = 0; node && depth < 10; depth++, node = node.parentElement) {
            if (tileClass.test(typeof node.className === "string" ? node.className : "") || labelOf(node).includes(needle)) {
                addCandidate(node);
            }
            if (node === document.body) break;
        }
    }

    // Explicit focused containers are useful when their class does not contain
    // "tile" or "video".
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('[class*="focused"], [class*="focus"]'))) {
        addCandidate(element);
    }

    let best: HTMLElement | null = null;
    let bestArea = 0;
    for (const candidate of candidates) {
        if (candidate.area > bestArea) {
            best = candidate.element;
            bestArea = candidate.area;
        }
    }
    return best;
}
