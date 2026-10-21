import { normalizeServer } from "./config";

export interface WHEPStats {
    width?: number;
    height?: number;
    fps?: number;
    /** Total bytes received so far; callers compute a rate from deltas. */
    bytesReceived?: number;
    framesDecoded?: number;
    framesReceived?: number;
    framesDropped?: number;
    packetsLost?: number;
    jitter?: number;
    /** Cumulative delay (seconds) spent in the playout buffer. */
    jitterBufferDelay?: number;
    /** Number of frames that have left the playout buffer. */
    jitterBufferEmittedCount?: number;
    /** Selected ICE candidate pair round-trip time, in seconds. */
    rtt?: number;
    /** Chromium's decoder name, when it reports one. */
    decoderImplementation?: string;
    /** True when Chromium reports a hardware/power-efficient decoder. */
    powerEfficientDecoder?: boolean;
    codec?: string;
}

export interface WHEPConnectResult {
    stream: MediaStream;
    videoTrack: MediaStreamTrack | null;
    audioTrack: MediaStreamTrack | null;
    pc: RTCPeerConnection;
    stats(): Promise<WHEPStats>;
}

const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Minimal WHEP (WebRTC-HTTP Egress Protocol) client tuned for Broadcast Box.
 *
 * Broadcast Box answers the POST with a complete SDP answer (no trickle ICE),
 * so we wait for local ICE gathering to finish before sending the offer.
 */
export class WHEPConnection {
    private pc: RTCPeerConnection | null = null;
    private stream: MediaStream | null = null;
    private closed = false;

    constructor(
        private readonly server: string,
        private readonly key: string,
        private readonly callbacks: { onConnectionState?: (state: RTCPeerConnectionState) => void } = {}
    ) {}

    get mediaStream(): MediaStream | null {
        return this.stream;
    }

    get peerConnection(): RTCPeerConnection | null {
        return this.pc;
    }

    get connectionState(): RTCPeerConnectionState | null {
        return this.pc?.connectionState ?? null;
    }

    async stats(): Promise<WHEPStats> {
        if (!this.pc) return {};
        return collectStats(this.pc);
    }

    async connect(): Promise<WHEPConnectResult> {
        this.disconnect();
        this.closed = false;

        const base = normalizeServer(this.server);
        const pc = new RTCPeerConnection({
            bundlePolicy: "max-bundle",
            rtcpMuxPolicy: "require",
            iceCandidatePoolSize: 0
        });
        this.pc = pc;
        const stream = new MediaStream();
        this.stream = stream;

        let videoTrack: MediaStreamTrack | null = null;
        let audioTrack: MediaStreamTrack | null = null;

        pc.addTransceiver("audio", { direction: "recvonly" });
        pc.addTransceiver("video", { direction: "recvonly" });

        pc.ontrack = event => {
            if (stream.getTracks().includes(event.track)) return;
            stream.addTrack(event.track);
            if (event.track.kind === "video") videoTrack = event.track;
            if (event.track.kind === "audio") audioTrack = event.track;
            this.lowLatency(pc);
        };

        pc.onconnectionstatechange = () => this.callbacks.onConnectionState?.(pc.connectionState);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await this.waitForIce(pc, 4_000);
        if (this.closed) throw new Error("Playback was cancelled.");

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
        let response: Response;
        try {
            response = await fetch(`${base}/api/whep`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.key}`,
                    "Content-Type": "application/sdp"
                },
                body: pc.localDescription?.sdp ?? "",
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }

        const answer = await response.text();
        if (!response.ok) {
            this.disconnect();
            throw new Error(describeWhepError(response.status, answer));
        }

        await pc.setRemoteDescription({ type: "answer", sdp: answer });
        this.lowLatency(pc);

        return {
            stream,
            get videoTrack() {
                return videoTrack;
            },
            get audioTrack() {
                return audioTrack;
            },
            pc,
            stats: () => collectStats(pc)
        } as WHEPConnectResult;
    }

    disconnect(): void {
        this.closed = true;
        if (this.pc) {
            try {
                this.pc.ontrack = null;
                this.pc.onconnectionstatechange = null;
                this.pc.close();
            } catch {
                // ignored
            }
        }
        if (this.stream) {
            for (const track of this.stream.getTracks()) {
                try {
                    track.stop();
                } catch {
                    // ignored
                }
            }
        }
        this.pc = null;
        this.stream = null;
    }

    private lowLatency(pc: RTCPeerConnection) {
        // A tiny jitter buffer makes Chromium discard late frames, which looks
        // like stutter whenever the network or the game GPU has a small hitch.
        // 120 ms is still low-latency for a preview but absorbs normal jitter.
        const targetMs = 120;
        for (const receiver of pc.getReceivers()) {
            // Non-standard but supported by Chromium/Electron.
            const anyReceiver = receiver as unknown as { playoutDelayHint?: number; jitterBufferTarget?: number };
            try {
                anyReceiver.playoutDelayHint = targetMs / 1000;
                anyReceiver.jitterBufferTarget = targetMs;
            } catch {
                // ignored
            }
        }
    }

    private async waitForIce(pc: RTCPeerConnection, timeoutMs: number) {
        if (pc.iceGatheringState === "complete") return;
        await new Promise<void>(resolve => {
            const timer = setTimeout(done, timeoutMs);
            function done() {
                clearTimeout(timer);
                pc.removeEventListener("icegatheringstatechange", onChange);
                resolve();
            }
            function onChange() {
                if (pc.iceGatheringState === "complete") done();
            }
            pc.addEventListener("icegatheringstatechange", onChange);
        });
    }
}

function describeWhepError(status: number, body: string): string {
    const trimmed = body.trim().slice(0, 300);
    if (status === 404) return "Stream is offline (Broadcast Box could not find this stream key).";
    if (status === 401 || status === 403) return "Broadcast Box rejected the stream key.";
    return `Playback failed: HTTP ${status}${trimmed ? ` - ${trimmed}` : ""}`;
}

async function collectStats(pc: RTCPeerConnection): Promise<WHEPStats> {
    const result: WHEPStats = {};
    if (pc.connectionState === "closed") return result;

    let codecId: string | undefined;
    let stats: RTCStatsReport;
    try {
        stats = await pc.getStats();
    } catch {
        return result;
    }

    stats.forEach(report => {
        if (report.type === "inbound-rtp" && report.kind === "video") {
            result.width = report.frameWidth || result.width;
            result.height = report.frameHeight || result.height;
            result.framesDecoded = report.framesDecoded;
            result.framesReceived = report.framesReceived;
            result.framesDropped = report.framesDropped;
            result.packetsLost = report.packetsLost;
            result.jitter = report.jitter;
            result.jitterBufferDelay = report.jitterBufferDelay;
            result.jitterBufferEmittedCount = report.jitterBufferEmittedCount;
            result.decoderImplementation = report.decoderImplementation;
            result.powerEfficientDecoder = report.powerEfficientDecoder;
            if (report.framesPerSecond) result.fps = report.framesPerSecond;
            if (report.bytesReceived) result.bytesReceived = report.bytesReceived;
            codecId = report.codecId;
        }
        if (
            report.type === "candidate-pair" &&
            (report.nominated || report.selected) &&
            report.state === "succeeded" &&
            typeof report.currentRoundTripTime === "number"
        ) {
            result.rtt = report.currentRoundTripTime;
        }
    });

    if (codecId) {
        const codec = stats.get(codecId) as { mimeType?: string } | undefined;
        if (codec?.mimeType) result.codec = codec.mimeType.replace(/^video\//i, "").toUpperCase();
    }

    return result;
}
