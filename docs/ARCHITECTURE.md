# Architecture and design

## How it works

```
┌──────────────┐   PipeWire DMA-BUF   ┌──────────────────────┐
│ Discord      │ ───────────────────▶ │ wf-recorder /        │
│ (native side)│                      │ portal + GStreamer   │
└──────────────┘                      └──────────┬───────────┘
                                                 │ MPEG-TS
                                                 ▼
┌──────────────┐   pw-record (apps)   ┌──────────────────────┐
│ Discord      │ ───────────────────▶ │ FFmpeg               │
│ (native side)│                      │ remux video + Opus   │
└──────────────┘                      └──────────┬───────────┘
                                                 │ WHIP (HTTP + SRTP)
                                                 ▼
                                        ┌─────────────────┐
                                        │  Broadcast Box  │
                                        │   your server   │
                                        └────────┬────────┘
                                                 │ WHEP (WebRTC)
                                                 ▼
                                        ┌─────────────────┐
                                        │ Discord renderer│
                                        │  floating player│
                                        └─────────────────┘
```

On Linux/Wayland with VAAPI, `wf-recorder` keeps the captured DMA-BUF frames on the GPU, scales them with `scale_vaapi`, and encodes H.264 with `h264_vaapi`. FFmpeg only remuxes that H.264 into WHIP and adds Opus audio, so no raw frames travel through the CPU. This is the same zero-copy idea OBS uses and keeps CPU use in the low single digits at 1080p60.

Wayland **window** capture takes the OBS-style route instead: the helper opens the xdg-desktop-portal window picker, keeps that portal session and PipeWire fd alive, and feeds `pipewiresrc` into GStreamer. The compositor therefore supplies a live stream for the chosen window; moving follows the window continuously. Resizing triggers a short (~3 second) capture restart while the portal session is restored, after which the same window resumes without reopening the picker. Frames are converted/scaled to the requested canvas with letterboxing, encoded with `vah264enc` (VAAPI) when available, and fall back to `x264enc`. FFmpeg still only remuxes the H.264 into WHIP.

> **Portal requirement:** window capture needs an `xdg-desktop-portal-hyprland` build containing the screencopy buffer-retry fix. The packaged 1.4.1 release can log `[screencopy/pipewire] Out of buffers` and freeze the share after a few seconds. A build from upstream `master` (or a distro package with the fix backported) is required. Screen/region capture through `wf-recorder` is unaffected.

For Hyprland, also add this to `~/.config/hypr/xdph.conf` so window captures use SHM and can be restored without reopening the picker after a resize:

```ini
screencopy:force_shm = 1
screencopy:allow_token_by_default = 1
```

Restart `xdg-desktop-portal-hyprland` and `xdg-desktop-portal` after changing it. Without `allow_token_by_default`, resizing a window can require selecting it again; without `force_shm`, the portal can enter a DMA/SHM renegotiation loop.

On Windows/AMD, a current FFmpeg build can use `vsrc_amf` → `vpp_amf` → `h264_amf`, which keeps the desktop texture on the GPU for capture, scaling, and encoding. If that filter pair is missing, the plugin falls back to `ddagrab` with a `hwdownload` CPU copy. On Windows/NVIDIA, `ddagrab` is captured and encoded through NVENC, with a CPU scale when the target resolution differs from the monitor. Other capture paths encode directly with FFmpeg.

A tiny loopback HTTP proxy sits between FFmpeg and Broadcast Box. It fixes two FFmpeg muxer quirks:

1. Broadcast Box answers WHIP with chunked encoding; FFmpeg only reads SDP answers that have a `Content-Length`.
2. Broadcast Box lists a private/LAN ICE candidate first and FFmpeg only uses the first candidate, so the proxy puts public candidates first.

The proxy is started on `127.0.0.1` with an ephemeral port for every publish attempt and is torn down when sharing stops.

## Stream keys

Auto-discovery relies on every client deriving the same key:

```
d-<voiceChannelId>-<userId>
```

When there is no voice channel (manual/legacy use), the fallback is `d-<userId>`.

This means:

- Both Equicord and BetterDiscord users publish to the same key for the same person/channel.
- Anyone who can compute the key can watch. Treat the key like a room password; Broadcast Box also accepts it as a bearer token for publishing.
- Streams are only discoverable while the publisher and viewer are in the **same voice channel**.
