export const SHARED_CSS = `
:host, .bb-root {
    --bb-bg: #111214;
    --bb-bg-2: #1b1c1f;
    --bb-bg-3: #26272b;
    --bb-line: #2e3035;
    --bb-text: #f2f3f5;
    --bb-muted: #a3a6ad;
    --bb-blurple: #5865f2;
    --bb-green: #23a55a;
    --bb-red: #ed4245;
    --bb-yellow: #f0b232;
    font-family: "gg sans", "Noto Sans", "Segoe UI", system-ui, sans-serif;
    color: var(--bb-text);
    font-size: 13px;
    line-height: 1.35;
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input, select {
    font: inherit;
    color: inherit;
}
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .45; }
.bb-icon {
    appearance: none;
    background: transparent;
    border: 0;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--bb-muted);
    flex: 0 0 auto;
}
.bb-icon:hover { background: var(--bb-bg-3); color: var(--bb-text); }
.bb-btn {
    appearance: none;
    border: 1px solid var(--bb-line);
    background: var(--bb-bg-3);
    border-radius: 7px;
    padding: 6px 10px;
    color: var(--bb-text);
    font-weight: 600;
    white-space: nowrap;
}
.bb-btn:hover:not(:disabled) { background: #313239; }
.bb-btn.primary { background: var(--bb-blurple); border-color: transparent; }
.bb-btn.primary:hover:not(:disabled) { background: #4752c4; }
.bb-btn.danger { background: transparent; border-color: #5c2a2c; color: #ff8f92; }
.bb-btn.danger:hover:not(:disabled) { background: #3a1d1f; }
.bb-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bb-muted); box-shadow: 0 0 0 2px rgba(0,0,0,.25); flex: 0 0 auto; }
.bb-dot.live { background: var(--bb-green); }
.bb-dot.busy { background: var(--bb-yellow); animation: bb-pulse 1.2s ease-in-out infinite; }
.bb-dot.error { background: var(--bb-red); }
.bb-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: .06em;
    padding: 2px 5px;
    background: #3c2022;
    color: #ff9a9c;
    text-transform: uppercase;
}
.bb-badge.on { background: #16351f; color: #57f287; }
.bb-badge.off { background: var(--bb-bg-3); color: var(--bb-muted); }
@keyframes bb-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
@keyframes bb-spin { to { transform: rotate(360deg); } }
.bb-spin {
    width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,.25);
    border-top-color: #fff;
    animation: bb-spin .8s linear infinite;
    display: inline-block;
}
`;

export const FIELD_CSS = `
.bb-field { display: grid; gap: 4px; }
.bb-field > span { color: var(--bb-muted); font-size: 11px; font-weight: 600; letter-spacing: .02em; }
.bb-field input[type="text"], .bb-field input[type="number"], .bb-field select {
    appearance: none;
    width: 100%;
    background: var(--bb-bg);
    border: 1px solid var(--bb-line);
    border-radius: 6px;
    padding: 6px 8px;
    outline: none;
    min-width: 0;
}
.bb-field select { padding-right: 22px; background-image: linear-gradient(45deg, transparent 50%, #a3a6ad 50%), linear-gradient(135deg, #a3a6ad 50%, transparent 50%); background-position: calc(100% - 12px) 50%, calc(100% - 8px) 50%; background-size: 4px 4px, 4px 4px; background-repeat: no-repeat; }
.bb-field input:focus, .bb-field select:focus { border-color: var(--bb-blurple); }
.bb-check { display: flex; gap: 8px; align-items: flex-start; color: var(--bb-text); }
.bb-check input { margin: 2px 0 0; accent-color: var(--bb-blurple); }
.bb-hint { color: var(--bb-muted); font-size: 10.5px; }
.bb-tabs {
    display: flex; gap: 4px;
    border-bottom: 1px solid var(--bb-line);
    padding-bottom: 6px;
}
.bb-tab {
    appearance: none;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--bb-muted);
    padding: 5px 9px;
    font-size: 11.5px;
    font-weight: 700;
}
.bb-tab:hover { background: var(--bb-bg-3); color: var(--bb-text); }
.bb-tab.active { background: var(--bb-bg-3); border-color: var(--bb-line); color: var(--bb-text); }
.bb-tab-panel { display: grid; gap: 10px; }
.bb-advanced-wrap { display: grid; gap: 8px; }
.bb-advanced { display: grid; gap: 10px; border-top: 1px solid var(--bb-line); padding-top: 10px; }
.bb-advanced-toggle { justify-self: start; }
.bb-link {
    appearance: none;
    background: none;
    border: 0;
    color: var(--bb-muted);
    text-decoration: underline;
    padding: 0;
    font-size: 10.5px;
}
.bb-link:hover { color: var(--bb-text); }
`;

export const DOCK_CSS = `
${SHARED_CSS}
${FIELD_CSS}
.bb-root { position: fixed; right: 16px; bottom: 78px; z-index: 2147483000; }
.bb-fab {
    position: relative;
    width: 42px; height: 42px;
    margin-left: auto;
    border-radius: 50%;
    border: 1px solid var(--bb-line);
    background: linear-gradient(180deg, #2a2b31, #1a1b1f);
    color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 12px; letter-spacing: .02em;
    box-shadow: 0 6px 20px rgba(0,0,0,.45);
}
.bb-fab:hover { border-color: #45474f; transform: translateY(-1px); }
.bb-fab .bb-dot { position: absolute; right: -1px; top: -1px; border: 2px solid var(--bb-bg-2); width: 11px; height: 11px; }
.bb-panel {
    width: 324px;
    max-height: min(72vh, 640px);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    margin-bottom: 8px;
    border-radius: 12px;
    border: 1px solid var(--bb-line);
    background: var(--bb-bg-2);
    box-shadow: 0 16px 48px rgba(0,0,0,.55);
}
.bb-head {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 10px 10px 12px;
    border-bottom: 1px solid var(--bb-line);
    background: linear-gradient(180deg, #232428, #1b1c1f);
}
.bb-logo {
    width: 26px; height: 26px; border-radius: 7px;
    display: grid; place-items: center;
    background: var(--bb-blurple);
    color: #fff; font-weight: 800; font-size: 10.5px;
    flex: 0 0 auto;
}
.bb-title { display: grid; min-width: 0; flex: 1; }
.bb-title b { font-size: 13px; line-height: 1.2; }
.bb-sub { color: var(--bb-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bb-body { overflow-y: auto; padding: 10px 12px 12px; display: grid; gap: 10px; }
.bb-body::-webkit-scrollbar { width: 8px; }
.bb-body::-webkit-scrollbar-thumb { background: #2e3035; border-radius: 4px; }
.bb-row { display: flex; align-items: center; gap: 8px; }
.bb-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.bb-kv { display: grid; gap: 2px; min-width: 0; flex: 1; }
.bb-k { color: var(--bb-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .07em; font-weight: 700; }
.bb-v { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bb-key { font-family: ui-monospace, "Cascadia Mono", Menlo, monospace; font-size: 10.5px; color: #c9ccd3; }
.bb-primary { width: 100%; padding: 8px 12px; font-size: 13px; }
.bb-quick { display: grid; grid-template-columns: 1.35fr .7fr 1fr; gap: 8px; }
.bb-quick .bb-app-row { grid-column: 1 / -1; }
.bb-quick .bb-field > span { font-size: 10px; }
.bb-quick select { padding: 5px 6px; }
.bb-error {
    border: 1px solid #5c2a2c; background: #2b191a; color: #ffb3b5;
    border-radius: 7px; padding: 7px 9px; font-size: 11.5px;
    white-space: pre-wrap; word-break: break-word;
}
.bb-warn {
    border: 1px solid #4f3c16; background: #2a2213; color: #f5d78a;
    border-radius: 7px; padding: 7px 9px; font-size: 11.5px;
}
.bb-section-title {
    display: flex; align-items: center; gap: 6px;
    color: var(--bb-muted);
    font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .07em;
}
.bb-count {
    background: var(--bb-bg-3); color: var(--bb-text);
    border-radius: 9px; padding: 0 6px; font-size: 10px; line-height: 15px;
}
.bb-members { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.bb-member { display: flex; align-items: center; gap: 8px; padding: 5px 4px; border-radius: 7px; }
.bb-member:hover { background: #232428; }
.bb-avatar {
    width: 24px; height: 24px; border-radius: 50%; flex: 0 0 auto;
    background: #36373d center/cover no-repeat;
    display: grid; place-items: center;
    font-size: 10px; font-weight: 800; color: #cfd2d8;
}
.bb-member-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.bb-member-name small { color: var(--bb-muted); font-size: 10px; }
.bb-member .bb-btn { padding: 4px 9px; font-size: 11px; }
.bb-empty { color: var(--bb-muted); font-size: 11.5px; padding: 2px 2px 4px; }
.bb-settings { display: grid; gap: 10px; border-top: 1px solid var(--bb-line); padding-top: 10px; }
.bb-settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.bb-foot {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    border-top: 1px solid var(--bb-line); padding-top: 8px;
    color: var(--bb-muted); font-size: 10.5px;
}
.bb-link { appearance: none; background: none; border: 0; color: var(--bb-muted); text-decoration: underline; padding: 0; font-size: 10.5px; }
.bb-link:hover { color: var(--bb-text); }
.bb-logs { border-top: 1px solid var(--bb-line); background: #0b0c0e; padding: 8px; }
.bb-logs pre {
    margin: 0 0 8px; max-height: 180px; overflow: auto;
    font-family: ui-monospace, "Cascadia Mono", Menlo, monospace;
    font-size: 10px; line-height: 1.45; white-space: pre-wrap; word-break: break-word;
    color: #b9bec7;
}
.bb-logs .bb-between { margin-bottom: 6px; color: var(--bb-muted); font-size: 10.5px; }
`;

export const PLAYER_CSS = `
${SHARED_CSS}
.bb-player {
    position: fixed;
    left: 24px; top: 64px;
    width: 640px; height: 386px;
    min-width: 320px; min-height: 220px;
    max-width: 96vw; max-height: 92vh;
    resize: none;
    overflow: hidden;
    border-radius: 12px;
    border: 1px solid var(--bb-line);
    background: #000;
    box-shadow: 0 24px 70px rgba(0,0,0,.65);
    display: flex; flex-direction: column;
    z-index: 2147483001;
}
.bb-player:fullscreen {
    left: 0 !important; top: 0 !important; right: auto !important; bottom: auto !important;
    width: 100vw !important; height: 100vh !important;
    max-width: none !important; max-height: none !important;
    min-width: 0 !important; min-height: 0 !important;
    border: 0 !important; border-radius: 0 !important;
    box-shadow: none !important;
}
.bb-player:fullscreen::backdrop { background: #000; }
.bb-player:fullscreen {
    inset: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    max-width: none !important;
    max-height: none !important;
    margin: 0 !important;
    border-radius: 0 !important;
}
.bb-player:fullscreen .bb-player-bar {
    position: absolute;
    left: 0; right: 0; top: 0;
    z-index: 5;
    border-bottom: 0;
    background: linear-gradient(180deg, rgba(10,10,12,.88), rgba(10,10,12,0));
    opacity: 0;
    pointer-events: none;
    transition: opacity .16s ease;
}
.bb-player:fullscreen .bb-player-ctl {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    z-index: 5;
    background: linear-gradient(0deg, rgba(10,10,12,.9), rgba(10,10,12,0));
    border-top: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity .16s ease;
}
.bb-player:fullscreen .bb-player-stage { position: absolute; inset: 0; }
.bb-player:fullscreen .bb-player-stats { top: 46px; }
.bb-player:fullscreen .bb-resize { display: none; }
.bb-player:fullscreen.controls-visible .bb-player-bar,
.bb-player:fullscreen.controls-visible .bb-player-ctl,
.bb-player:fullscreen .bb-player-bar:hover,
.bb-player:fullscreen .bb-player-ctl:hover {
    opacity: 1;
    pointer-events: auto;
}
.bb-player:fullscreen:not(.controls-visible) { cursor: none; }
.bb-player-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px 6px 10px;
    background: linear-gradient(180deg, rgba(27,28,31,.98), rgba(17,18,20,.92));
    border-bottom: 1px solid var(--bb-line);
    cursor: move; user-select: none;
    flex: 0 0 auto;
}
.bb-player-title { font-weight: 700; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 340px; }
.bb-player-stage { position: relative; flex: 1; min-height: 0; background: #000; contain: paint; }
.bb-player-stage video {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    object-fit: contain; display: block;
    background: #000;
    opacity: 0;
    pointer-events: none;
}
.bb-player-stage canvas.bb-preview-canvas {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    display: block;
    background: #000;
}
.bb-player-overlay {
    position: absolute; inset: 0;
    display: grid; place-items: center; align-content: center; gap: 8px;
    background: radial-gradient(circle at center, rgba(30,31,36,.86), rgba(10,10,12,.94));
    color: var(--bb-muted); font-size: 12px; text-align: center; padding: 20px;
}
.bb-player-overlay b { color: var(--bb-text); font-size: 13px; }
.bb-player-stats {
    position: absolute; right: 8px; top: 8px;
    background: rgba(0,0,0,.62); border-radius: 5px;
    padding: 3px 6px; font-size: 10px; color: #c8ccd4;
    font-family: ui-monospace, "Cascadia Mono", Menlo, monospace;
    pointer-events: none;
}
.bb-player-ctl {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px;
    background: var(--bb-bg-2);
    border-top: 1px solid var(--bb-line);
    flex: 0 0 auto;
}
.bb-player-ctl input[type="range"] { width: 84px; accent-color: var(--bb-blurple); }
.bb-player-ctl .bb-spacer { flex: 1; }
.bb-player-ctl .bb-icon { width: 28px; height: 26px; font-size: 13px; }
.bb-vol-label { color: var(--bb-muted); font-size: 10.5px; min-width: 26px; text-align: right; }
.bb-resize {
    position: absolute;
    right: 0; bottom: 0;
    width: 18px; height: 18px;
    cursor: nwse-resize;
    z-index: 6;
    background:
        linear-gradient(135deg, transparent 0 46%, rgba(255,255,255,.42) 47% 52%, transparent 53% 100%),
        linear-gradient(135deg, transparent 0 60%, rgba(255,255,255,.32) 61% 66%, transparent 67% 100%);
    opacity: .7;
}
.bb-resize:hover { opacity: 1; }
.bb-player.floating .bb-popout { display: none; }

/* Docked mode: fills the user's voice tile and behaves like a native preview. */
.bb-player.docked {
    position: absolute;
    inset: 0;
    width: 100%; height: 100%;
    min-width: 0; min-height: 0;
    max-width: none; max-height: none;
    border: 0;
    border-radius: 8px;
    box-shadow: none;
    pointer-events: none;
}
.bb-player.docked .bb-player-bar {
    position: absolute;
    left: 0; right: 0; top: 0;
    z-index: 4;
    border-bottom: 0;
    background: linear-gradient(180deg, rgba(10,10,12,.86), rgba(10,10,12,0));
    opacity: 0;
    transition: opacity .12s ease;
    pointer-events: auto;
    cursor: default;
}
.bb-player.docked .bb-player-bar:hover,
.bb-player.docked .bb-player-bar:focus-within {
    opacity: 1;
}
.bb-player.docked .bb-player-ctl,
.bb-player.docked .bb-resize,
.bb-player.docked .bb-pip { display: none; }
.bb-player.docked .bb-player-stats {
    display: block;
    right: 6px; top: 6px;
    max-width: 72%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 9px;
    opacity: .72;
}
.bb-player.docked .bb-player-title { max-width: 45%; }
.bb-player.docked .bb-player-stage video { object-fit: contain; }
.bb-player.docked .bb-player-overlay { border-radius: 8px; }
`;

export const DIALOG_CSS = `
${SHARED_CSS}
${FIELD_CSS}
.bb-modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483002;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(0, 0, 0, .66);
    backdrop-filter: blur(2px);
}
.bb-modal {
    width: min(470px, 94vw);
    max-height: min(88vh, 720px);
    overflow: auto;
    border: 1px solid var(--bb-line);
    border-radius: 14px;
    background: var(--bb-bg-2);
    box-shadow: 0 24px 80px rgba(0,0,0,.65);
}
.bb-modal-head {
    padding: 16px 18px 12px;
    border-bottom: 1px solid var(--bb-line);
    background: linear-gradient(180deg, #232428, #1b1c1f);
    border-radius: 14px 14px 0 0;
}
.bb-modal-head h2 { margin: 0 0 3px; font-size: 16px; line-height: 1.25; }
.bb-modal-head p { margin: 0; color: var(--bb-muted); font-size: 12px; }
.bb-modal-body { display: grid; gap: 12px; padding: 16px 18px; }
.bb-modal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.bb-modal-foot {
    display: flex; align-items: center; justify-content: flex-end; gap: 8px;
    padding: 12px 18px 16px;
    border-top: 1px solid var(--bb-line);
}
.bb-modal-foot .bb-btn { padding: 8px 14px; }
.bb-audio-hint { min-height: 14px; }
.bb-device-row[hidden] { display: none; }
.bb-app-row[hidden] { display: none; }
`;

