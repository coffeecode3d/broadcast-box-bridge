/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Broadcast Box Bridge - Equicord native helper.
 *
 * Runs in the Electron main process. All screen capture, encoding and the
 * loopback WHIP proxy live here; the renderer only sends settings.
 */

import type { IpcMainInvokeEvent } from "electron";

import type { BBConfig, Capabilities, PublishState, StartResult } from "./core/types";
import {
    detect as detectRuntime,
    start as startPublisher,
    state as getPublisherState,
    stop as stopPublisher
} from "./node/runtime";

export function detect(_: IpcMainInvokeEvent, force?: boolean): Promise<Capabilities> {
    return detectRuntime(force === true);
}

export function start(
    _: IpcMainInvokeEvent,
    options: { config: BBConfig; key: string }
): Promise<StartResult> {
    return startPublisher(options);
}

export function stop(_: IpcMainInvokeEvent): Promise<{ ok: boolean; error?: string }> {
    return stopPublisher();
}

export function state(_: IpcMainInvokeEvent): Promise<PublishState> {
    return getPublisherState();
}
