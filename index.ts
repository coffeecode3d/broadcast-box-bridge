/*
 * Broadcast Box Bridge - Equicord entry point.
 *
 * Publish the current screen to your Broadcast Box instance and watch streams
 * published by other Bridge users in the same voice channel.
 */

import definePlugin from "@utils/types";

import { BroadcastBoxBridge } from "./core/bridge";
import { createEquicordHost } from "./host";

let bridge: BroadcastBoxBridge | null = null;

export default definePlugin({
    name: "BroadcastBoxBridge",
    description:
        "Share your screen through a self-hosted Broadcast Box instance (WHIP) and watch other members' streams (WHEP) without leaving Discord.",
    authors: [{ name: "BroadcastBoxBridge contributors", id: 0n }],
    tags: ["Voice", "Utility"],
    enabledByDefault: false,

    start() {
        try {
            bridge = new BroadcastBoxBridge(createEquicordHost());
            void bridge.start();
        } catch (error) {
            console.error("[BroadcastBoxBridge] failed to start", error);
        }
    },

    stop() {
        void bridge?.stop();
        bridge = null;
    }
});
