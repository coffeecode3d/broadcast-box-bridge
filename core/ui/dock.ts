import { RESOLUTIONS, FPS_CHOICES } from "../config";
import type { BBConfig, BridgeSnapshot, EncoderId, VoiceMember } from "../types";
import { formatElapsed, h, option } from "./dom";
import { DOCK_CSS } from "./styles";

export interface DockController {
    snapshot(): BridgeSnapshot;
    subscribe(listener: () => void): () => void;
    updateConfig(patch: Partial<BBConfig>): void;
    startPublish(): void;
    stopPublish(): void;
    watch(userId: string): void;
    copy(text: string): void;
    refresh(): void;
}

const ENCODER_LABELS: Record<Exclude<EncoderId, "auto">, string> = {
    vaapi: "VAAPI (AMD/Intel GPU)",
    nvenc: "NVENC (NVIDIA GPU)",
    qsv: "Quick Sync (Intel GPU)",
    amf: "AMF (AMD GPU)",
    x264: "x264 (CPU)"
};

export class Dock {
    private host: HTMLElement;
    private shadow: ShadowRoot;
    private root!: HTMLElement;
    private fab!: HTMLButtonElement;
    private fabDot!: HTMLElement;
    private panel!: HTMLElement;
    private subEl!: HTMLElement;
    private keyEl!: HTMLElement;
    private badgeEl!: HTMLElement;
    private elapsedEl!: HTMLElement;
    private primaryBtn!: HTMLButtonElement;
    private resolutionSelect!: HTMLSelectElement;
    private fpsSelect!: HTMLSelectElement;
    private audioSelect!: HTMLSelectElement;
    private appRow!: HTMLElement;
    private appSelect!: HTMLSelectElement;
    private appSignature = "";
    private audioPlatformSignature = "";
    private errorEl!: HTMLElement;
    private warnEl!: HTMLElement;
    private memberList!: HTMLUListElement;
    private memberCount!: HTMLElement;
    private membersEmpty!: HTMLElement;
    private settingsEl!: HTMLElement;
    private generalEl!: HTMLElement;
    private advancedEl!: HTMLElement;
    private generalTab!: HTMLButtonElement;
    private advancedTab!: HTMLButtonElement;
    private sourceSelect!: HTMLSelectElement;
    private screenRow!: HTMLElement;
    private windowRow!: HTMLElement;
    private windowSelect!: HTMLSelectElement;
    private windowHint!: HTMLElement;
    private serverInput!: HTMLInputElement;
    private encoderSelect!: HTMLSelectElement;
    private codecSelect!: HTMLSelectElement;
    private bitrateInput!: HTMLInputElement;
    private monitorSelect!: HTMLSelectElement;
    private regionInput!: HTMLInputElement;
    private audioDeviceInput!: HTMLInputElement;
    private pollInput!: HTMLInputElement;
    private autoWatchInput!: HTMLInputElement;
    private onlyInVoiceInput!: HTMLInputElement;
    private diagnosticsInput!: HTMLInputElement;
    private footerEncoder!: HTMLElement;
    private logsEl!: HTMLElement;
    private logsPre!: HTMLPreElement;

    private expanded = false;
    private settingsOpen = false;
    private settingsTab: "general" | "advanced" = "general";
    private logsOpen = false;
    private memberSignature = "";
    private unsubscribe: (() => void) | null = null;
    private mounted = false;

    constructor(private readonly controller: DockController) {
        this.host = document.createElement("div");
        this.host.setAttribute("data-bb-dock", "");
        this.shadow = this.host.attachShadow({ mode: "open" });
        this.build();
    }

    mount(point: HTMLElement = document.body) {
        if (this.mounted) return;
        this.mounted = true;
        point.append(this.host);
        this.unsubscribe = this.controller.subscribe(() => this.update());
        this.update();
    }

    destroy() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.host.remove();
        this.mounted = false;
    }

    private build() {
        const style = h("style", { text: DOCK_CSS });

        this.fabDot = h("span", { class: "bb-dot" });
        this.fab = h("button", {
            class: "bb-fab",
            title: "Broadcast Box",
            on: { click: () => this.setExpanded(!this.expanded) }
        }, ["BB", this.fabDot]);

        this.subEl = h("small", { class: "bb-sub", text: "Not in a voice channel" });
        const gearBtn = h("button", {
            class: "bb-icon",
            title: "Settings",
            text: "⚙",
            on: {
                click: () => {
                    this.settingsOpen = !this.settingsOpen;
                    this.settingsEl.hidden = !this.settingsOpen;
                    if (this.settingsOpen) this.showSettingsTab("general");
                    else this.closeLogs();
                }
            }
        });
        const collapseBtn = h("button", {
            class: "bb-icon",
            title: "Collapse",
            text: "–",
            on: { click: () => this.setExpanded(false) }
        });
        const head = h("div", { class: "bb-head" }, [
            h("div", { class: "bb-logo", text: "BB" }),
            h("div", { class: "bb-title" }, [
                h("b", { text: "Broadcast Box" }),
                this.subEl
            ]),
            gearBtn,
            collapseBtn
        ]);

        this.keyEl = h("span", { class: "bb-kv bb-key", text: "—" });
        this.badgeEl = h("span", { class: "bb-badge", text: "Offline" });
        this.elapsedEl = h("span", { class: "bb-v", text: "" });
        const copyBtn = h("button", {
            class: "bb-icon",
            title: "Copy stream key",
            text: "⧉",
            on: { click: () => this.controller.copy(this.keyEl.textContent || "") }
        });
        const streamRow = h("div", { class: "bb-between" }, [
            h("div", { class: "bb-kv" }, [
                h("span", { class: "bb-k", text: "Stream key" }),
                this.keyEl
            ]),
            copyBtn,
            this.badgeEl,
            this.elapsedEl
        ]);

        this.primaryBtn = h("button", {
            class: "bb-btn primary bb-primary",
            text: "Start sharing",
            on: { click: () => this.onPrimary() }
        }) as HTMLButtonElement;

        this.resolutionSelect = this.createSelect(
            RESOLUTIONS.map(r => option(r.value, r.label)),
            value => this.controller.updateConfig({ resolution: value as BBConfig["resolution"] })
        );
        this.fpsSelect = this.createSelect(
            FPS_CHOICES.map(fps => option(String(fps), `${fps} fps`)),
            value => this.controller.updateConfig({ fps: Number(value) })
        );
        this.audioSelect = this.createSelect([], value => {
            if (value === "system-exclude") {
                this.controller.updateConfig({ audio: "system", audioExcludeDiscord: true });
            } else if (value === "system") {
                this.controller.updateConfig({ audio: "system", audioExcludeDiscord: false });
            } else if (value === "app") {
                const snapshot = this.controller.snapshot();
                if (snapshot.capabilities?.platform === "linux") {
                    const apps = snapshot.capabilities?.audio.apps ?? [];
                    const app = apps.find(item => item.id === snapshot.config.audioApp) ?? apps[0];
                    this.controller.updateConfig({ audio: "app", audioApp: app?.id ?? "" });
                } else {
                    this.controller.updateConfig({ audio: "app" });
                }
            } else {
                this.controller.updateConfig({ audio: value as BBConfig["audio"] });
            }
        });
        this.appSelect = this.createSelect([], value => this.controller.updateConfig({ audioApp: value }));
        this.appRow = h("label", { class: "bb-field" }, [
            h("span", { text: "Application" }),
            this.appSelect
        ]);
        const quick = h("div", { class: "bb-quick" }, [
            h("label", { class: "bb-field" }, [h("span", { text: "Resolution" }), this.resolutionSelect]),
            h("label", { class: "bb-field" }, [h("span", { text: "Frame rate" }), this.fpsSelect]),
            h("label", { class: "bb-field" }, [h("span", { text: "Audio" }), this.audioSelect]),
            this.appRow
        ]);

        this.errorEl = h("div", { class: "bb-error", hidden: true });
        this.warnEl = h("div", { class: "bb-warn", hidden: true });

        this.memberCount = h("span", { class: "bb-count", text: "0" });
        this.memberList = h("ul", { class: "bb-members" });
        this.membersEmpty = h("div", { class: "bb-empty", text: "Join a voice channel to see streams from other members." });
        const watchSection = h("div", { attrs: { style: "display:grid;gap:6px" } }, [
            h("div", { class: "bb-section-title" }, [h("span", { text: "Watch" }), this.memberCount]),
            this.membersEmpty,
            this.memberList
        ]);

        this.serverInput = this.createInput("url", "https://your-broadcast-box.example", value =>
            this.controller.updateConfig({ server: value })
        );
        this.encoderSelect = this.createSelect([option("auto", "Automatic")], value =>
            this.controller.updateConfig({ encoder: value as EncoderId })
        );
        this.codecSelect = this.createSelect(
            [
                option("h264", "H.264 / AVC (supported)"),
                option("hevc", "H.265 / HEVC (needs GStreamer)", true),
                option("vp9", "VP9 (needs GStreamer)", true),
                option("av1", "AV1 (needs GStreamer)", true)
            ],
            () => this.controller.updateConfig({ codec: "h264" })
        );
        this.bitrateInput = this.createInput("number", "9500 (0 = automatic)", value =>
            this.controller.updateConfig({ bitrateKbps: Math.max(0, Number(value) || 0) }),
            { min: "0", max: "100000", step: "500" }
        );
        this.monitorSelect = this.createSelect([option("", "Automatic")], value =>
            this.controller.updateConfig({ monitor: value })
        );
        this.sourceSelect = this.createSelect([option("screen", "Screen"), option("window", "Window")], value => {
            this.controller.updateConfig({ capture: value as BBConfig["capture"] });
            this.updateSourceRows();
        });
        this.windowSelect = this.createSelect([], value => this.controller.updateConfig({ window: value }));
        this.screenRow = h("label", { class: "bb-field" }, [h("span", { text: "Screen" }), this.monitorSelect]);
        this.windowHint = h("div", { class: "bb-hint bb-window-hint", text: "" });
        this.windowRow = h("label", { class: "bb-field", hidden: true }, [
            h("span", { text: "Window" }),
            this.windowSelect,
            this.windowHint
        ]);
        this.regionInput = this.createInput("text", "0,0 1920x1080 (optional)", value =>
            this.controller.updateConfig({ region: value })
        );
        this.audioDeviceInput = this.createInput("text", "Default device (optional)", value =>
            this.controller.updateConfig({ audioDevice: value })
        );
        this.pollInput = this.createInput("number", "10", value =>
            this.controller.updateConfig({ pollIntervalMs: (Number(value) || 10) * 1000 }),
            { min: "5", max: "60", step: "1" }
        );
        this.autoWatchInput = h("input", {
            attrs: { type: "checkbox" },
            on: { change: () => this.controller.updateConfig({ autoWatchSelf: this.autoWatchInput.checked }) }
        });
        this.onlyInVoiceInput = h("input", {
            attrs: { type: "checkbox" },
            on: { change: () => this.controller.updateConfig({ onlyInVoice: this.onlyInVoiceInput.checked }) }
        });
        this.diagnosticsInput = h("input", {
            attrs: { type: "checkbox" },
            on: { change: () => this.controller.updateConfig({ showDiagnostics: this.diagnosticsInput.checked }) }
        });

        this.generalTab = h("button", {
            class: "bb-tab active",
            text: "General",
            on: { click: () => this.showSettingsTab("general") }
        }) as HTMLButtonElement;
        this.advancedTab = h("button", {
            class: "bb-tab",
            text: "Advanced",
            on: { click: () => this.showSettingsTab("advanced") }
        }) as HTMLButtonElement;

        this.generalEl = h("div", { class: "bb-tab-panel" }, [
            h("label", { class: "bb-field" }, [h("span", { text: "Source" }), this.sourceSelect]),
            this.screenRow,
            this.windowRow,
            h("label", { class: "bb-field" }, [
                h("span", { text: "Bitrate (kbps)" }),
                this.bitrateInput,
                h("div", { class: "bb-hint", text: "9500 kbps by default. Enter 0 to choose automatically." })
            ]),
            h("label", { class: "bb-check" }, [
                this.autoWatchInput,
                h("span", {}, [
                    h("span", { text: "Open a preview of my stream when I start sharing" }),
                    h("div", { class: "bb-hint", text: "Opens in a resizable floating window." })
                ])
            ]),
            h("label", { class: "bb-check" }, [
                this.onlyInVoiceInput,
                h("span", {}, [
                    h("span", { text: "Only show the dock in voice channels" }),
                    h("div", { class: "bb-hint", text: "The floating button is hidden everywhere else." })
                ])
            ])
        ]);

        this.advancedEl = h("div", { class: "bb-tab-panel", hidden: true }, [
            h("label", { class: "bb-field" }, [h("span", { text: "Server" }), this.serverInput]),
            h("div", { class: "bb-settings-grid" }, [
                h("label", { class: "bb-field" }, [h("span", { text: "Encoder" }), this.encoderSelect]),
                h("label", { class: "bb-field" }, [h("span", { text: "Codec" }), this.codecSelect])
            ]),
            h("label", { class: "bb-field" }, [h("span", { text: "Capture region" }), this.regionInput]),
            h("label", { class: "bb-field" }, [h("span", { text: "Audio device override" }), this.audioDeviceInput]),
            h("label", { class: "bb-field" }, [h("span", { text: "Status refresh (seconds)" }), this.pollInput]),
            h("label", { class: "bb-check" }, [
                this.diagnosticsInput,
                h("span", {}, [
                    h("span", { text: "Show diagnostics" }),
                    h("div", {
                        class: "bb-hint",
                        text: "Shows capture and encoder warnings in the share panel. Off by default."
                    })
                ])
            ]),
            h("div", { class: "bb-hint", text: "Codec choices are limited to H.264 because FFmpeg's WHIP muxer only supports H.264 and Opus." })
        ]);

        this.settingsEl = h("div", { class: "bb-settings", hidden: true }, [
            h("div", { class: "bb-tabs" }, [this.generalTab, this.advancedTab]),
            this.generalEl,
            this.advancedEl
        ]);

        this.footerEncoder = h("span", { text: "Encoder: detecting…" });
        const logsBtn = h("button", {
            class: "bb-link",
            text: "Logs",
            on: { click: () => this.toggleLogs() }
        });
        const foot = h("div", { class: "bb-foot" }, [this.footerEncoder, logsBtn]);

        this.logsPre = h("pre", { text: "" });
        const logsHead = h("div", { class: "bb-between" }, [
            h("span", { text: "Publishing log" }),
            h("button", { class: "bb-link", text: "Close", on: { click: () => this.closeLogs() } })
        ]);
        this.logsEl = h("div", { class: "bb-logs", hidden: true }, [logsHead, this.logsPre]);

        const body = h("div", { class: "bb-body" }, [
            streamRow,
            this.primaryBtn,
            quick,
            this.errorEl,
            this.warnEl,
            watchSection,
            this.settingsEl,
            foot
        ]);

        this.panel = h("section", { class: "bb-panel", hidden: true }, [head, body, this.logsEl]);
        this.root = h("div", { class: "bb-root" }, [this.panel, this.fab]);
        this.shadow.append(style, this.root);
    }

    showServerSettings(): void {
        this.setExpanded(true);
        this.showSettingsTab("advanced");
        this.serverInput.focus();
        this.serverInput.select();
    }

    private setExpanded(expanded: boolean) {
        this.expanded = expanded;
        this.panel.hidden = !expanded;
        this.fab.title = expanded ? "Hide Broadcast Box" : "Open Broadcast Box";
        if (expanded) {
            this.controller.refresh();
            this.update();
        } else {
            this.closeLogs();
        }
    }

    private showSettingsTab(tab: "general" | "advanced") {
        this.settingsTab = tab;
        this.generalEl.hidden = tab !== "general";
        this.advancedEl.hidden = tab !== "advanced";
        this.generalTab.classList.toggle("active", tab === "general");
        this.advancedTab.classList.toggle("active", tab === "advanced");
    }

    private updateSourceRows() {
        const windowMode = this.sourceSelect.value === "window";
        this.screenRow.hidden = windowMode;
        this.windowRow.hidden = !windowMode;
    }

    private toggleLogs() {
        this.logsOpen = !this.logsOpen;
        this.logsEl.hidden = !this.logsOpen;
        if (this.logsOpen) this.updateLogs();
    }

    private closeLogs() {
        this.logsOpen = false;
        this.logsEl.hidden = true;
    }

    private onPrimary() {
        const snapshot = this.controller.snapshot();
        if (snapshot.publishing.running || snapshot.busy) {
            this.controller.stopPublish();
        } else {
            this.controller.startPublish();
        }
    }

    private update() {
        const snapshot = this.controller.snapshot();
        const { config, capabilities, publishing } = snapshot;

        const hiddenByPolicy = config.onlyInVoice && !snapshot.voiceChannelId;
        this.root.hidden = hiddenByPolicy;
        this.fab.hidden = this.expanded && !hiddenByPolicy;

        this.fabDot.className = "bb-dot";
        if (snapshot.publishLive) this.fabDot.classList.add("live");
        else if (publishing.running) this.fabDot.classList.add("busy");
        else if (publishing.error) this.fabDot.classList.add("error");

        this.subEl.textContent = snapshot.voiceChannelId
            ? snapshot.voiceChannelName || "Voice channel"
            : "Not in a voice channel";

        this.keyEl.textContent = snapshot.selfKey ?? "—";
        this.keyEl.title = snapshot.selfKey ?? "";

        this.badgeEl.className = "bb-badge";
        if (snapshot.publishLive) {
            this.badgeEl.classList.add("on");
            this.badgeEl.textContent = "Live";
        } else if (snapshot.busy) {
            this.badgeEl.textContent = "Starting";
        } else if (publishing.running) {
            this.badgeEl.textContent = "Connecting";
        } else {
            this.badgeEl.classList.add("off");
            this.badgeEl.textContent = "Offline";
        }

        this.elapsedEl.textContent =
            publishing.running && publishing.startedAt ? formatElapsed(Date.now() - publishing.startedAt) : "";

        this.primaryBtn.textContent = publishing.running ? "Stop sharing" : snapshot.busy ? "Starting…" : "Start sharing";
        this.primaryBtn.className = publishing.running
            ? "bb-btn danger bb-primary"
            : "bb-btn primary bb-primary";
        this.primaryBtn.disabled = snapshot.busy || (!publishing.running && !snapshot.voiceChannelId);

        this.setSelectValue(this.resolutionSelect, config.resolution);
        this.setSelectValue(this.fpsSelect, String(config.fps));
        this.updateAudioOptions(snapshot);
        this.setSelectValue(
            this.audioSelect,
            config.audio === "system" && config.audioExcludeDiscord && snapshot.capabilities?.platform === "linux"
                ? "system-exclude"
                : config.audio
        );

        const error = snapshot.error || publishing.error || "";
        this.errorEl.hidden = !error;
        this.errorEl.textContent = error;

        const warnings = [...(publishing.warnings ?? []), ...(capabilities?.warnings ?? [])];
        const warningText = warnings.filter(Boolean).join("\n");
        this.warnEl.hidden = !config.showDiagnostics || !warningText;
        this.warnEl.textContent = warningText;

        const selfId = snapshot.selfUserId;
        const selfMember: VoiceMember | null = snapshot.voiceChannelId
            ? { userId: selfId, name: `${this.selfName(snapshot)} (you)` }
            : null;
        const members = selfMember ? [selfMember, ...snapshot.members.filter(m => m.userId !== selfId)] : snapshot.members;
        this.updateMembers(members, snapshot);

        this.memberCount.textContent = String(
            members.filter(m => snapshot.live[m.userId]?.isOnline).length
        );
        this.membersEmpty.hidden = Boolean(snapshot.voiceChannelId);

        const encoder = config.encoder === "auto"
            ? capabilities?.recommendedEncoder ?? "auto"
            : config.encoder;
        this.footerEncoder.textContent = `Encoder: ${encoder} · ${config.codec.toUpperCase()}`;

        if (!this.serverInput.matches(":focus")) this.serverInput.value = config.server;
        this.updateEncoderOptions(capabilities, config.encoder);
        this.setSelectValue(this.codecSelect, "h264");
        if (!this.bitrateInput.matches(":focus")) this.bitrateInput.value = String(config.bitrateKbps);
        this.updateSourceOptions(snapshot);
        if (!this.regionInput.matches(":focus")) this.regionInput.value = config.region;
        if (!this.audioDeviceInput.matches(":focus")) this.audioDeviceInput.value = config.audioDevice;
        if (!this.pollInput.matches(":focus")) this.pollInput.value = String(Math.round(config.pollIntervalMs / 1000));
        this.autoWatchInput.checked = config.autoWatchSelf;
        this.onlyInVoiceInput.checked = config.onlyInVoice;
        this.diagnosticsInput.checked = config.showDiagnostics;

        if (this.logsOpen) this.updateLogs();
    }

    private selfName(snapshot: BridgeSnapshot): string {
        return snapshot.members.find(m => m.userId === snapshot.selfUserId)?.name ?? "You";
    }

    private updateAudioOptions(snapshot: BridgeSnapshot): void {
        const capabilities = snapshot.capabilities;
        const platform = capabilities?.platform ?? "none";
        const apps = capabilities?.audio.apps ?? [];
        const platformSignature = `${platform}:${apps.length ? "apps" : "none"}:${capabilities?.audio.devices?.length ?? 0}`;
        if (platformSignature !== this.audioPlatformSignature) {
            this.audioPlatformSignature = platformSignature;
            const options = [option("mic", "Microphone")];
            if (platform === "linux") {
                options.push(
                    option(
                        "system-exclude",
                        apps.length ? "System audio (no Discord)" : "System audio (no Discord, nothing playing)",
                        !apps.length
                    )
                );
                options.push(option("app", "Application audio"));
            }
            options.push(
                option("system", platform === "linux" ? "System audio (everything)" : "System audio"),
                ...(platform === "win32"
                    ? [
                          option(
                              "app",
                              "Application audio (virtual cable)",
                              !(capabilities?.audio.devices?.length)
                          )
                      ]
                    : []),
                option("none", "No audio")
            );
            this.audioSelect.replaceChildren(...options);
        }

        const signature = apps.map(app => `${app.id}:${app.name}:${app.nodes.length}`).join("|");
        if (signature !== this.appSignature) {
            this.appSignature = signature;
            this.appSelect.replaceChildren();
            if (apps.length) {
                for (const app of apps) this.appSelect.append(option(app.id, app.name));
            } else {
                this.appSelect.append(option("", "No applications playing", true));
            }
        }

        this.appRow.hidden = snapshot.config.audio !== "app" || snapshot.capabilities?.platform !== "linux";
        if (snapshot.config.audio === "app" && snapshot.capabilities?.platform === "linux") {
            const exists = apps.some(app => app.id === snapshot.config.audioApp);
            this.setSelectValue(this.appSelect, exists ? snapshot.config.audioApp : apps[0]?.id ?? "");
        }
    }

    private updateMembers(members: VoiceMember[], snapshot: BridgeSnapshot) {
        const signature = members
            .map(m => `${m.userId}:${m.name}:${snapshot.live[m.userId]?.isOnline ? 1 : 0}:${snapshot.live[m.userId] ? 1 : 0}`)
            .join("|");
        if (signature === this.memberSignature) return;
        this.memberSignature = signature;
        this.memberList.replaceChildren();

        if (!snapshot.voiceChannelId) return;

        for (const member of members) {
            const status = snapshot.live[member.userId];
            const live = Boolean(status?.isOnline);
            const watching = snapshot.watch?.userId === member.userId;
            const avatar = h("div", { class: "bb-avatar", text: initials(member.name) });
            if (member.avatarUrl) {
                avatar.style.backgroundImage = `url("${member.avatarUrl.replace(/"/g, "%22")}")`;
                avatar.textContent = "";
            }
            const name = h("span", { class: "bb-member-name" }, [
                member.name,
                snapshot.selfUserId === member.userId ? h("small", { text: " · you" }) : "",
                live && status?.viewers ? h("small", { text: ` · ${status.viewers} watching` }) : ""
            ]);
            const badge = h("span", {
                class: `bb-badge ${live ? "on" : "off"}`,
                text: live ? "Live" : "—"
            });
            const button = h("button", {
                class: "bb-btn",
                text: watching ? "Watching" : "Watch",
                disabled: !live || watching,
                on: { click: () => this.controller.watch(member.userId) }
            });
            this.memberList.append(h("li", { class: "bb-member" }, [avatar, name, badge, button]));
        }
    }

    private updateLogs() {
        const snapshot = this.controller.snapshot();
        const lines = snapshot.publishing.logs ?? [];
        const text = lines.slice(-120).join("\n");
        if (this.logsPre.textContent !== text) {
            this.logsPre.textContent = text || "(no log output yet)";
            this.logsPre.scrollTop = this.logsPre.scrollHeight;
        }
    }

    private updateEncoderOptions(capabilities: BridgeSnapshot["capabilities"], selected: EncoderId) {
        const available = capabilities?.availableEncoders ?? [];
        const signature = `auto:${available.join(",")}`;
        if (this.encoderSelect.dataset.signature !== signature) {
            this.encoderSelect.dataset.signature = signature;
            this.encoderSelect.replaceChildren(option("auto", "Automatic"));
            for (const encoder of available) {
                this.encoderSelect.append(option(encoder, ENCODER_LABELS[encoder]));
            }
            if (!available.includes("x264")) this.encoderSelect.append(option("x264", ENCODER_LABELS.x264));
        }
        this.setSelectValue(this.encoderSelect, selected);
    }

    private updateSourceOptions(snapshot: BridgeSnapshot) {
        const capabilities = snapshot.capabilities;
        const displays = capabilities?.displays ?? [];
        const windows = capabilities?.windows ?? [];
        const portal = capabilities?.capture.windowMethod === "wayland-portal";
        const canWindow = Boolean(capabilities?.capture.window);

        const displaySignature = displays.map(d => `${d.name}:${d.width}x${d.height}`).join(",");
        if (this.monitorSelect.dataset.signature !== displaySignature) {
            this.monitorSelect.dataset.signature = displaySignature;
            this.monitorSelect.replaceChildren(option("", "Automatic"));
            for (const display of displays) {
                this.monitorSelect.append(option(display.name, `${display.name} (${display.width}x${display.height})`));
            }
        }
        this.setSelectValue(this.monitorSelect, snapshot.config.monitor);

        const sourceSignature = `${canWindow}:${portal}`;
        if (this.sourceSelect.dataset.signature !== sourceSignature) {
            this.sourceSelect.dataset.signature = sourceSignature;
            this.sourceSelect.replaceChildren(
                option("screen", "Screen"),
                option(
                    "window",
                    canWindow ? (portal ? "Window (system picker)" : "Window") : "Window (not available)",
                    !canWindow
                )
            );
        }

        if (portal) {
            const signature = "portal";
            if (this.windowSelect.dataset.signature !== signature) {
                this.windowSelect.dataset.signature = signature;
                this.windowSelect.replaceChildren(option("", "Choose a window when sharing starts", true));
            }
            this.windowSelect.disabled = true;
            this.windowHint.textContent =
                "The system window picker opens when you start sharing. Capturing follows the window if it moves.";
        } else {
            const windowSignature = windows.map(window => `${window.id}:${window.app}:${window.title}`).join(",");
            if (this.windowSelect.dataset.signature !== windowSignature) {
                this.windowSelect.dataset.signature = windowSignature;
                this.windowSelect.replaceChildren();
                if (windows.length) {
                    for (const window of windows) {
                        this.windowSelect.append(
                            option(window.id, window.app ? `${window.app} · ${window.title}` : window.title)
                        );
                    }
                } else {
                    this.windowSelect.append(option("", "No windows found", true));
                }
            }
            this.windowSelect.disabled = !windows.length;
            this.windowHint.textContent = windows.length ? "" : "No capturable windows were found.";
            this.setSelectValue(
                this.windowSelect,
                windows.some(window => window.id === snapshot.config.window)
                    ? snapshot.config.window
                    : windows[0]?.id ?? ""
            );
        }

        const source = snapshot.config.capture === "window" && canWindow ? "window" : "screen";
        this.setSelectValue(this.sourceSelect, source);
        this.updateSourceRows();
    }

    private setSelectValue(select: HTMLSelectElement, value: string) {
        if (select.value !== value) select.value = value;
    }

    private createSelect(options: HTMLOptionElement[], onChange: (value: string) => void): HTMLSelectElement {
        const select = h("select", { on: { change: () => onChange(select.value) } }) as HTMLSelectElement;
        for (const item of options) select.append(item);
        return select;
    }

    private createInput(
        type: string,
        placeholder: string,
        onChange: (value: string) => void,
        attrs: Record<string, string> = {}
    ): HTMLInputElement {
        const input = h("input", {
            type,
            placeholder,
            attrs: { spellcheck: "false", ...attrs },
            on: {
                change: () => onChange(input.value),
                keydown: (event: Event) => {
                    if ((event as KeyboardEvent).key === "Enter") {
                        (event.target as HTMLInputElement).blur();
                    }
                }
            }
        }) as HTMLInputElement;
        return input;
    }
}

function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
