# Broadcast Box Bridge

Publish your screen or a single window to a self-hosted [Broadcast Box](https://github.com/Glimesh/broadcast-box) server from Discord, and watch other members' streams inside Discord. Works with **Equicord** and **BetterDiscord**, so users on either client can watch each other.

Broadcast Box Bridge uses Broadcast Box's WHIP/WHEP endpoints:

- **Publishing** captures your screen or a window with FFmpeg, uses GPU encoding when available, and sends H.264 + Opus to Broadcast Box.
- **Watching** plays the WHEP stream in a floating, draggable preview.
- **Discovery** derives a stream key from the voice channel and user ID, so both clients find each other without a registry.

**No server is bundled.** Each user enters their own Broadcast Box URL the first time they use the plugin.

## Requirements

| Component | Requirement |
| --- | --- |
| Discord | Desktop client with [Equicord](https://github.com/Equicord/Equicord) or [BetterDiscord](https://betterdiscord.app/). |
| Broadcast Box | A reachable instance with WHIP/WHEP enabled. The server needs UDP `8082` open to viewers. |
| FFmpeg | Version 6 or newer with the `whip` muxer and an H.264 encoder. GPU encoding is recommended. |
| Node.js | Node.js 20+ for BetterDiscord users. The Windows BetterDiscord zip includes `node.exe`; Linux/macOS users need Node on `PATH`. Equicord builds its own bundle. |
| Platform | Windows, Linux/X11, or Linux/Wayland. Publishing on macOS is not supported; watching may work. |

## Install

### Option 1: Prebuilt release (recommended)

Download the latest release: **[Releases](../../releases/latest)**

#### BetterDiscord

1. Download [BroadcastBoxBridge-BetterDiscord.zip](../../releases/latest/download/BroadcastBoxBridge-BetterDiscord.zip).
2. Extract it into your BetterDiscord plugins folder:
   - Windows: `%appdata%\BetterDiscord\plugins\`
   - Linux: `~/.config/BetterDiscord/plugins/`
   - macOS: `~/Library/Application Support/BetterDiscord/plugins/`

   The folder should contain `BroadcastBoxBridge.plugin.js` and a `BroadcastBoxBridge/` folder with `node.exe`.

3. Restart Discord, open **Settings → BetterDiscord → Plugins**, and enable **BroadcastBoxBridge**.
4. On Linux/macOS, install Node.js 20+ and make sure `node` is on `PATH`. The bundled `node.exe` is only used on Windows.

#### Equicord

1. Download [BroadcastBoxBridge-Equicord.zip](../../releases/latest/download/BroadcastBoxBridge-Equicord.zip).
2. Extract the `broadcastBoxBridge` folder into your Equicord source checkout:

   ```text
   <your Equicord checkout>/src/userplugins/broadcastBoxBridge
   ```

3. Build Equicord:

   ```bash
   cd <your Equicord checkout>
   pnpm install
   pnpm build
   pnpm inject --install
   ```

4. Restart Discord, open **Settings → Equicord → Plugins**, and enable **BroadcastBoxBridge**.

### Option 2: Build from source

```bash
git clone https://github.com/coffeecode3d/broadcast-box-bridge.git
cd broadcast-box-bridge
pnpm install
pnpm build
```

The default build creates the BetterDiscord bundle and syncs the Equicord userplugin when an Equicord checkout is available. Set `EQUICORD_DIR` if your checkout is not at `~/Equicord`:

```bash
EQUICORD_DIR=/path/to/Equicord pnpm build
```

Useful build scripts:

```bash
pnpm typecheck              # TypeScript check
pnpm build                  # build plugin files, sync Equicord if present
pnpm build:bd               # BetterDiscord bundle only
pnpm install:bd             # copy the plugin into BetterDiscord's plugin folder
pnpm doctor                 # machine capability diagnostics
```

## Platform setup

### Windows

1. Install a full FFmpeg build with the `whip` muxer and an H.264 hardware encoder:
   - NVIDIA: `h264_nvenc` and `ddagrab`
   - AMD: a recent build with `vsrc_amf`, `vpp_amf`, and `h264_amf`
   - Intel: `h264_qsv` and `ddagrab`

   Add the FFmpeg `bin` folder to `PATH` and confirm it is visible:

   ```powershell
   ffmpeg -hide_banner -muxers | findstr whip
   ffmpeg -hide_banner -encoders | findstr 264
   ```

2. Install the BetterDiscord release zip. It includes `node.exe`, so a separate Node install is optional.
3. For application audio, install a virtual audio cable and route only the app you want to capture to it. Select that cable in the share sheet.
4. Window capture uses `gdigrab title=...`; screen capture uses the fastest available GPU path.

### Linux

Install FFmpeg and the capture/audio tools for your distribution. A typical set is:

```bash
# Debian/Ubuntu package names; adjust for your distribution
sudo apt install ffmpeg wf-recorder pipewire pipewire-pulse \
  python3-dbus python3-gi gstreamer1.0-pipewire gstreamer1.0-vaapi
```

- **Wayland screen/region capture** uses `wf-recorder`. Set **Monitor** in Advanced when you have more than one output.
- **Wayland window capture** uses the xdg-desktop-portal ScreenCast picker and PipeWire. See [docs/WAYLAND.md](docs/WAYLAND.md) for the required portal packages and Hyprland configuration.
- **X11** screen capture uses `x11grab`; window capture also needs `xprop`.
- **Application audio** and **System audio (excluding Discord)** use `pw-dump` and `pw-record`.
- VAAPI (`/dev/dri/renderD128`) is preferred; the plugin falls back to `libx264` if needed.

## Configure and share

1. Join a Discord voice channel.
2. Click the floating **BB** button.
3. Open **Advanced** and enter your own Broadcast Box base URL, for example `https://box.example.com`. The plugin has no built-in default server.
4. Click **Start sharing**, choose screen or window, resolution, frame rate, and audio, then press **Start sharing** in the share sheet.
5. Your preview opens as a floating window. Drag it by the title bar, resize it from the bottom-right corner, or double-click the video for fullscreen.
6. Other Bridge users in the same voice channel appear in the **Watch** list and can watch inside Discord.

The bitrate defaults to `9500 kbps` and is saved when changed. **Show diagnostics** is off by default; it controls the dock warning banner and the player's live stats overlay. Errors are always shown.

## Troubleshooting

| Symptom | Try |
| --- | --- |
| Publisher never goes live | Check the dock **Logs**, verify the server URL, and run `pnpm doctor -- --publish --server https://your-server`. Confirm UDP `8082` is reachable. |
| Broadcast Box unreachable | Check the URL in **Advanced**, including `https://`, and make sure the server is running. |
| Black or frozen video | On Wayland, select the correct **Monitor** and check the portal log. For Hyprland window capture, follow [docs/WAYLAND.md](docs/WAYLAND.md). |
| No audio | Linux: select **Application audio** or **System audio (excluding Discord)** and make sure the app is playing sound. Windows: select a loopback/virtual cable device. |
| CPU usage is high | Use the VAAPI, NVENC, QSV, or AMF encoder, and check that FFmpeg reports the hardware encoder. |
| Preview stutters but viewers are fine | The preview is a real WHEP stream, not a local capture preview. Enable **Show diagnostics** to inspect FPS, drops, loss, and buffering. |

More fixes and commands: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Documentation

- [Installation and platform notes](docs/INSTALL.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Architecture and stream keys](docs/ARCHITECTURE.md)
- [Wayland window capture](docs/WAYLAND.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## Security and privacy

- Stream keys are derived from public Discord IDs (`d-<channel>-<user>`). They are **not encryption keys**; anyone who can derive the key can watch. Use a private voice channel and a trusted Broadcast Box server. If you need stronger access control, put Broadcast Box behind an auth proxy.
- The local WHIP proxy binds only to `127.0.0.1` and exists only while publishing.
- The plugin does not ship a server URL, stream key, token, or personal configuration. Settings are stored locally in Discord's `localStorage`.
- Publishing captures only the screen, region, or window you select. Linux application audio captures the selected app's PipeWire output; system-audio-excluding-Discord captures non-Discord application nodes.

## License

Copyright (C) 2026 BroadcastBoxBridge contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but **without any warranty**; without even the implied warranty of merchantability or fitness for a particular purpose. See the [GNU General Public License](LICENSE) for more details.

The project is GPL-3.0-or-later so it can be combined with the GPL-licensed Vencord and Equicord plugin APIs. BetterDiscord is Apache-2.0 and remains compatible. Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
