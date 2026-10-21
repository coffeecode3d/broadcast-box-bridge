/**
 * Stream keys are derived deterministically so that any Bridge user in the same
 * voice channel can discover everybody else's stream without a registry.
 *
 * Shared by both the publisher and the viewer, and by both client mods.
 */

const SAFE = /[^A-Za-z0-9_-]/g;

export function streamKeyFor(channelId: string | null | undefined, userId: string | number | bigint): string {
    const user = String(userId).replace(SAFE, "");
    const channel = channelId ? String(channelId).replace(SAFE, "") : "";
    return channel ? `d-${channel}-${user}` : `d-${user}`;
}

export function isValidStreamKey(key: string): boolean {
    return /^[A-Za-z0-9_-]{1,160}$/.test(key);
}
