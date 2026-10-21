# Installation details

The quick-start instructions are in the main [README](../README.md). This page covers the two client formats and the platform packages in more detail.

There is no bundled Broadcast Box server. After installing, open the plugin's **Advanced** settings (or the share sheet's **Advanced options**) and enter your own server URL.

## BetterDiscord

### Windows

1. Download `BroadcastBoxBridge-BetterDiscord.zip` from [Releases](../../../releases/latest).
2. Extract its contents into `%appdata%\BetterDiscord\plugins\`.
3. Confirm the folder now contains:

   ```text
   plugins/
     BroadcastBoxBridge.plugin.js
     BroadcastBoxBridge/
       node.exe
   ```

4. Restart Discord, open **Settings → BetterDiscord → Plugins**, and enable **BroadcastBoxBridge**.

The included `node.exe` is the helper runtime. If you already have Node.js 20+ installed, the plugin can use that instead.

### Linux and macOS

BetterDiscord does not include a Node runtime for these platforms.

1. Install Node.js 20+ so `node` is on `PATH`.
2. Download and extract `BroadcastBoxBridge-BetterDiscord.zip` into the BetterDiscord plugins folder:
   - Linux: `~/.config/BetterDiscord/plugins/`
   - macOS: `~/Library/Application Support/BetterDiscord/plugins/`
3. The `node.exe` file from the zip is not used on these platforms; you can delete it.
4. Restart Discord and enable the plugin in **Settings → BetterDiscord → Plugins**.

## Equicord

Equicord userplugins are built from source.

1. Download `BroadcastBoxBridge-Equicord.zip`.
2. Extract the `broadcastBoxBridge` folder into your Equicord checkout:

   ```text
   <your Equicord checkout>/src/userplugins/broadcastBoxBridge
   ```

3. Build and inject Equicord:

   ```bash
   cd <your Equicord checkout>
   pnpm install
   pnpm build
   pnpm inject --install
   ```

4. Restart Discord and enable **BroadcastBoxBridge** in **Settings → Equicord → Plugins**.

Keep the folder name exactly `broadcastBoxBridge`; the native adapter registers its helper under that name.

## Building from a source checkout

```bash
git clone https://github.com/coffeecode3d/broadcast-box-bridge.git
cd broadcast-box-bridge
pnpm install
```

Build everything and sync the Equicord userplugin:

```bash
EQUICORD_DIR=/path/to/Equicord pnpm build
```

If `EQUICORD_DIR` is unset, the build looks for `~/Equicord`. When no checkout is found it still builds the BetterDiscord bundle and skips the userplugin sync.

Useful commands:

```bash
pnpm typecheck
pnpm build:bd
pnpm install:bd
pnpm doctor
```

## Windows dependencies

- **FFmpeg**: install a full build with the `whip` muxer and a hardware H.264 encoder.
  - NVIDIA: `h264_nvenc`, `ddagrab`
  - AMD: `vsrc_amf`, `vpp_amf`, `h264_amf`
  - Intel: `h264_qsv`, `ddagrab`
- Add FFmpeg's `bin` directory to `PATH`.
- Verify:

  ```powershell
  ffmpeg -hide_banner -muxers | findstr whip
  ffmpeg -hide_banner -encoders | findstr 264
  ```

- For application audio, install a virtual audio cable and route the app to it from Windows **Settings → System → Sound → Volume mixer**. Select the cable in the share sheet.
- Window capture uses `gdigrab title=...`; screen capture prefers `vsrc_amf` or `ddagrab`.

## Linux dependencies

Install FFmpeg and the tools needed for your capture path. On Debian/Ubuntu:

```bash
sudo apt install ffmpeg wf-recorder pipewire pipewire-pulse \
  python3-dbus python3-gi gstreamer1.0-pipewire gstreamer1.0-vaapi
```

Package names vary by distribution. The plugin uses:

- `wf-recorder` for Wayland screen/region capture.
- xdg-desktop-portal + PipeWire/GStreamer for Wayland window capture.
- `x11grab` for X11 and `xprop` for X11 window enumeration.
- `pw-dump` and `pw-record` for application audio and system audio excluding Discord.
- VAAPI (`/dev/dri/renderD128`) for GPU encoding, with `libx264` as a fallback.

For Hyprland window-capture requirements and the required portal configuration, see [WAYLAND.md](WAYLAND.md).

## Updating

- **BetterDiscord**: replace `BroadcastBoxBridge.plugin.js` with the new release and restart Discord.
- **Equicord**: replace the `broadcastBoxBridge` folder, then run `pnpm build` and `pnpm inject --install` again.
- **Source checkout**: pull the latest changes, run `pnpm install`, then rebuild.
