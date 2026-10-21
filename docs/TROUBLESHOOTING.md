## Troubleshooting

| Symptom | Fix |
| --- | --- |
| **Publisher never becomes live** | Check `pnpm run doctor -- --publish --server https://your-server`. Look at the dock's **Logs**. The usual causes are Broadcast Box unreachable, UDP 8082 blocked, or a missing encoder. |
| **`session already has a host`** | Broadcast Box still has a session for that key. Stop sharing, wait a few seconds, and start again. A crashed publisher can leave a session behind until the server times it out. |
| **Black or frozen video** | On Wayland, select the correct **Monitor**. If you use a capture region, make sure it is inside that output. In window mode, choose the window in the system picker. The portal stream follows the window; there is no stale rectangle to reopen. If the portal journal shows `Out of buffers`, update `xdg-desktop-portal-hyprland` to a build with the screencopy buffer-retry fix; the packaged 1.4.1 release can freeze after a few seconds. Try `--encoder x264` to rule out the GPU encoder itself. |
| **Window list is empty** | Wayland uses the system picker instead of an in-app list, so the picker may still work even when no list is shown. X11 needs `xprop`. Windows needs `gdigrab`; reopen the share sheet after launching the app. |
| **No system picker on Wayland** | Install `xdg-desktop-portal`, the backend matching your compositor, `python-dbus`, PyGObject, and GStreamer `pipewiresrc` plus `vah264enc` or `x264enc`. Restart the portal service after installing packages. The picker can list both screens and windows; choose a window for window capture, or a screen for a full-screen share. |
| **No audio** | Linux: choose **Application audio** or **System audio (excluding Discord)**; these need `pw-dump`/`pw-record` and a running app that is producing audio. For a specific source, set **Audio device override** to the exact `pactl list short sources` name. Windows: pick a DirectShow loopback device; Windows has no default audio capture. For Windows application audio, select the virtual cable and route only the game to it. |
| **Discord voice is audible in the stream** | Use **System audio (excluding Discord)** or **Application audio**, not **System audio (everything)**. The excluding mode captures only non-Discord PipeWire nodes. |
| **Application audio list is empty** | Linux: start the game/app and reopen the share sheet. `/api/status`-style polling does not refresh this list while the dialog is open. If `pw-dump` is missing, install the PipeWire tools. Windows: install/select a virtual audio cable; `win-capture-audio` is OBS-only and cannot be opened directly by FFmpeg. |
| **New app is missing from the stream** | System-excluding-Discord and application modes snapshot the node list when sharing starts. Stop and start sharing to include a newly launched app. |
| **CPU use is high** | On Linux/Wayland screen capture, make sure **Encoder = VAAPI** and the log shows `wf-recorder ... h264_vaapi` plus `scale_vaapi`; FFmpeg should show `-c:v copy`. Wayland window mode logs `system portal` and GStreamer; install `vah264enc` so it does not fall back to `x264enc`. On Windows/AMD, check that `ffmpeg -filters` lists `vsrc_amf` and `vpp_amf`; without them the plugin uses `ddagrab` + `hwdownload` and scales on the CPU. On Windows/NVIDIA or Intel, scaling still uses the CPU when the target resolution differs from the monitor. |
| **Preview stutters, but viewers are fine** | The preview is the WHEP network stream, not a local OBS-style preview. Enable **Show diagnostics** and read the top-right stats: if `fps` is 60 with `drop 0` / `lost 0` and `stall` stays 0, the encode, network, and canvas preview are healthy, and the remaining delay is WebRTC buffering. If `drop`/`lost` climb, check packet loss and lower the bitrate or resolution. |
| **Viewers see "Stream ended"** | The `/api/status` endpoint reports offline. Confirm the publisher is still running and the derived key matches. |
| **`wf-recorder` hangs** | Screen mode is waiting for an output selection. Set **Monitor** explicitly when more than one output exists. Window mode uses the portal/GStreamer path and does not invoke wf-recorder. |
| **`UDP send blocked` / `avio_open failed`** | These were fixed by `-ts_buffer_size`, `-pkt_size 1200`, and using FFmpeg `pipe:1` for wf-recorder output. If you fork the command builder, keep those. |
| **HEVC/VP9/AV1 disabled** | FFmpeg's `whip` muxer only supports H.264 + Opus. Non-H.264 publishing would require GStreamer's `whipsink` (`gst-plugin-webrtchttp`). |

Useful commands:

```bash
# Is a key live?
curl -s "https://<your-server>/api/status?key=d-<channel>-<user>"

# Which encoders does FFmpeg have?
ffmpeg -hide_banner -encoders | grep -E '264|vaapi|nvenc|qsv|amf'

# PulseAudio sources
pactl list short sources

# Wayland outputs (Hyprland)
hyprctl monitors
```
