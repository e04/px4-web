export class TsCapture {
  private chunks: Uint8Array<ArrayBuffer>[] = [];
  bytes = 0;
  active = false;
  reason = 'Not saved';
  private deadline = 0;
  constructor(
    readonly maxBytes = Math.floor((64 * 1024 * 1024) / 188) * 188,
    readonly durationMs = 10000,
  ) {}
  start(now: number): void {
    this.chunks = [];
    this.bytes = 0;
    this.deadline = now + this.durationMs;
    this.active = true;
    this.reason = 'Saving';
  }
  tick(now: number): void {
    if (this.active && now >= this.deadline) this.stop('Time limit');
  }
  push(bytes: Uint8Array, now: number): void {
    this.tick(now);
    if (!this.active) return;
    const length = Math.min(bytes.length, this.maxBytes - this.bytes);
    if (length) {
      this.chunks.push(new Uint8Array(bytes.subarray(0, length)));
      this.bytes += length;
    }
    if (this.bytes >= this.maxBytes) this.stop('Size limit');
  }
  stop(reason = 'Stopped'): void {
    if (this.active) this.reason = reason;
    this.active = false;
  }
  blob(): Blob {
    return new Blob(this.chunks, { type: 'video/mp2t' });
  }
}
