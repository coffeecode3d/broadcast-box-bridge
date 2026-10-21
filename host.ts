import type { PluginNative } from "@utils/types";
import { ChannelRTCStore, ChannelStore, SelectedChannelStore, showToast, UserStore } from "@webpack/common";

import type { BridgeHost, NativeApi, VoiceMember } from "./core/types";

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

export function createEquicordHost(): BridgeHost {
    const Native = VencordNative?.pluginHelpers?.BroadcastBoxBridge as PluginNative<
        typeof import("./native")
    >;

    if (!Native) {
        throw new Error(
            "BroadcastBoxBridge's native helper is unavailable. This plugin requires the Discord desktop client."
        );
    }

    return {
        clientName: "equicord",
        native: Native as unknown as NativeApi,

        getCurrentUserId() {
            return UserStore.getCurrentUser()?.id ?? "";
        },

        getCurrentUserName() {
            const user = UserStore.getCurrentUser();
            return user?.globalName || user?.username || "You";
        },

        getVoiceChannelId() {
            return SelectedChannelStore.getVoiceChannelId() ?? null;
        },

        getChannelName(channelId: string) {
            return channelName(channelId);
        },

        getVoiceMembers(channelId: string) {
            return voiceMembers(channelId);
        },

        getUserName(userId: string) {
            const user = UserStore.getUser(userId);
            return user?.globalName || user?.username || userId;
        },

        getUserAvatarUrl(userId: string) {
            const user = UserStore.getUser(userId);
            return user ? avatarUrl(user) : null;
        },

        toast(message, kind = "info") {
            const variant =
                kind === "error" || kind === "warning" ? "critical" : kind === "success" ? "success" : "default";
            showToast({ text: message, variant });
        },

        copyText(text: string) {
            navigator.clipboard?.writeText(text).catch(() => {
                fallbackCopy(text);
            });
        },

        log(...args: unknown[]) {
            console.log("[BroadcastBoxBridge]", ...args);
        }
    };
}

export function voiceMembers(channelId: string): VoiceMember[] {
    let participants: RtcParticipant[] = [];
    try {
        participants = (ChannelRTCStore?.getParticipants(channelId) ?? []) as unknown as RtcParticipant[];
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

export function channelName(channelId: string): string {
    const channel = ChannelStore?.getChannel(channelId) as
        | { name?: string | null; recipients?: string[]; guild_id?: string | null }
        | undefined;

    if (!channel) return "Voice channel";
    if (channel.name) return channel.name;

    const recipients = channel.recipients ?? [];
    const names = recipients
        .map(id => {
            const user = UserStore?.getUser(id);
            return user?.globalName || user?.username;
        })
        .filter((name): name is string => Boolean(name));

    return names.length ? names.join(", ") : "Direct call";
}

function fallbackCopy(text: string) {
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
}
