import type { BridgeHost, VoiceMember } from "../core/types";
import * as nativeApi from "./native";

/* eslint-disable @typescript-eslint/no-explicit-any */

const BdApi = (globalThis as unknown as { BdApi: any }).BdApi;

const storeCache = new Map<string, any>();

function getStore(name: string): any {
    if (storeCache.has(name)) return storeCache.get(name);

    let store: any = null;
    try {
        const webpack = BdApi?.Webpack;
        if (webpack) {
            // BD accepts a store name directly in recent versions. Older builds
            // only accept filters, so fall back to a getName() search.
            store =
                webpack.getStore?.(name) ??
                webpack.getModule?.(
                    (module: any) => typeof module?.getName === "function" && module.getName() === name
                ) ??
                null;
        }
    } catch {
        store = null;
    }

    if (store) storeCache.set(name, store);
    return store;
}

interface RtcUser {
    id: string;
    username: string;
    globalName?: string | null;
    avatar?: string | null;
}

interface RtcParticipant {
    user?: RtcUser;
    voiceState?: { nick?: string | null } | null;
    nick?: string | null;
}

function avatarUrl(user: RtcUser): string | null {
    return user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
        : null;
}

function voiceMembers(channelId: string): VoiceMember[] {
    const store = getStore("ChannelRTCStore");
    if (!store?.getParticipants) return [];

    let participants: RtcParticipant[] = [];
    try {
        participants = store.getParticipants(channelId) as RtcParticipant[];
    } catch {
        return [];
    }

    const members: VoiceMember[] = [];
    const seen = new Set<string>();

    for (const participant of participants) {
        const user = participant?.user;
        if (!user?.id || !participant.voiceState) continue;
        if (seen.has(user.id)) continue;
        seen.add(user.id);
        members.push({
            userId: user.id,
            name: participant.voiceState.nick || participant.nick || user.globalName || user.username,
            avatarUrl: avatarUrl(user)
        });
    }

    return members;
}

function channelName(channelId: string): string {
    const channelStore = getStore("ChannelStore");
    const userStore = getStore("UserStore");
    const channel = channelStore?.getChannel?.(channelId) as
        | { name?: string | null; recipients?: string[] }
        | undefined;

    if (!channel) return "Voice channel";
    if (channel.name) return channel.name;

    const recipients = channel.recipients ?? [];
    const names = recipients
        .map(id => {
            const user = userStore?.getUser?.(id);
            return user?.globalName || user?.username;
        })
        .filter((name: string | undefined): name is string => Boolean(name));

    return names.length ? names.join(", ") : "Direct call";
}

function toast(message: string, kind: "info" | "success" | "error" | "warning" = "info") {
    const type = kind === "error" ? "error" : kind;
    try {
        if (BdApi?.UI?.showToast) BdApi.UI.showToast(message, { type });
        else BdApi?.showToast?.(message, { type });
    } catch {
        console.log("[BroadcastBoxBridge]", message);
    }
}

function copyText(text: string) {
    try {
        if (BdApi?.Utils?.copyToClipboard) {
            BdApi.Utils.copyToClipboard(text);
            return;
        }
    } catch {
        // fall through
    }
    navigator.clipboard?.writeText(text).catch(() => {
        try {
            const area = document.createElement("textarea");
            area.value = text;
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.append(area);
            area.select();
            document.execCommand("copy");
            area.remove();
        } catch {
            // ignored
        }
    });
}

export function createBetterDiscordHost(): BridgeHost {
    return {
        clientName: "betterdiscord",
        native: {
            detect: nativeApi.detect,
            start: nativeApi.start,
            stop: nativeApi.stop,
            state: nativeApi.state
        },

        getCurrentUserId() {
            return getStore("UserStore")?.getCurrentUser?.()?.id ?? "";
        },

        getCurrentUserName() {
            const user = getStore("UserStore")?.getCurrentUser?.();
            return user?.globalName || user?.username || "You";
        },

        getVoiceChannelId() {
            return getStore("SelectedChannelStore")?.getVoiceChannelId?.() ?? null;
        },

        getChannelName(channelId: string) {
            return channelName(channelId);
        },

        getVoiceMembers(channelId: string) {
            return voiceMembers(channelId);
        },

        getUserName(userId: string) {
            const user = getStore("UserStore")?.getUser?.(userId);
            return user?.globalName || user?.username || userId;
        },

        getUserAvatarUrl(userId: string) {
            const user = getStore("UserStore")?.getUser?.(userId);
            return user ? avatarUrl(user) : null;
        },

        toast,
        copyText,

        log(...args: unknown[]) {
            console.log("[BroadcastBoxBridge]", ...args);
        }
    };
}
