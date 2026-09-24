import workletUrl from './audio-worklet.ts?worker&url';
import type { CaptionPacket, PlaybackStats } from './playback-types';
import { microsecondsToPts } from './video-frame';
import { createVideoRenderer, type VideoRenderer } from './video-renderer';

// Covers the audio ahead of video plus Bluetooth output latency; fewer evicts frames before they are due.
const MAX_QUEUED_FRAMES = 90;

interface Clock {
  pts?: number;
  contextTime: number;
  queued: number;
  underruns: number;
  running: boolean;
  generation: number;
}
export class FullSegPlayer {
  private worker = new Worker(new URL('../workers/playback.ts', import.meta.url), {
    type: 'module',
  });
  private context?: AudioContext;
  private audio?: AudioWorkletNode;
  private gain?: GainNode;
  private volumeLevel = 1;
  private analyser?: AnalyserNode;
  private meter = new Float32Array(256);
  private renderer?: VideoRenderer;
  /** Decoded frames sorted by presentation time; every frame leaving the queue must be closed. */
  private frames: VideoFrame[] = [];
  private lastClockSync = 0;
  private clock?: Clock;
  private generation = 0;
  private pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private id = 0;
  private queuedBytes = 0;
  private animation = 0;
  private ended = false;
  private recovering = false;
  private resyncs = 0;
  private discardedBytes = 0;
  closed = false;
  onCaption?: (packet: CaptionPacket) => void;
  onCaptionReset?: () => void;
  onFirstFrame?: () => void;
  stats?: PlaybackStats;
  error?: string;
  rendered = 0;
  dropped = 0;
  avOffsetMs = 0;
  private fileStarted = 0;
  private fileElapsedMs = 0;
  get audioQueuedSeconds(): number {
    return (this.clock?.queued ?? 0) / 48000;
  }
  /** Current media time in seconds for caption scheduling, or undefined without an audio clock. */
  get clockSeconds(): number | undefined {
    const clock = this.clock;
    if (clock?.pts === undefined || !this.context) return undefined;
    const latency = this.context.outputLatency || this.context.baseLatency || 0;
    const elapsed = clock.running
      ? Math.max(-0.1, Math.min(0.05, this.context.currentTime - clock.contextTime)) - latency
      : 0;
    return (clock.pts + elapsed * 90000) / 90000;
  }
  get bufferedSeconds(): number {
    const clock = this.clock?.pts;
    const last = this.frames.at(-1);
    return Math.max(
      this.audioQueuedSeconds,
      clock !== undefined && last
        ? (microsecondsToPts(last.timestamp) - clock) / 90000
        : this.frames.length / 30,
    );
  }
  get snapshot() {
    this.analyser?.getFloatTimeDomainData(this.meter);
    const audioLevel = Math.sqrt(
      this.meter.reduce((sum, value) => sum + value * value, 0) / this.meter.length,
    );
    return {
      ...this.stats,
      rendered: this.rendered,
      dropped: this.dropped,
      avOffsetMs: this.avOffsetMs,
      audioLevel,
      fileElapsedMs: this.fileElapsedMs,
      wallSpeed: this.fileElapsedMs
        ? ((this.stats?.mediaSeconds ?? 0) * 1000) / this.fileElapsedMs
        : 0,
      finished:
        this.ended &&
        (this.benchmark ||
          (!!this.clock && !this.clock.queued && !this.clock.running && !this.frames.length)),
      audioQueuedSeconds: this.audioQueuedSeconds,
      videoQueued: this.frames.length,
      inputQueuedBytes: this.queuedBytes,
      underruns: this.clock?.underruns ?? 0,
      resyncs: this.resyncs,
      discardedBytes: this.discardedBytes,
      error: this.error,
      closed: this.closed,
    };
  }
  constructor(
    private canvas: HTMLCanvasElement,
    private benchmark = false,
  ) {
    this.worker.onmessage = (event) => {
      const data = event.data;
      if (this.closed) {
        data.frame?.close();
        return;
      }
      if (data.type === 'reset') {
        this.clearFrames();
        this.clock = undefined;
        this.generation = data.generation;
        this.onCaptionReset?.();
      } else if (data.type === 'caption') {
        this.onCaption?.({
          kind: data.kind,
          bytes: new Uint8Array(data.bytes),
          pts: data.pts,
          dts: data.dts,
        });
      } else if (data.type === 'video') {
        this.worker.postMessage({ type: 'release' });
        this.enqueue(data.frame);
      } else if (data.type === 'overload') {
        this.recover();
      } else {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        clearTimeout(pending.timer);
        if (data.error) {
          pending.reject(new Error(data.error));
          this.fail(data.error);
        } else {
          this.stats = data.stats;
          pending.resolve();
        }
      }
    };
    this.worker.onerror = (event) => this.fail(event.message || 'Playback Worker failed');
  }
  private enqueue(frame: VideoFrame): void {
    let index = this.frames.length;
    while (index && this.frames[index - 1].timestamp > frame.timestamp) index--;
    this.frames.splice(index, 0, frame);
    while (this.frames.length > MAX_QUEUED_FRAMES) {
      this.frames.shift()!.close();
      this.dropped++;
    }
  }
  private clearFrames(): void {
    for (const frame of this.frames) frame.close();
    this.frames = [];
  }
  /**
   * The browser converts YUV→RGB from the frame's colorSpace. The backing store matches the
   * on-screen device pixels so the one resample is the renderer's Lanczos filter, not the
   * compositor's bilinear CSS scaling (which aliases when shrinking 1080 lines).
   */
  private present(frame: VideoFrame): void {
    const canvas = this.canvas;
    const aspect = frame.displayWidth / frame.displayHeight;
    // The canvas may live in the PiP window or be detached (preview popup before adoption).
    const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const boxWidth = canvas.clientWidth * ratio;
    const boxHeight = canvas.clientHeight * ratio;
    let width = frame.displayWidth;
    let height = frame.displayHeight;
    if (boxWidth && boxHeight) {
      width = Math.round(Math.min(boxWidth, boxHeight * aspect));
      height = Math.round(width / aspect);
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.renderer!.draw(frame, width, height);
  }
  get volume(): number {
    return this.volumeLevel;
  }
  setVolume(volume: number): void {
    const next = Math.min(1, Math.max(0, volume));
    this.volumeLevel = next;
    // ponytail: x^2 pseudo-log A-taper, use dB/exponential map if metering mismatches
    if (this.gain) this.gain.gain.value = next * next;
  }
  async open(serviceId: number): Promise<void> {
    if (!Number.isInteger(serviceId) || serviceId < 1 || serviceId > 65535)
      throw new Error('Service ID must be an integer from 1 to 65535');
    try {
      if (!this.benchmark) {
        this.renderer = createVideoRenderer(this.canvas);
        // Called directly from the click handler before awaiting module loading.
        const context = (this.context = new AudioContext({
          sampleRate: 48000,
          latencyHint: 'interactive',
        }));
        const resumed = context.resume();
        await context.audioWorklet.addModule(workletUrl);
        if (this.closed) return;
        this.audio = new AudioWorkletNode(context, 'broadcast-audio', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        this.audio.onprocessorerror = () => this.fail('AudioWorklet processor failed');
        this.audio.port.onmessage = (event) => {
          if (this.closed) return;
          if (event.data.error) {
            if (String(event.data.error).includes('overflow')) this.recover();
            else this.fail(event.data.error);
          } else if (event.data.generation === this.generation) this.clock = event.data;
        };
        this.analyser = context.createAnalyser();
        this.analyser.fftSize = this.meter.length;
        this.gain = context.createGain();
        this.setVolume(this.volumeLevel);
        this.audio.connect(this.gain);
        this.gain.connect(this.analyser);
        this.analyser.connect(context.destination);
        await resumed;
        if (context.state !== 'running')
          throw new Error('Could not start audio. Play from a user gesture');
        this.animation = requestAnimationFrame(this.tick);
      }
      if (this.closed) return;
      // PCM flows Worker → AudioWorklet directly; the main thread only presents video.
      let audioPort: MessagePort | undefined;
      if (this.audio) {
        const channel = new MessageChannel();
        this.audio.port.postMessage({ type: 'decoder', port: channel.port1 }, [channel.port1]);
        audioPort = channel.port2;
      }
      await this.request(
        'open',
        { serviceId, benchmark: this.benchmark, audioPort },
        audioPort ? [audioPort] : [],
      );
    } catch (error) {
      this.fail(String(error));
      throw error;
    }
  }
  private tick = () => {
    if (this.closed) return;
    const clock = this.clock;
    if (clock?.pts !== undefined && this.context) {
      const latency = this.context.outputLatency || this.context.baseLatency || 0;
      const elapsed = clock.running
        ? Math.max(-0.1, Math.min(0.05, this.context.currentTime - clock.contextTime)) - latency
        : 0;
      const pts = clock.pts + elapsed * 90000;
      const now = performance.now();
      if (now - this.lastClockSync >= 100) {
        this.lastClockSync = now;
        this.worker.postMessage({ type: 'playback-pts', pts, generation: this.generation });
      }
      let frame: VideoFrame | undefined;
      while (this.frames.length && microsecondsToPts(this.frames[0].timestamp) <= pts + 1800) {
        if (frame) {
          frame.close();
          this.dropped++;
        }
        frame = this.frames.shift();
      }
      if (frame) {
        this.avOffsetMs = (microsecondsToPts(frame.timestamp) - pts) / 90;
        try {
          if (this.avOffsetMs < -150) this.dropped++;
          else {
            this.present(frame);
            this.rendered++;
            this.onFirstFrame?.();
            this.onFirstFrame = undefined;
          }
        } catch (error) {
          this.fail(String(error));
          return;
        } finally {
          frame.close();
        }
      }
      if (this.ended && !clock.queued && !clock.running) this.clearFrames();
    }
    this.animation = requestAnimationFrame(this.tick);
  };
  private request(
    type: string,
    options: Record<string, unknown> = {},
    transfer: Transferable[] = [],
  ): Promise<void> {
    if (this.closed) return Promise.reject(new Error(this.error ?? 'Playback stopped'));
    if (this.pending.size >= 64) {
      this.fail('Playback request queue overflow');
      return Promise.reject(new Error(this.error));
    }
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('Playback Worker response timeout'), 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...options }, transfer);
    });
  }
  async push(bytes: ArrayBuffer): Promise<void> {
    const size = bytes.byteLength;
    if (this.recovering || this.queuedBytes + size > 4 * 1024 * 1024 || this.pending.size >= 60) {
      this.discardedBytes += size;
      this.recover();
      return;
    }
    this.queuedBytes += size;
    try {
      await this.request('chunk', { bytes }, [bytes]);
    } finally {
      this.queuedBytes -= size;
    }
  }
  private recover(): void {
    if (this.recovering || this.closed) return;
    this.recovering = true;
    this.resyncs++;
    void (async () => {
      // Finish bounded in-flight work, then discard PES/PSI/codec and audio timelines together.
      while (!this.closed && this.queuedBytes)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (!this.closed) await this.request('resync');
    })()
      .catch((error) => this.fail(String(error)))
      .finally(() => {
        this.recovering = false;
      });
  }
  async playFile(file: Blob): Promise<void> {
    this.fileStarted = performance.now();
    // Small sequential reads bound decoded output bursts even on low bitrate TS.
    for (let offset = 0; offset < file.size; offset += 188 * 32) {
      const start = performance.now();
      while (!this.closed && (this.recovering || (!this.benchmark && this.bufferedSeconds > 0.4))) {
        if (performance.now() - start > 5000) {
          this.fail('Playback stalled: audio missing or audio context suspended');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      if (this.closed) throw new Error(this.error ?? 'Playback stopped');
      await this.push(await file.slice(offset, offset + 188 * 32).arrayBuffer());
    }
    await this.request('flush');
    this.fileElapsedMs = performance.now() - this.fileStarted;
    this.ended = true;
  }
  private fail(message: string): void {
    this.error ??= message;
    this.close();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    cancelAnimationFrame(this.animation);
    this.clearFrames();
    this.renderer?.dispose();
    this.audio?.disconnect();
    this.audio?.port.close();
    this.gain?.disconnect();
    this.analyser?.disconnect();
    this.meter.fill(0);
    void this.context?.close().catch(() => {});
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(this.error ?? 'Playback stopped'));
    }
    this.pending.clear();
  }
}
