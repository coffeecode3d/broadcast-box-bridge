export type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: {
        class?: string;
        text?: string;
        title?: string;
        type?: string;
        value?: string;
        placeholder?: string;
        disabled?: boolean;
        hidden?: boolean;
        html?: string;
        attrs?: Record<string, string>;
        on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
    } = {},
    children: Child[] = []
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (props.class) node.className = props.class;
    if (props.text != null) node.textContent = props.text;
    if (props.title) node.title = props.title;
    if (props.html != null) node.innerHTML = props.html;
    if (props.hidden) node.hidden = true;
    if (props.attrs) {
        for (const [name, value] of Object.entries(props.attrs)) node.setAttribute(name, value);
    }
    if ("type" in node && props.type) (node as HTMLInputElement).type = props.type;
    if ("value" in node && props.value != null) (node as HTMLInputElement).value = props.value;
    if ("placeholder" in node && props.placeholder) (node as HTMLInputElement).placeholder = props.placeholder;
    if ("disabled" in node && props.disabled) (node as HTMLButtonElement).disabled = true;
    if (props.on) {
        for (const [name, handler] of Object.entries(props.on)) {
            if (handler) node.addEventListener(name, handler);
        }
    }
    for (const child of children) {
        if (child == null || child === false) continue;
        node.append(typeof child === "string" || typeof child === "number" ? String(child) : child);
    }
    return node;
}

export function option(value: string, label: string, disabled = false): HTMLOptionElement {
    const node = h("option", { value, text: label });
    if (disabled) node.disabled = true;
    return node;
}

export function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (value: number) => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function formatStats(stats: {
    width?: number;
    height?: number;
    fps?: number;
    bitrateKbps?: number;
    codec?: string;
    dropped?: number;
    playbackDropped?: number;
    stalls?: number;
    lost?: number;
    dropRate?: number;
    lostRate?: number;
    presentedFps?: number;
    jitterMs?: number;
    bufferMs?: number;
}): string {
    const parts: string[] = [];
    if (stats.width && stats.height) parts.push(`${stats.width}x${stats.height}`);
    if (stats.fps) parts.push(`${Math.round(stats.fps)} fps`);
    if (stats.presentedFps) parts.push(`show ${Math.round(stats.presentedFps)}`);
    if (stats.bitrateKbps) parts.push(`${Math.round(stats.bitrateKbps)} kbps`);
    if (stats.codec) parts.push(stats.codec);
    if (stats.dropped && stats.dropped > 0) {
        parts.push(`drop ${stats.dropped}${stats.dropRate != null ? ` (${stats.dropRate.toFixed(1)}/s)` : ""}`);
    }
    if (stats.playbackDropped && stats.playbackDropped > 0) {
        parts.push(`play ${stats.playbackDropped}`);
    }
    if (stats.stalls && stats.stalls > 0) {
        parts.push(`stall ${stats.stalls}`);
    }
    if (stats.lost && stats.lost > 0) {
        parts.push(`lost ${stats.lost}${stats.lostRate != null ? ` (${stats.lostRate.toFixed(1)}/s)` : ""}`);
    }
    if (stats.jitterMs && stats.jitterMs >= 10) parts.push(`jit ${Math.round(stats.jitterMs)}ms`);
    if (stats.bufferMs) parts.push(`buf ${Math.round(stats.bufferMs)}ms`);
    return parts.join(" · ");
}
