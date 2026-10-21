import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * OBS-style Wayland window capture.
 *
 * The xdg-desktop-portal owns the picker and hands back a restricted PipeWire
 * node. We keep that portal session and PipeWire fd alive for the whole
 * capture process, so moving or resizing the selected window is followed by
 * the compositor instead of leaving us with a stale screen rectangle.
 *
 * GStreamer encodes H.264 into MPEG-TS on stdout. FFmpeg then only remuxes
 * that stream into WHIP, exactly like the existing wf-recorder path.
 */
export const PORTAL_CAPTURE_SCRIPT = String.raw`#!/usr/bin/env python3
import os
import re
import sys
import time

import dbus
import dbus.mainloop.glib
import gi

gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst

if len(sys.argv) < 5:
    print("[portal] expected width height fps bitrate", file=sys.stderr, flush=True)
    sys.exit(2)

WIDTH = max(2, int(sys.argv[1]))
HEIGHT = max(2, int(sys.argv[2]))
FPS = max(1, int(sys.argv[3]))
BITRATE = max(100, int(sys.argv[4]))
FORCE_X264 = len(sys.argv) > 5 and sys.argv[5] == "x264"
GOP = max(1, round(FPS * 2))


def log(message):
    print("[portal] " + message, file=sys.stderr, flush=True)


dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
Gst.init(None)

try:
    bus = dbus.SessionBus()
    portal = bus.get_object(
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
    )
    screencast = dbus.Interface(portal, "org.freedesktop.portal.ScreenCast")
except Exception as error:
    log("Could not connect to xdg-desktop-portal: " + str(error))
    sys.exit(2)

sender = re.sub(r"\.", "_", bus.get_unique_name()[1:])
counter = 0


def portal_request(method, *args, options=None):
    global counter
    counter += 1
    token = "bbshare" + str(os.getpid()) + "_" + str(counter)
    request_path = (
        "/org/freedesktop/portal/desktop/request/"
        + sender
        + "/"
        + token
    )
    call_options = dict(options or {})
    call_options["handle_token"] = token

    reply = {}
    timed_out = {"value": False}
    loop = GLib.MainLoop()

    def on_response(code, results):
        reply["code"] = int(code)
        reply["results"] = results
        loop.quit()

    def on_timeout():
        timed_out["value"] = True
        loop.quit()
        return False

    match = bus.add_signal_receiver(
        on_response,
        signal_name="Response",
        dbus_interface="org.freedesktop.portal.Request",
        bus_name="org.freedesktop.portal.Desktop",
        path=request_path,
    )
    timeout_id = GLib.timeout_add_seconds(300, on_timeout)
    try:
        method(*args, dbus.Dictionary(call_options, signature="sv"))
        loop.run()
    finally:
        GLib.source_remove(timeout_id)
        match.remove()

    if timed_out["value"]:
        raise RuntimeError("the system picker did not respond")
    code = reply.get("code")
    if code != 0:
        if code == 1:
            raise RuntimeError("window selection was cancelled")
        raise RuntimeError("portal request failed with response " + str(code))
    return reply.get("results", {})


session = None
node_id = None
pipewire_fd = None
restore_token = None


def close_portal_session(handle):
    if not handle:
        return
    try:
        session_obj = bus.get_object("org.freedesktop.portal.Desktop", handle)
        dbus.Interface(session_obj, "org.freedesktop.portal.Session").Close()
    except Exception:
        pass


def open_portal_session(token=None):
    global session, node_id, pipewire_fd, restore_token
    log("creating screen-cast session")
    created = portal_request(
        screencast.CreateSession,
        options={
            "session_handle_token": "bbshare" + str(os.getpid()),
        },
    )
    new_session = str(created["session_handle"])

    select_options = {
        "types": dbus.UInt32(2),
        "multiple": False,
        "cursor_mode": dbus.UInt32(2),
        "persist_mode": dbus.UInt32(2),
    }
    if token:
        select_options["restore_token"] = token
        log("restoring the previously selected window")
    else:
        log("asking the system picker for a window")
    portal_request(screencast.SelectSources, new_session, options=select_options)

    log("starting the selected stream")
    started = portal_request(
        screencast.Start,
        new_session,
        "",
        options={},
    )

    streams = started.get("streams") or []
    if not streams:
        raise RuntimeError("the portal returned no screen-cast stream")
    new_node = int(streams[0][0])

    remote_fd = screencast.OpenPipeWireRemote(
        new_session,
        dbus.Dictionary({}, signature="sv"),
    )
    new_fd = remote_fd.take() if hasattr(remote_fd, "take") else int(remote_fd)
    if new_fd < 0:
        raise RuntimeError("the portal returned an invalid PipeWire fd")

    old_session = session
    session = new_session
    node_id = new_node
    pipewire_fd = new_fd
    new_token = started.get("restore_token")
    if new_token:
        restore_token = str(new_token)
    close_portal_session(old_session)
    log(
        "selected window, PipeWire node "
        + str(node_id)
        + (" (restore token available)" if restore_token else " (no restore token)")
    )


try:
    open_portal_session()
except Exception as error:
    log(str(error))
    close_portal_session(session)
    sys.exit(2)

def encoder_spec(kind):
    if kind == "vah264":
        return (
            "vah264enc bitrate="
            + str(BITRATE)
            + " rate-control=cbr key-int-max="
            + str(GOP)
            + " cpb-size="
            + str(BITRATE * 2)
            + " b-frames=0"
        )
    if kind == "vaapih264":
        return (
            "vaapih264enc bitrate="
            + str(BITRATE)
            + " rate-control=cbr keyframe-period="
            + str(GOP)
            + " max-bframes=0"
        )
    return (
        "x264enc bitrate="
        + str(BITRATE)
        + " key-int-max="
        + str(GOP)
        + " speed-preset=veryfast tune=zerolatency bframes=0 rc-lookahead=0"
    )


pipeline_fds = []
VAPOSTPROC = Gst.ElementFactory.find("vapostproc") is not None


def pipeline_description(kind):
    # Give each attempted pipeline its own fd. If a hardware encoder rejects
    # the stream during initialisation, the fallback can still connect to the
    # portal instead of inheriting a descriptor that GStreamer already closed.
    pipeline_fd = os.dup(pipewire_fd)
    pipeline_fds.append(pipeline_fd)

    source = (
        "pipewiresrc fd="
        + str(pipeline_fd)
        + " target-object="
        + str(node_id)
        + " do-timestamp=true"
    )
    encoder = kind.rsplit("-", 1)[0]

    if kind.endswith("-dma"):
        # Hyprland's portal compares the negotiated PipeWire format of an SHM
        # window stream against the DMA frame info. That comparison fails in
        # xdg-desktop-portal-hyprland 1.4.1 and results in an endless
        # "Incompatible formats" / "Out of buffers" loop. Requesting DMA-BUF
        # takes the path that the portal compares correctly. vapostproc keeps
        # the scaling on the GPU before handing frames back for videorate.
        chain = (
            source
            + " ! video/x-raw(memory:DMABuf) ! vapostproc add-borders=true ! "
            "video/x-raw,format=NV12,width="
            + str(WIDTH)
            + ",height="
            + str(HEIGHT)
            + ",pixel-aspect-ratio=1/1"
        )
    else:
        # Window capture from the portal is normally BGRA/BGRx. Asking for an
        # explicit software format avoids PipeWire renegotiating forever when
        # our downstream elements advertise a hardware format it cannot use.
        chain = (
            source
            + " ! video/x-raw,format={BGRA,BGRx,RGBA,RGBx,NV12} ! "
            "videoconvert ! videoscale add-borders=true"
        )

    chain += (
        " ! video/x-raw,format=NV12,width="
        + str(WIDTH)
        + ",height="
        + str(HEIGHT)
        + ",pixel-aspect-ratio=1/1"
        + " ! videorate ! video/x-raw,format=NV12,width="
        + str(WIDTH)
        + ",height="
        + str(HEIGHT)
        + ",pixel-aspect-ratio=1/1,framerate="
        + str(FPS)
        + "/1 ! "
        + encoder_spec(encoder)
        + " ! h264parse name=parsed config-interval=-1 ! mpegtsmux alignment=7 ! fdsink name=out fd=1 sync=false"
    )
    return chain


candidates = []
# Hyprland's window export gives us SHM buffers, not DMA-BUF. SHM is also the
# path that works with the portal's format comparison when we pin a concrete
# pixel format, so try it first. DMA variants remain as a fallback for other
# portal implementations.
# Prefer VAAPI. The portal's screencopy buffer-retry fix is required for
# hardware encoding: older xdg-desktop-portal-hyprland releases starve the
# encoder after a handful of frames. x264 remains the software fallback.
if not FORCE_X264:
    if Gst.ElementFactory.find("vah264enc"):
        candidates.append("vah264-shm")
    if Gst.ElementFactory.find("vaapih264enc"):
        candidates.append("vaapih264-shm")
if Gst.ElementFactory.find("x264enc"):
    candidates.append("x264-shm")
if not FORCE_X264:
    if VAPOSTPROC and Gst.ElementFactory.find("vah264enc"):
        candidates.append("vah264-dma")
    if VAPOSTPROC and Gst.ElementFactory.find("vaapih264enc"):
        candidates.append("vaapih264-dma")
    if VAPOSTPROC and Gst.ElementFactory.find("x264enc"):
        candidates.append("x264-dma")
if not candidates:
    log("GStreamer has no usable H.264 encoder (vah264enc, vaapih264enc or x264enc)")
    sys.exit(2)

pipeline = None
selected_encoder = None
for kind in candidates:
    description = pipeline_description(kind)
    log("trying " + kind + " pipeline")
    try:
        candidate = Gst.parse_launch(description)
    except Exception as error:
        log("Could not create the " + kind + " pipeline: " + str(error))
        continue

    first = {"seen": False, "caps": None}
    parsed = candidate.get_by_name("parsed")
    if parsed is not None:
        pad = parsed.get_static_pad("src")

        def on_first_buffer(_pad, _info, state=first):
            state["seen"] = True
            caps = _pad.get_current_caps()
            if state["caps"] is None and caps is not None:
                state["caps"] = caps.to_string()
            return Gst.PadProbeReturn.OK

        pad.add_probe(Gst.PadProbeType.BUFFER, on_first_buffer)

    log("starting " + kind)
    candidate.set_state(Gst.State.PLAYING)
    state = candidate.get_state(10 * Gst.SECOND)
    if state[0] == Gst.StateChangeReturn.FAILURE:
        log(kind + " could not start; falling back")
        candidate.set_state(Gst.State.NULL)
        continue

    # A pipeline can enter PLAYING and still never output a buffer (for example
    # a DMA-only path against a portal that only exports SHM). Wait for the
    # first encoded buffer so that case falls through to the next candidate
    # instead of leaving the user with a frozen share.
    deadline = time.monotonic() + 10.0
    while not first["seen"] and time.monotonic() < deadline:
        message = candidate.get_bus().timed_pop_filtered(
            100 * Gst.MSECOND,
            Gst.MessageType.ERROR | Gst.MessageType.EOS,
        )
        if message is not None:
            if message.type == Gst.MessageType.ERROR:
                error, _debug = message.parse_error()
                log(kind + " failed: " + error.message)
            else:
                log(kind + " ended before producing a frame")
            break
        time.sleep(0.02)

    if not first["seen"]:
        log(kind + " produced no frames; falling back")
        candidate.set_state(Gst.State.NULL)
        continue

    if first["caps"]:
        log("first output caps: " + first["caps"])
    pipeline = candidate
    selected_encoder = kind
    log("using " + kind + " at " + str(WIDTH) + "x" + str(HEIGHT) + "@" + str(FPS))
    break

if pipeline is None:
    log("GStreamer could not start any H.264 pipeline")
    sys.exit(2)

loop = GLib.MainLoop()
state = {
    "pipeline": pipeline,
    "kind": selected_encoder,
    "last_frame": time.monotonic(),
    "restarts": 0,
    "frames": 0,
    "starting": False,
    "failed": False,
}


def attach_frame_probe(target, frame_state):
    parsed = target.get_by_name("parsed")
    if parsed is None:
        return

    def on_frame(_pad, _info):
        frame_state["last_frame"] = time.monotonic()
        frame_state["frames"] += 1
        if frame_state["frames"] >= 600:
            # A stable ten seconds of capture makes earlier restarts irrelevant.
            frame_state["frames"] = 0
            frame_state["restarts"] = 0
        return Gst.PadProbeReturn.OK

    parsed.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, on_frame)


def build_pipeline(kind, frame_state):
    global pipeline_fd
    next_fd = os.dup(pipewire_fd)
    pipeline_fds.append(next_fd)
    pipeline_fd = next_fd
    attempt = Gst.parse_launch(pipeline_description(kind))
    attach_frame_probe(attempt, frame_state)
    attempt_bus = attempt.get_bus()
    attempt_bus.add_signal_watch()
    attempt_bus.connect("message", on_message)
    attempt.set_state(Gst.State.PLAYING)
    return attempt


def restart(reason):
    if state["starting"] or state["failed"]:
        return
    if state["restarts"] >= 6:
        log("capture stopped producing frames repeatedly; giving up")
        state["failed"] = True
        loop.quit()
        return
    state["starting"] = True
    state["restarts"] += 1
    log(reason + "; restarting " + state["kind"])
    old = state["pipeline"]
    if old is not None:
        try:
            old.get_bus().remove_signal_watch()
        except Exception:
            pass
        old.set_state(Gst.State.NULL)
    try:
        if not restore_token:
            log("no portal restore token; a window picker is required after a resize")
            state["failed"] = True
            loop.quit()
            return
        open_portal_session(restore_token)
        state["pipeline"] = build_pipeline(state["kind"], state)
        state["last_frame"] = time.monotonic() + 8.0
        state["frames"] = 0
        log("capture pipeline restarted")
    except Exception as error:
        log("could not restart capture pipeline: " + str(error))
        state["failed"] = True
        loop.quit()
    finally:
        state["starting"] = False


def on_message(_bus, message):
    if message.type == Gst.MessageType.ERROR:
        error, debug = message.parse_error()
        log("GStreamer error: " + error.message)
        if debug:
            log(debug)
        restart("capture error")
    elif message.type == Gst.MessageType.EOS:
        log("PipeWire stream ended")
        restart("PipeWire stream ended")
    elif message.type == Gst.MessageType.WARNING:
        warning, debug = message.parse_warning()
        log("GStreamer warning: " + warning.message)
        if debug:
            log(debug)


def watchdog():
    if state["failed"]:
        return False
    if not state["starting"] and time.monotonic() - state["last_frame"] > 3.0:
        restart("capture stalled for 3s")
    return True


attach_frame_probe(pipeline, state)
initial_bus = pipeline.get_bus()
initial_bus.add_signal_watch()
initial_bus.connect("message", on_message)
GLib.timeout_add(1000, watchdog)

try:
    loop.run()
finally:
    active = state.get("pipeline")
    if active is not None:
        try:
            active.get_bus().remove_signal_watch()
        except Exception:
            pass
        active.set_state(Gst.State.NULL)
    for fd in pipeline_fds:
        try:
            os.close(fd)
        except OSError:
            pass
    close_portal_session(session)

sys.exit(1 if state["failed"] else 0)
`;

/** Write the helper once per process and return its command. */
let portalScriptPath: string | null = null;

export function portalCaptureCommand(
    width: number,
    height: number,
    fps: number,
    bitrateKbps: number,
    forceX264 = false
): { cmd: string; args: string[] } {
    if (!portalScriptPath) {
        const directory = mkdtempSync(join(tmpdir(), "bb-bridge-portal-"));
        portalScriptPath = join(directory, "capture.py");
        writeFileSync(portalScriptPath, PORTAL_CAPTURE_SCRIPT, { encoding: "utf8", mode: 0o700 });
    }
    return {
        cmd: "python3",
        args: [
            "-u",
            portalScriptPath,
            String(width),
            String(height),
            String(fps),
            String(bitrateKbps),
            ...(forceX264 ? ["x264"] : [])
        ]
    };
}
