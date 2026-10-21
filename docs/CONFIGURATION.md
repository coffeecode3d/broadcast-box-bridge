# Configuration

## Settings

The daily controls live in the **General** tab. Server, encoder, codec, region, device override, and status refresh are hidden under **Advanced**, so the panel stays usable without exposing tuning knobs.

| Setting | Description |
| --- | --- |
| Server | Your own Broadcast Box base URL. There is no bundled default, so set this before the first share. |
| Source | **Screen** or **Window**. Window capture is available on Windows (`gdigrab`), X11 (`x11grab -window_id`), and Wayland (xdg-desktop-portal + PipeWire). |
| Window | The application window to capture when **Source = Window**. On Wayland a system picker opens when sharing starts, so the list is replaced by a hint. The X11/Windows list refreshes whenever the share sheet opens. |
| Resolution | `native`, `720p`, `1080p`, `1440p`, `2160p`. Native uses the selected monitor or window size; Wayland portal mode uses the monitor size because the window is chosen after the picker opens. |
| Frame rate | 30, 60, or 120 fps. |
| Bitrate | Defaults to **9500 kbps**. Any value you save is persisted. Enter `0` to derive ~0.07 bits/pixel/frame automatically (clamped 1.5–40 Mbps). |
| Audio | **Microphone**, **System audio (excluding Discord)**, **Application audio**, **System audio (everything)**, or **none**. Linux application/excluding modes use PipeWire nodes. Windows application audio uses a virtual cable. |
| Encoder | `auto`, `vaapi`, `nvenc`, `qsv`, `amf`, `x264`. `auto` prefers GPU encoding per platform. On Linux/Wayland + VAAPI, `wf-recorder` scales and encodes screen capture on the GPU. Window capture uses `vah264enc` on the portal’s PipeWire frames, with `x264enc` as a fallback. |
| Codec | H.264 only. HEVC/VP9/AV1 are disabled because FFmpeg's WHIP muxer supports only H.264 + Opus. |
| Monitor | Linux/Wayland output name (for example `DP-1`) or Windows display name (for example `\\.\DISPLAY1`). Ignored in window mode on Wayland because the portal follows the selected window's output. |
| Capture region | Optional `x,y WxH`, applied on Wayland via `wf-recorder -g` and on X11 via `x11grab`. Ignored in window mode. |
| Audio device override | PulseAudio source name on Linux, DirectShow name on Windows. Ignored by Linux application mode and by system-excluding-Discord mode so the per-app node list is used. |
| Status refresh | How often the watch list polls `/api/status` (5–60 s). |
| Auto-watch self | Opens the player on your own stream after publishing starts. Default on. |
| Only show dock in voice | Hides the floating button outside voice channels. Default on. |
| Show diagnostics | Off by default. Shows capture and encoder warnings in the dock plus the live stats overlay on the player. Errors always remain visible. |

Settings are stored in `localStorage` under `bbBridge.config.v1` in both clients. The first launch after the 9500 kbps change migrates the old `0` default once; a later explicit `0` is preserved.
