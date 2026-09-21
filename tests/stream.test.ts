import { afterEach, describe, expect, it, vi } from 'vitest';
import { STREAM_TRANSFER_BYTES, UsbTsStream } from '../src/usb/stream';

const result = (byte: number): USBInTransferResult => ({
  status: 'ok',
  data: new DataView(new Uint8Array([0, byte, 0]).buffer, 1, 1),
});
afterEach(() => vi.useRealTimers());
describe('ordered bounded TS Bulk IN', () => {
  it('consumes submission order despite out-of-order completion and ignores late results after stop', async () => {
    const resolves: ((r: USBInTransferResult) => void)[] = [];
    const transferIn = vi.fn(
      () => new Promise<USBInTransferResult>((resolve) => resolves.push(resolve)),
    );
    const stream = new UsbTsStream({ transferIn });
    const seen: number[] = [];
    const run = stream.run(async (bytes) => {
      seen.push(new Uint8Array(bytes)[0]);
      if (seen.length === 2) stream.stop();
    });
    expect(transferIn).toHaveBeenCalledTimes(4);
    expect(transferIn).toHaveBeenCalledWith(4, STREAM_TRANSFER_BYTES);
    resolves[1](result(2));
    await Promise.resolve();
    expect(seen).toEqual([]);
    resolves[0](result(1));
    await run;
    expect(seen).toEqual([1, 2]);
    for (const resolve of resolves) resolve(result(9));
    await Promise.resolve();
    expect(seen).toEqual([1, 2]);
    expect(stream.stats.bytes).toBe(2);
    await expect(stream.run(async () => {})).rejects.toThrow('new session');
  });
  it('reports transfer failures and does not deliver later packets', async () => {
    const transferIn = vi.fn().mockResolvedValue({ status: 'stall' });
    const stream = new UsbTsStream({ transferIn });
    const consume = vi.fn();
    await expect(stream.run(consume)).rejects.toThrow('stall');
    expect(consume).not.toHaveBeenCalled();
    expect(stream.stats.errors).toBe(1);
  });
  it('times out unresolved I/O without mistaking Promise.race for cancellation', async () => {
    vi.useFakeTimers();
    const resolves: ((r: USBInTransferResult) => void)[] = [];
    const stream = new UsbTsStream(
      { transferIn: () => new Promise((resolve) => resolves.push(resolve)) },
      100,
    );
    const consume = vi.fn();
    const run = stream.run(consume);
    const assertion = expect(run).rejects.toThrow('reconnect required');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    for (const resolve of resolves) resolve(result(1));
    await Promise.resolve();
    expect(consume).not.toHaveBeenCalled();
  });
});
