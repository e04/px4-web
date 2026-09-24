import { TsAnalyzer } from './analyzer';
import { TsCapture } from './capture';
import { TaggedTs } from './tagged-ts';

export class TsPipeline {
  readonly analyzer = new TsAnalyzer();
  readonly capture = new TsCapture();
  private output = new Uint8Array(0);
  private length = 0;
  readonly tagged: TaggedTs;
  constructor(
    readonly receiverIndex = 2,
    plain = false,
  ) {
    this.tagged = new TaggedTs(
      (receiver, packet) => {
        if (receiver !== this.receiverIndex) return;
        this.analyzer.push(packet);
        this.output.set(packet, this.length);
        this.length += 188;
      },
      () => this.analyzer.resetContinuity(),
      plain,
    );
  }
  push(bytes: Uint8Array, now: number): Uint8Array<ArrayBuffer> {
    this.output = new Uint8Array(bytes.length + 188 * 4);
    this.length = 0;
    this.tagged.push(bytes);
    const output = this.output.slice(0, this.length);
    this.capture.push(output, now);
    this.output = new Uint8Array(0);
    return output;
  }
  snapshot(now: number) {
    this.capture.tick(now);
    return {
      ...this.tagged.stats,
      bufferedBytes: this.tagged.bufferedBytes,
      ...this.analyzer.snapshot(),
      capture: {
        bytes: this.capture.bytes,
        active: this.capture.active,
        reason: this.capture.reason,
        maxBytes: this.capture.maxBytes,
        durationMs: this.capture.durationMs,
      },
    };
  }
}
export type TransportSnapshot = ReturnType<TsPipeline['snapshot']>;
