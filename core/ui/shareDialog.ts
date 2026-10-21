import { FPS_CHOICES, RESOLUTIONS } from "../config";
import type { BBConfig, BridgeSnapshot, Capabilities } from "../types";
import { h, option } from "./dom";
import { DIALOG_CSS } from "./styles";

/**
 * Discord-style "what do you want to share?" sheet shown before every publish.
 * Keeping the source/audio choice here means users never have to dig through
 * the dock settings just to start a stream.
 */
export class ShareDialog {
    private host: HTMLElement;
    private shadow: ShadowRoot;
    private overlay!: HTMLElement;
    private subtitle!: HTMLElement;
    private sourceSelect!: HTMLSelectElement;
    private screenRow!: HTMLElement;
    private windowRow!: HTMLElement;
    private screenSelect!: HTMLSelectElement;
    private windowSelect!: HTMLSelectElement;
    private windowHint!: HTMLElement;
    private resolutionSelect!: HTMLSelectElement;
    private bitrateInput!: HTMLInputElement;
    private serverInput!: HTMLInputElement;
    private advancedEl!: HTMLElement;
    private advancedToggle!: HTMLButtonElement;
    private advancedOpen = false;
    private fpsSelect!: HTMLSelectElement;
    private audioSelect!: HTMLSelectElement;
    private appRow!: HTMLElement;
    private appSelect!: HTMLSelectElement;
    private appHint!: HTMLElement;
    private audioHint!: HTMLElement;
    private deviceRow!: HTMLElement;
    private deviceInput!: HTMLInputElement;
    private deviceList!: HTMLDataListElement;
    private deviceHint!: HTMLElement;
    private previewInput!: HTMLInputElement;
    private diagnosticsInput!: HTMLInputElement;
    private startBtn!: HTMLButtonElement;

    private capabilities: Capabilities | null = null;
    private onStart: ((patch: Partial<BBConfig>) => void) | null = null;
    private isOpen = false;

    constructor() {
        this.host = document.createElement("div");
        this.host.setAttribute("data-bb-share-dialog", "");
        this.host.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483002;";
        this.shadow = this.host.attachShadow({ mode: "open" });
        this.build();
    }

    open(snapshot: BridgeSnapshot, onStart: (patch: Partial<BBConfig>) => void): void {
        this.onStart = onStart;
        this.capabilities = snapshot.capabilities;
        this.isOpen = true;

        this.subtitle.textContent = snapshot.voiceChannelName
            ? `Choose what to share with ${snapshot.voiceChannelName}.`
            : "Choose what to share.";

        this.fillSources(snapshot);
        this.fillScreens(snapshot);
        this.fillWindows(snapshot.config);
        this.fillResolutions(snapshot.config);
        this.fillFps(snapshot.config);
        this.fillAudio(snapshot.config);
        this.fillApps(snapshot.config);
        this.fillDeviceList();

        this.deviceInput.value = snapshot.config.audioDevice;
        this.previewInput.checked = snapshot.config.autoWatchSelf;
        this.diagnosticsInput.checked = snapshot.config.showDiagnostics;
        this.bitrateInput.value = String(snapshot.config.bitrateKbps);
        this.serverInput.value = snapshot.config.server;
        this.advancedOpen = false;
        this.advancedEl.hidden = true;
        this.advancedToggle.textContent = "Advanced options";
        this.updateSourceUi();
        this.updateAudioUi(this.audioSelect.value);

        if (!this.host.isConnected) document.body.append(this.host);
        this.overlay.hidden = false;
        document.addEventListener("keydown", this.onKeyDown, true);
        this.startBtn.focus();
    }

    close(): void {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.overlay.hidden = true;
        document.removeEventListener("keydown", this.onKeyDown, true);
        this.onStart = null;
    }

    destroy(): void {
        this.close();
        this.host.remove();
    }

    private readonly onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            this.close();
        }
    };

    private build(): void {
        const style = h("style", { text: DIALOG_CSS });

        this.subtitle = h("p", { text: "" });
        const head = h("div", { class: "bb-modal-head" }, [
            h("h2", { text: "Share your screen" }),
            this.subtitle
        ]);

        this.sourceSelect = this.createSelect();
        this.sourceSelect.addEventListener("change", () => this.updateSourceUi());
        this.screenSelect = this.createSelect();
        this.windowSelect = this.createSelect();
        this.resolutionSelect = this.createSelect();
        this.fpsSelect = this.createSelect();
        this.audioSelect = this.createSelect();
        this.audioSelect.addEventListener("change", () => this.updateAudioUi(this.audioSelect.value));
        this.audioHint = h("div", { class: "bb-hint bb-audio-hint", text: "" });

        this.appSelect = this.createSelect();
        this.appSelect.addEventListener("change", () => this.updateAudioUi(this.audioSelect.value));
        this.appHint = h("div", { class: "bb-hint bb-audio-hint", text: "" });
        this.appRow = h("label", { class: "bb-field bb-app-row" }, [
            h("span", { text: "Application" }),
            this.appSelect,
            this.appHint
        ]);

        this.deviceInput = h("input", {
            type: "text",
            placeholder: "Default device (optional)",
            attrs: { spellcheck: "false", list: "bb-audio-devices" }
        }) as HTMLInputElement;
        this.deviceList = document.createElement("datalist");
        this.deviceList.id = "bb-audio-devices";
        this.deviceHint = h("div", { class: "bb-hint bb-audio-hint", text: "" });
        this.deviceRow = h("label", { class: "bb-field bb-device-row" }, [
            h("span", { text: "Audio device override" }),
            this.deviceInput,
            this.deviceHint
        ]);

        this.previewInput = h("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
        this.diagnosticsInput = h("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
        this.bitrateInput = h("input", {
            type: "number",
            placeholder: "9500",
            attrs: { min: "0", max: "100000", step: "500", spellcheck: "false" }
        }) as HTMLInputElement;
        this.serverInput = h("input", {
            type: "url",
            placeholder: "https://your-broadcast-box.example",
            attrs: { spellcheck: "false" }
        }) as HTMLInputElement;
        this.advancedToggle = h("button", {
            class: "bb-link bb-advanced-toggle",
            text: "Advanced options",
            on: { click: () => this.toggleAdvanced() }
        }) as HTMLButtonElement;
        this.advancedEl = h("div", { class: "bb-advanced", hidden: true }, [
            h("label", { class: "bb-field" }, [
                h("span", { text: "Broadcast Box server" }),
                this.serverInput,
                h("div", {
                    class: "bb-hint",
                    text: "Your own Broadcast Box base URL. No server is bundled with the plugin."
                })
            ]),
            h("label", { class: "bb-field" }, [
                h("span", { text: "Bitrate (kbps)" }),
                this.bitrateInput,
                h("div", {
                    class: "bb-hint",
                    text: "9500 kbps by default. Enter 0 to let the plugin choose a bitrate automatically."
                })
            ]),
            this.deviceRow,
            h("label", { class: "bb-check" }, [
                this.diagnosticsInput,
                h("span", {}, [
                    h("span", { text: "Show diagnostics" }),
                    h("div", {
                        class: "bb-hint",
                        text: "Shows capture, encoder, and player diagnostics. Off by default."
                    })
                ])
            ])
        ]);

        this.screenRow = h("label", { class: "bb-field" }, [h("span", { text: "Screen" }), this.screenSelect]);
        this.windowHint = h("div", { class: "bb-hint bb-window-hint", text: "" });
        this.windowRow = h("label", { class: "bb-field", hidden: true }, [
            h("span", { text: "Window" }),
            this.windowSelect,
            this.windowHint
        ]);

        const body = h("div", { class: "bb-modal-body" }, [
            h("label", { class: "bb-field" }, [h("span", { text: "Source" }), this.sourceSelect]),
            this.screenRow,
            this.windowRow,
            h("div", { class: "bb-modal-grid" }, [
                h("label", { class: "bb-field" }, [h("span", { text: "Resolution" }), this.resolutionSelect]),
                h("label", { class: "bb-field" }, [h("span", { text: "Frame rate" }), this.fpsSelect])
            ]),
            h("label", { class: "bb-field" }, [h("span", { text: "Audio" }), this.audioSelect]),
            this.audioHint,
            this.appRow,
            h("label", { class: "bb-check" }, [
                this.previewInput,
                h("span", {}, [
                    h("span", { text: "Show a preview of my stream" }),
                    h("div", {
                        class: "bb-hint",
                        text: "Opens in a resizable floating window you can move anywhere."
                    })
                ])
            ]),
            h("div", { class: "bb-advanced-wrap" }, [this.advancedToggle, this.advancedEl])
        ]);

        const cancelBtn = h("button", {
            class: "bb-btn",
            text: "Cancel",
            on: { click: () => this.close() }
        });
        this.startBtn = h("button", {
            class: "bb-btn primary",
            text: "Start sharing",
            on: { click: () => this.submit() }
        }) as HTMLButtonElement;

        const foot = h("div", { class: "bb-modal-foot" }, [cancelBtn, this.startBtn]);
        const modal = h("div", { class: "bb-modal", attrs: { role: "dialog", "aria-modal": "true" } }, [head, body, foot]);
        this.overlay = h("div", {
            class: "bb-modal-overlay",
            hidden: true,
            on: {
                mousedown: event => {
                    if (event.target === this.overlay) this.close();
                }
            }
        }, [modal]);

        this.shadow.append(style, this.overlay, this.deviceList);
    }

    private fillSources(snapshot: BridgeSnapshot): void {
        const canWindow = Boolean(this.capabilities?.capture.window);
        const portal = this.capabilities?.capture.windowMethod === "wayland-portal";
        this.sourceSelect.replaceChildren(
            option("screen", "Screen"),
            option(
                "window",
                canWindow
                    ? portal
                        ? "Application window (system picker)"
                        : "Application window"
                    : "Application window (not available)",
                !canWindow
            )
        );
        this.sourceSelect.value = snapshot.config.capture === "window" && canWindow ? "window" : "screen";
    }

    private fillWindows(config: BBConfig): void {
        const windows = this.capabilities?.windows ?? [];
        const portal = this.capabilities?.capture.windowMethod === "wayland-portal";
        this.windowSelect.replaceChildren();
        if (portal) {
            this.windowSelect.append(option("", "Choose a window when sharing starts", true));
            this.windowSelect.disabled = true;
            this.windowHint.textContent =
                "A system window picker opens after you press Start sharing. The capture follows the window if it moves or resizes.";
            return;
        }
        if (!windows.length) {
            this.windowSelect.append(option("", "No windows found", true));
            this.windowSelect.disabled = true;
            this.windowHint.textContent = "No capturable windows were found.";
            return;
        }

        this.windowSelect.disabled = false;
        this.windowHint.textContent = "";
        for (const window of windows) {
            const label = window.app ? `${window.app} · ${window.title}` : window.title;
            this.windowSelect.append(option(window.id, label));
        }
        const selected = windows.find(window => window.id === config.window) ?? windows[0];
        this.windowSelect.value = selected.id;
    }

    private updateSourceUi(): void {
        const windowMode = this.sourceSelect.value === "window";
        this.screenRow.hidden = windowMode;
        this.windowRow.hidden = !windowMode;
    }

    private toggleAdvanced(): void {
        this.advancedOpen = !this.advancedOpen;
        this.advancedEl.hidden = !this.advancedOpen;
        this.advancedToggle.textContent = this.advancedOpen ? "Hide advanced options" : "Advanced options";
    }

    private fillScreens(snapshot: BridgeSnapshot): void {
        const displays = this.capabilities?.displays ?? [];
        this.screenSelect.replaceChildren();

        if (!displays.length) {
            this.screenSelect.append(option("", "Entire screen (automatic)"));
            this.screenSelect.value = "";
            return;
        }

        this.screenSelect.append(option("", "Automatic (primary)"));
        for (const display of displays) {
            const size = `${display.width}x${display.height}`;
            this.screenSelect.append(option(display.name, `${display.name} · ${size}`));
        }

        const selected = snapshot.config.monitor;
        this.screenSelect.value = displays.some(display => display.name === selected) ? selected : "";
    }

    private fillResolutions(config: BBConfig): void {
        this.resolutionSelect.replaceChildren();
        for (const preset of RESOLUTIONS) {
            this.resolutionSelect.append(option(preset.value, preset.label));
        }
        this.resolutionSelect.value = config.resolution;
    }

    private fillFps(config: BBConfig): void {
        this.fpsSelect.replaceChildren();
        for (const fps of FPS_CHOICES) {
            this.fpsSelect.append(option(String(fps), `${fps} fps`));
        }
        this.fpsSelect.value = String(config.fps);
    }

    private fillAudio(config: BBConfig): void {
        const audio = this.capabilities?.audio;
        const linux = this.capabilities?.platform === "linux";
        const apps = audio?.apps ?? [];

        const options = [
            option("mic", linux && !audio?.mic ? "Microphone (not found)" : "Microphone", linux && !audio?.mic)
        ];

        if (linux) {
            options.push(
                option(
                    "system-exclude",
                    apps.length
                        ? "System audio (excluding Discord)"
                        : "System audio excluding Discord (nothing playing)",
                    !apps.length
                )
            );
            options.push(
                option(
                    "app",
                    apps.length ? "Application audio (only that app)" : "Application audio (nothing playing)",
                    !apps.length
                )
            );
            options.push(
                option(
                    "system",
                    audio?.monitor ? "System audio (everything, includes Discord)" : "System audio (not found)",
                    !audio?.monitor
                )
            );
        } else {
            options.push(option("system", "System audio (loopback device)"));
            options.push(
                option(
                    "app",
                    audio?.devices?.length
                        ? "Application audio (virtual cable)"
                        : "Application audio (install a virtual cable first)",
                    !audio?.devices?.length
                )
            );
        }

        options.push(option("none", "No audio"));
        this.audioSelect.replaceChildren(...options);

        const preferred =
            linux && config.audio === "system" && config.audioExcludeDiscord
                ? "system-exclude"
                : config.audio;
        const chosen = Array.from(this.audioSelect.options).find(
            item => item.value === preferred && !item.disabled
        );
        let fallback = "none";
        if (linux) {
            if (apps.length) fallback = "system-exclude";
            else if (audio?.monitor) fallback = "system";
            else if (audio?.mic) fallback = "mic";
        } else {
            fallback = "mic";
        }
        this.audioSelect.value = chosen?.value ?? fallback;
    }

    private fillApps(config: BBConfig): void {
        const apps = this.capabilities?.audio?.apps ?? [];
        this.appSelect.replaceChildren();

        if (!apps.length) {
            this.appSelect.append(option("", "No applications are playing audio", true));
            this.appSelect.disabled = true;
            return;
        }

        this.appSelect.disabled = false;
        for (const app of apps) {
            this.appSelect.append(option(app.id, app.name));
        }
        const preferred = apps.find(app => app.id === config.audioApp) ?? apps[0];
        this.appSelect.value = preferred.id;
    }

    private fillDeviceList(): void {
        const devices = this.capabilities?.audio.devices ?? [];
        this.deviceList.replaceChildren();
        for (const device of devices) {
            this.deviceList.append(h("option", { value: device }));
        }
    }

    private updateAudioUi(mode: string): void {
        const audio = this.capabilities?.audio;
        const linux = this.capabilities?.platform === "linux";
        const device = this.deviceInput.value.trim();

        this.appRow.hidden = mode !== "app" || !linux;
        this.deviceRow.hidden = mode === "none" || mode === "system-exclude" || (mode === "app" && linux);
        this.audioHint.textContent = "";

        if (mode === "none") {
            this.deviceHint.textContent = "Your stream will have no audio.";
            return;
        }

        if (mode === "system-exclude") {
            this.audioHint.textContent =
                "Captures every application except Discord. Applications started later need a restart of sharing to be included.";
            return;
        }

        if (mode === "app" && linux) {
            const app = (audio?.apps ?? []).find(item => item.id === this.appSelect.value);
            this.appHint.textContent = app
                ? `Capturing only ${app.name}. Discord voice chat is not included.`
                : "No application is currently producing audio. Start the game or app, then reopen this dialog.";
            return;
        }

        if (this.capabilities?.platform === "win32") {
            this.audioHint.textContent =
                mode === "app"
                    ? "Windows application audio uses a virtual cable. Choose the cable under Advanced options."
                    : mode === "system"
                      ? "If the default device is wrong, choose a DirectShow loopback device under Advanced options."
                      : "";
            this.deviceHint.textContent =
                mode === "app"
                    ? device
                        ? `Virtual cable: ${device}. Route only the game/app to this device in Windows volume mixer.`
                        : "Select the virtual audio cable that the game is routed to. OBS's win-capture-audio plugin cannot be used outside OBS."
                    : device
                      ? `DirectShow device: ${device}`
                      : "Windows needs a DirectShow device name here, for example “Stereo Mix” or a virtual cable.";
            return;
        }

        if (mode === "system") {
            this.deviceHint.textContent = audio?.monitor
                ? `Capturing ${device || audio.monitor}. This includes Discord voice chat; use the excluding option instead.`
                : "No output monitor was detected; audio will be skipped.";
            return;
        }

        this.deviceHint.textContent = audio?.mic
            ? `Capturing ${device || audio.mic}.`
            : "No default microphone was detected; audio will be skipped.";
    }

    private submit(): void {
        const onStart = this.onStart;
        if (!onStart) return;

        const selected = this.audioSelect.value;
        const mode: BBConfig["audio"] =
            selected === "system-exclude" ? "system" : (selected as BBConfig["audio"]);
        const linux = this.capabilities?.platform === "linux";
        const audioApp = selected === "app" && linux ? this.appSelect.value : "";
        const portalWindow = this.capabilities?.capture.windowMethod === "wayland-portal";
        const windowMode = this.sourceSelect.value === "window" && Boolean(this.capabilities?.capture.window);
        const bitrate = Math.max(0, Math.round(Number(this.bitrateInput.value) || 0));
        const patch: Partial<BBConfig> = {
            server: this.serverInput.value.trim(),
            capture: windowMode ? "window" : "screen",
            window: windowMode && !portalWindow ? this.windowSelect.value : "",
            monitor: this.screenSelect.value,
            resolution: this.resolutionSelect.value as BBConfig["resolution"],
            fps: Number(this.fpsSelect.value),
            bitrateKbps: bitrate,
            audio: selected === "app" && linux && !audioApp ? "none" : mode,
            audioExcludeDiscord: selected === "system-exclude",
            audioApp,
            audioDevice:
                selected === "system-exclude" || (selected === "app" && linux)
                    ? ""
                    : this.deviceInput.value.trim(),
            autoWatchSelf: this.previewInput.checked,
            showDiagnostics: this.diagnosticsInput.checked
        };

        this.close();
        onStart(patch);
    }

    private createSelect(): HTMLSelectElement {
        return h("select") as HTMLSelectElement;
    }
}
