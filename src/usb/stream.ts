import { withTimeout } from '../driver/bridge';

export const STREAM_TRANSFER_BYTES = 188 * 816;
export const STREAM_TRANSFERS = 4;

// WebUSB has no abortable transferIn. A new loop needs all physical reads to settle;
// if they cannot, the owner closes the device before reusing the endpoint.
export class UsbTsStream {
  readonly stats = {
    bytes: 0,
    transfers: 0,
    emptyTransfers: 0,
    maxGapMs: 0,
    startedAt: 0,
    elapsedMs: 0,
    errors: 0,
  };
  private active = false;
  private used = false;
  private lastData = 0;
  private endedAt = 0;
  private inFlight = new Set<Promise<USBInTransferResult>>();
  constructor(
    private readonly device: Pick<USBDevice, 'transferIn'>,
    private readonly timeoutMs = 5000,
  ) {}
  stop(): void {
    this.active = false;
    this.endedAt ||= performance.now();
  }
  get running(): boolean {
    return this.active;
  }
  async drain(): Promise<void> {
    this.stop();
    // ponytail: wait one transfer deadline, then reconnect; use abortable WebUSB reads if available.
    await withTimeout(
      Promise.allSettled(this.inFlight),
      this.timeoutMs,
      () => new Error('TS Bulk IN is still pending; reconnect required'),
    );
  }
  snapshot() {
    const now = this.endedAt || performance.now();
    const elapsedMs = this.stats.startedAt ? now - this.stats.startedAt : 0;
    return {
      ...this.stats,
      elapsedMs,
      maxGapMs: Math.max(this.stats.maxGapMs, this.lastData ? now - this.lastData : 0),
      mbps: elapsedMs ? (this.stats.bytes * 8) / elapsedMs / 1000 : 0,
      transferBytes: STREAM_TRANSFER_BYTES,
      inFlightLimit: STREAM_TRANSFERS,
    };
  }
  async read(length: number): Promise<Uint8Array<ArrayBuffer>> {
    const transfer = this.device.transferIn(4, length);
    this.inFlight.add(transfer);
    void transfer.then(
      () => this.inFlight.delete(transfer),
      () => this.inFlight.delete(transfer),
    );
    const result = await withTimeout(
      transfer,
      this.timeoutMs,
      () => new Error('TS Bulk IN timeout; reconnect required'),
    );
    if (result.status !== 'ok' || !result.data)
      throw new Error(`TS Bulk IN failed (${result.status})`);
    if (result.data.byteLength > length) throw new Error('TS Bulk IN exceeded requested length');
    const copy = new Uint8Array(result.data.byteLength);
    copy.set(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength));
    return copy;
  }
  async run(consume: (bytes: ArrayBuffer) => Promise<unknown>): Promise<void> {
    if (this.used) throw new Error('TS stream requires a new session');
    this.used = true;
    this.active = true;
    this.stats.startedAt = this.lastData = performance.now();
    // Rejections are converted immediately: a later transfer can fail before the
    // oldest transfer resolves, without producing an unhandled rejection.
    const submit = () =>
      this.read(STREAM_TRANSFER_BYTES).then(
        (bytes) => ({ bytes }),
        (error) => ({ error }),
      );
    const queue = Array.from({ length: STREAM_TRANSFERS }, submit);
    try {
      while (this.active) {
        const result = await queue.shift()!;
        if (!this.active) break;
        if ('error' in result) throw result.error;
        queue.push(submit());
        this.stats.transfers++;
        if (!result.bytes.length) {
          this.stats.emptyTransfers++;
          if (performance.now() - this.lastData > this.timeoutMs)
            throw new Error('TS empty reception timeout');
          await new Promise((resolve) => setTimeout(resolve, 1));
          continue;
        }
        const now = performance.now();
        this.stats.maxGapMs = Math.max(this.stats.maxGapMs, now - this.lastData);
        this.lastData = now;
        this.stats.bytes += result.bytes.length;
        await consume(result.bytes.buffer);
      }
    } catch (error) {
      if (this.active) {
        this.stats.errors++;
        throw error;
      }
    } finally {
      this.stop();
    }
  }
}
