/** Bounded stereo PCM queue, clocked only by samples actually rendered. */
export class PcmQueue {
  private readonly data = new Float32Array(48000 * 2 * 2);
  private read = 0;
  private count = 0;
  private startPts?: number;
  private primed = false;
  underruns = 0;
  get frames(): number {
    return this.count;
  }
  get pts(): number | undefined {
    return this.startPts;
  }
  clear(): void {
    this.read = this.count = 0;
    this.startPts = undefined;
    this.primed = false;
  }
  push(samples: Float32Array, pts: number): void {
    if (samples.length % 2 || !Number.isFinite(pts)) throw new Error('Invalid PCM');
    const expected =
      this.startPts === undefined ? pts : this.startPts + (this.count * 90000) / 48000;
    let gap = Math.round(((pts - expected) * 48000) / 90000);
    // Large jumps must rebuild the timeline, never play old audio across them.
    if (Math.abs(gap) > 12000 || (!this.count && Math.abs(gap) > 96)) {
      this.clear();
      gap = 0;
    }
    this.startPts ??= pts;
    const silence = this.count && gap > 96 && gap <= 12000 ? gap : 0;
    const skip = gap < -96 && gap >= -12000 ? Math.min(-gap, samples.length / 2) : 0;
    const frames = samples.length / 2 - skip;
    if (this.count + silence + frames > this.data.length / 2)
      throw new Error('Audio queue overflow (2 seconds)');
    for (let i = 0; i < silence + frames; i++) {
      const index = ((this.read + this.count + i) % (this.data.length / 2)) * 2;
      this.data[index] = i < silence ? 0 : samples[(i - silence + skip) * 2];
      this.data[index + 1] = i < silence ? 0 : samples[(i - silence + skip) * 2 + 1];
    }
    this.count += silence + frames;
  }
  render(left: Float32Array, right: Float32Array, drain = false): boolean {
    left.fill(0);
    right.fill(0);
    if (!this.primed && this.count >= (drain ? 1 : 7200)) this.primed = true;
    if (!this.primed) return false;
    const frames = Math.min(left.length, this.count);
    for (let i = 0; i < frames; i++) {
      const index = ((this.read + i) % (this.data.length / 2)) * 2;
      left[i] = this.data[index];
      right[i] = this.data[index + 1];
    }
    this.read = (this.read + frames) % (this.data.length / 2);
    this.count -= frames;
    this.startPts! += (frames * 90000) / 48000;
    if (frames < left.length) {
      this.underruns++;
      this.primed = false;
    }
    return frames === left.length;
  }
}
