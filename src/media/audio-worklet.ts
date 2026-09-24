import { PcmQueue } from './pcm-queue';

declare const currentTime: number;
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/**
 * PCM arrives straight from the playback Worker on a transferred MessagePort;
 * `this.port` only reports the audio clock and errors to the main thread.
 */
class BroadcastAudio extends AudioWorkletProcessor {
  private queue = new PcmQueue();
  private ticks = 0;
  private drain = false;
  private generation = 0;
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data.type === 'decoder') event.data.port.onmessage = this.receive;
    };
  }
  private receive = (event: MessageEvent) => {
    const data = event.data;
    const port = event.target as MessagePort;
    try {
      if (data.type === 'reset') {
        this.queue.clear();
        this.drain = false;
        this.generation = data.generation;
      } else if (data.type === 'drain') this.drain = true;
      else if (data.type === 'pcm') this.queue.push(data.samples, data.pts);
    } catch (error) {
      this.queue.clear();
      this.port.postMessage({ error: String(error) });
    } finally {
      if (data.type === 'pcm') port.postMessage({ accepted: data.samples.length / 2 });
    }
  };
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (sampleRate !== 48000) return false;
    const running = this.queue.render(output[0], output[1], this.drain);
    if (++this.ticks % 8 === 0)
      this.port.postMessage({
        pts: this.queue.pts,
        contextTime: currentTime + output[0].length / sampleRate,
        queued: this.queue.frames,
        underruns: this.queue.underruns,
        running,
        generation: this.generation,
      });
    return true;
  }
}
registerProcessor('broadcast-audio', BroadcastAudio);
