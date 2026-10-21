import type { Capabilities, PublishState, StartResult } from "../core/types";
import { detectCapabilities } from "./capabilities";
import { Publisher } from "./publisher";

const publisher = new Publisher();

/**
 * Native API surface shared by the Equicord IPC wrapper and the BetterDiscord
 * renderer bundle.
 */
export async function detect(force = false): Promise<Capabilities> {
    return detectCapabilities(force);
}

export async function start(options: { config: import("../core/types").BBConfig; key: string }): Promise<StartResult> {
    return publisher.start(options.config, options.key);
}

export async function stop(): Promise<{ ok: boolean; error?: string }> {
    return publisher.stop();
}

export async function state(): Promise<PublishState> {
    return publisher.state();
}
