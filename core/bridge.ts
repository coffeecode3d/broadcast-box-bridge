import { fetchStatus } from "./bb";
import { loadConfig, normalizeConfig, saveConfig } from "./config";
import { streamKeyFor } from "./keys";
import type {
    BBConfig,
    BBStatus,
    BridgeHost,
    BridgeSnapshot,
    Capabilities,
    PublishState,
    VoiceMember,
    WatchTarget
} from "./types";
import { Dock } from "./ui/dock";
import { Player } from "./ui/player";
import { ShareDialog } from "./ui/shareDialog";

const EMPTY_PUBLISH_STATE: PublishState = {
    running: false,
    warnings: [],
    logs: [],
    error: null
};

/**
 * Client agnostic controller. Equicord and BetterDiscord each provide a small
 * host adapter for stores, toasts and the native helper, then share all of the
 * behaviour below.
 */
export class BroadcastBoxBridge {
    private config: BBConfig;
    private capabilities: Capabilities | null = null;
    private publishing: PublishState = { ...EMPTY_PUBLISH_STATE };
    private publishLive = false;
    private voiceChannelId: string | null = null;
    private voiceChannelName = "";
    private members: VoiceMember[] = [];
    private live: Record<string, BBStatus | null> = {};
    private watchTarget: WatchTarget | null = null;
    private busy = false;
    private shareOpening = false;
    private error: string | null = null;

    private readonly dock: Dock;
    private readonly player: Player;
    private readonly shareDialog: ShareDialog;
    private readonly listeners = new Set<() => void>();

    private tickTimer: ReturnType<typeof setInterval> | undefined;
    private nullChannelTimer: ReturnType<typeof setTimeout> | undefined;
    private lastDiscovery = 0;
    private lastStatePoll = 0;
    private discovering = false;
    private lastPublishError = "";
    private stopped = false;

    constructor(private readonly host: BridgeHost) {
        this.config = loadConfig();
        this.dock = new Dock(this);
        this.player = new Player({
            mountPoint: host.mountPoint?.(),
            showDiagnostics: () => this.config.showDiagnostics,
            onClose: () => {
                this.watchTarget = null;
                this.emit();
            }
        });
        this.shareDialog = new ShareDialog();
    }

    async start(): Promise<void> {
        this.stopped = false;
        this.dock.mount(this.host.mountPoint?.() ?? document.body);
        this.syncChannel();
        this.emit();

        this.tickTimer = setInterval(() => void this.tick(), 1_000);

        try {
            this.capabilities = await this.host.native.detect();
            this.emit();
        } catch (error) {
            this.host.log("capability detection failed", error);
            this.host.toast("Broadcast Box could not inspect this system. The native helper may not be installed.", "error");
        }

        void this.refresh();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        clearInterval(this.tickTimer);
        this.tickTimer = undefined;
        clearTimeout(this.nullChannelTimer);
        this.nullChannelTimer = undefined;

        this.player.destroy();
        this.shareDialog.destroy();
        this.dock.destroy();
        this.listeners.clear();

        try {
            await this.host.native.stop();
        } catch (error) {
            this.host.log("failed to stop publisher", error);
        }
        this.publishing = { ...EMPTY_PUBLISH_STATE };
    }

    // ---- DockController -----------------------------------------------------

    snapshot(): BridgeSnapshot {
        return {
            config: this.config,
            capabilities: this.capabilities,
            voiceChannelId: this.voiceChannelId,
            voiceChannelName: this.voiceChannelName,
            selfUserId: this.host.getCurrentUserId(),
            selfKey: this.voiceChannelId ? streamKeyFor(this.voiceChannelId, this.host.getCurrentUserId()) : null,
            members: this.members,
            live: this.live,
            publishing: this.publishing,
            publishLive: this.publishLive,
            busy: this.busy,
            watch: this.watchTarget,
            error: this.error
        };
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    updateConfig(patch: Partial<BBConfig>): void {
        const previous = this.config;
        this.config = normalizeConfig({ ...this.config, ...patch });
        saveConfig(this.config);

        if (previous.server !== this.config.server) {
            this.live = {};
            this.lastDiscovery = 0;
            if (this.watchTarget) {
                this.watchTarget = null;
                this.player.close();
            }
        }

        const restartKeys: Array<keyof BBConfig> = [
            "resolution",
            "fps",
            "encoder",
            "bitrateKbps",
            "capture",
            "window",
            "audio",
            "audioExcludeDiscord",
            "audioApp",
            "audioDevice",
            "monitor",
            "region"
        ];
        if (this.publishing.running && restartKeys.some(key => previous[key] !== this.config[key])) {
            this.host.toast("Restart sharing to apply the new capture settings.", "info");
        }

        this.emit();
    }

    startPublish(): void {
        if (this.stopped || this.busy || this.publishing.running) return;
        if (!this.voiceChannelId) {
            this.host.toast("Join a voice channel before sharing.", "warning");
            return;
        }
        void this.openShareDialog();
    }

    private async openShareDialog(): Promise<void> {
        if (this.shareOpening) return;
        this.shareOpening = true;
        try {
            // Refresh so the application-audio list reflects what is playing now.
            this.capabilities = await this.host.native.detect(true);
            this.emit();
        } catch (error) {
            this.host.log("capability refresh failed", error);
        } finally {
            this.shareOpening = false;
        }

        this.shareDialog.open(this.snapshot(), patch => {
            this.updateConfig(patch);
            void this.doStartPublish();
        });
    }

    stopPublish(): void {
        void this.doStopPublish();
    }

    watch(userId: string): void {
        if (!this.voiceChannelId) return;
        if (!this.config.server) {
            this.host.toast("Set your Broadcast Box server in Advanced options first.", "warning");
            return;
        }
        const member = this.members.find(m => m.userId === userId);
        const self = userId === this.host.getCurrentUserId();
        const name = self ? "Your stream" : member?.name ?? this.host.getUserName(userId);
        const target: WatchTarget = {
            userId,
            name,
            key: streamKeyFor(this.voiceChannelId, userId),
            tileName: member?.name ?? (self ? this.host.getCurrentUserName() : name)
        };
        this.watchTarget = target;
        this.player.open(target, this.config.server);
        this.emit();
    }

    copy(text: string): void {
        if (!text || text === "—") return;
        this.host.copyText(text);
        this.host.toast("Stream key copied.", "success");
    }

    refresh(): void {
        this.lastDiscovery = 0;
        this.lastStatePoll = 0;
        void this.pollState();
        void this.discover();
        this.emit();
    }

    // ---- internals ----------------------------------------------------------

    private emit(): void {
        if (this.stopped) return;
        for (const listener of this.listeners) {
            try {
                listener();
            } catch (error) {
                console.error("[BroadcastBoxBridge] listener failed", error);
            }
        }
    }

    private async tick(): Promise<void> {
        if (this.stopped) return;
        this.syncChannel();
        this.refreshMembers();

        if (Date.now() - this.lastStatePoll >= 2_000) {
            this.lastStatePoll = Date.now();
            await this.pollState();
        }

        if (Date.now() - this.lastDiscovery >= this.config.pollIntervalMs) {
            this.lastDiscovery = Date.now();
            await this.discover();
        }

        this.emit();
    }

    private syncChannel(): void {
        const next = this.host.getVoiceChannelId();

        if (!next) {
            if (this.voiceChannelId && this.publishing.running) {
                // Discord briefly reports no channel during reconnects. Stop only
                // if we stay disconnected for a moment.
                if (!this.nullChannelTimer) {
                    this.nullChannelTimer = setTimeout(() => {
                        this.nullChannelTimer = undefined;
                        if (!this.host.getVoiceChannelId()) {
                            void this.doStopPublish("Disconnected from voice.");
                            this.applyChannel(null);
                        }
                    }, 2_500);
                }
                return;
            }
            this.applyChannel(null);
            return;
        }

        clearTimeout(this.nullChannelTimer);
        this.nullChannelTimer = undefined;

        if (this.voiceChannelId && this.voiceChannelId !== next && this.publishing.running) {
            void this.doStopPublish("Voice channel changed.");
        }
        this.applyChannel(next);
    }

    private applyChannel(channelId: string | null): void {
        if (channelId === this.voiceChannelId) {
            clearTimeout(this.nullChannelTimer);
            this.nullChannelTimer = undefined;
            return;
        }
        if (this.watchTarget) {
            this.watchTarget = null;
            this.player.close();
        }
        this.voiceChannelId = channelId;
        this.voiceChannelName = channelId ? this.host.getChannelName(channelId) : "";
        this.members = channelId ? this.host.getVoiceMembers(channelId) : [];
        this.live = {};
        this.lastDiscovery = 0;
        this.emit();
    }

    private refreshMembers(): void {
        if (!this.voiceChannelId) {
            if (this.members.length) {
                this.members = [];
                this.emit();
            }
            return;
        }
        const members = this.host.getVoiceMembers(this.voiceChannelId);
        if (!sameMembers(members, this.members)) {
            this.members = members;
            this.emit();
        }
        const name = this.host.getChannelName(this.voiceChannelId);
        if (name !== this.voiceChannelName) {
            this.voiceChannelName = name;
            this.emit();
        }
    }

    private async doStartPublish(): Promise<void> {
        if (this.busy || this.publishing.running || this.stopped) return;
        if (!this.voiceChannelId) {
            this.host.toast("Join a voice channel before sharing.", "warning");
            return;
        }
        if (!this.config.server) {
            const message = "Set your Broadcast Box server in Advanced options before sharing.";
            this.error = message;
            this.host.toast(message, "warning");
            this.dock.showServerSettings();
            this.emit();
            return;
        }

        this.busy = true;
        this.error = null;
        this.lastPublishError = "";
        this.emit();

        try {
            const key = streamKeyFor(this.voiceChannelId, this.host.getCurrentUserId());
            const result = await this.host.native.start({ config: this.config, key });
            if (!result.ok) {
                const message = result.error || "The publisher failed to start.";
                this.error = message;
                this.host.toast(message, "error");
                this.publishing = result.state ?? { ...EMPTY_PUBLISH_STATE, error: message };
                return;
            }

            this.publishing = result.state ?? (await this.host.native.state());
            this.publishLive = false;
            this.lastDiscovery = 0;
            this.lastStatePoll = 0;
            this.host.toast("Sharing to Broadcast Box…", "info");

            if (this.config.autoWatchSelf) {
                this.watch(this.host.getCurrentUserId());
            }
            void this.discover();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.error = message;
            this.host.toast(message, "error");
        } finally {
            this.busy = false;
            this.emit();
        }
    }

    private async doStopPublish(reason?: string): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        this.emit();
        try {
            const result = await this.host.native.stop();
            if (!result.ok) {
                this.host.toast(result.error || "Could not stop the publisher cleanly.", "warning");
            }
            this.publishing = { ...EMPTY_PUBLISH_STATE };
            this.publishLive = false;
            if (this.watchTarget?.userId === this.host.getCurrentUserId()) {
                this.watchTarget = null;
                this.player.close();
            }
            if (reason) this.host.toast(reason, "info");
        } catch (error) {
            this.host.log("stop failed", error);
        } finally {
            this.busy = false;
            this.emit();
        }
    }

    private async pollState(): Promise<void> {
        if (this.stopped) return;
        try {
            const state = await this.host.native.state();
            const changed = !sameState(state, this.publishing);
            this.publishing = state;

            if (!state.running) {
                this.publishLive = false;
                if (state.error && state.error !== this.lastPublishError) {
                    this.lastPublishError = state.error;
                    this.error = state.error;
                    this.host.toast(state.error, "error");
                }
            }
            if (changed) this.emit();
        } catch {
            // Native helper might be restarting; retry next tick.
        }
    }

    private async discover(): Promise<void> {
        if (this.stopped || this.discovering || !this.voiceChannelId || !this.config.server) return;
        this.discovering = true;

        const selfId = this.host.getCurrentUserId();
        const channelId = this.voiceChannelId;
        const targets: Array<{ userId: string; key: string }> = this.members.map(member => ({
            userId: member.userId,
            key: streamKeyFor(channelId, member.userId)
        }));
        const selfKey = streamKeyFor(channelId, selfId);
        if (!targets.some(target => target.userId === selfId)) {
            targets.push({ userId: selfId, key: selfKey });
        }

        try {
            const results = await Promise.allSettled(
                targets.map(async target => {
                    const status = await fetchStatus(this.config.server, target.key);
                    return { userId: target.userId, status };
                })
            );

            const next: Record<string, BBStatus | null> = {};
            for (let index = 0; index < results.length; index++) {
                const result = results[index];
                const target = targets[index];
                if (result.status === "fulfilled") {
                    next[target.userId] = result.value.status;
                } else {
                    // Keep a previous "online" answer across transient network errors.
                    next[target.userId] = this.live[target.userId] ?? null;
                }
            }

            this.live = next;
            const liveNow = Boolean(next[selfId]?.isOnline);
            if (liveNow !== this.publishLive) {
                this.publishLive = liveNow;
            }

            if (this.watchTarget && this.player.isOpen) {
                const status = next[this.watchTarget.userId];
                if (status === null) this.player.setOffline();
            }
        } finally {
            this.discovering = false;
            this.emit();
        }
    }
}

function sameMembers(a: VoiceMember[], b: VoiceMember[]): boolean {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
        const left = a[index];
        const right = b[index];
        if (left.userId !== right.userId || left.name !== right.name || left.avatarUrl !== right.avatarUrl) {
            return false;
        }
    }
    return true;
}

function sameState(a: PublishState, b: PublishState): boolean {
    return (
        a.running === b.running &&
        a.live === b.live &&
        a.key === b.key &&
        a.startedAt === b.startedAt &&
        a.error === b.error &&
        a.logs.length === b.logs.length &&
        a.logs[a.logs.length - 1] === b.logs[b.logs.length - 1] &&
        a.stats?.fps === b.stats?.fps &&
        a.stats?.bitrateKbps === b.stats?.bitrateKbps
    );
}
