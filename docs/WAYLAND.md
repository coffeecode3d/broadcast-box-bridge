# Wayland window capture

Wayland window capture uses the **xdg-desktop-portal ScreenCast** interface. The compositor opens a system picker, then exposes the chosen window as a PipeWire stream. The plugin keeps that stream alive, so the capture follows the window when it moves and recovers after a resize.

The portal itself is responsible for the picker and the screencopy stream. Support varies by compositor and portal version.

## Packages

Install the portal frontend, the backend for your compositor, and the Python/GStreamer pieces:

- `xdg-desktop-portal`
- `xdg-desktop-portal-hyprland`, `-wlr`, `-gnome`, or `-kde`
- `python3-dbus` and `python3-gi` (PyGObject)
- GStreamer `pipewiresrc`
- `vah264enc` (VAAPI) or `x264enc`

On Arch-based systems the GStreamer pieces are usually in `gstreamer` / `gstreamer-vaapi`; on Debian/Ubuntu they are `gstreamer1.0-pipewire` and `gstreamer1.0-vaapi`.

Restart the portal services after installing packages:

```bash
systemctl --user restart xdg-desktop-portal-hyprland.service xdg-desktop-portal.service
```

## Hyprland

Hyprland's packaged `xdg-desktop-portal-hyprland` 1.4.1 can stop producing frames after a few seconds with `Out of buffers` messages. Use a build containing the screencopy buffer-retry fix from upstream `master`, or a distribution package with that fix backported.

Add this to `~/.config/hypr/xdph.conf`:

```ini
screencopy:force_shm = 1
screencopy:allow_token_by_default = 1
```

- `force_shm` avoids a DMA/SHM format renegotiation loop on some compositor/window combinations.
- `allow_token_by_default` lets the plugin restore the selected window after a resize without showing the picker again.

Restart both portal services after changing the file.

If window capture still freezes:

1. Confirm the portal log no longer repeatedly reports `[screencopy/pipewire] Out of buffers`.
2. Try **Screen** capture, which uses `wf-recorder` and does not go through the portal.
3. Check that the correct backend is running:

   ```bash
   systemctl --user status xdg-desktop-portal-hyprland.service
   journalctl --user -u xdg-desktop-portal-hyprland.service -n 100 --no-pager
   ```

## X11

X11 does not use the portal. Window capture enumerates windows with `xprop` and captures the selected window with `x11grab -window_id`. Screen capture uses `x11grab` with the selected output geometry.
