import { BroadcastBoxBridge } from "../core/bridge";
import { createBetterDiscordHost } from "./host";

let bridge: BroadcastBoxBridge | null = null;

/**
 * BetterDiscord plugin entry. Bundled into a single file by scripts/build.mjs,
 * which appends `module.exports = ...` so BetterDiscord can load the class.
 */
export default class BroadcastBoxBridgePlugin {
    start() {
        try {
            bridge = new BroadcastBoxBridge(createBetterDiscordHost());
            void bridge.start();
        } catch (error) {
            console.error("[BroadcastBoxBridge] failed to start", error);
        }
    }

    stop() {
        void bridge?.stop();
        bridge = null;
    }

    getSettingsPanel() {
        // Settings live inside the floating dock so both clients share one UI.
        return null;
    }
}
