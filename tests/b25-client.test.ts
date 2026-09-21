import { afterEach, expect, it, vi } from 'vitest';
import { B25Worker } from '../src/media/b25-client';

class MockWorker {
  static current: MockWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    MockWorker.current = this;
  }
  reply(data: unknown) {
    this.onmessage?.({ data });
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('bounds queued TS even while the decoder waits for an APDU', async () => {
  vi.stubGlobal('Worker', MockWorker);
  const client = new B25Worker(async () => new Uint8Array());
  const waiting = client.push(new ArrayBuffer(8 * 1024 * 1024));
  const assertion = expect(waiting).rejects.toThrow('overflow');
  await expect(client.push(new ArrayBuffer(188))).rejects.toThrow('overflow');
  await assertion;
  expect(MockWorker.current.terminate).toHaveBeenCalledTimes(1);
});
it('discards late card responses and rejects queued operations when closed', async () => {
  vi.stubGlobal('Worker', MockWorker);
  let finish!: (bytes: Uint8Array) => void;
  const client = new B25Worker(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const opening = client.request('open', { serviceId: 1 });
  const assertion = expect(opening).rejects.toThrow('closed');
  MockWorker.current.reply({ type: 'apdu', id: 1, bytes: new ArrayBuffer(5) });
  client.close();
  finish(new Uint8Array([0x90, 0]));
  await assertion;
  await Promise.resolve();
  expect(MockWorker.current.postMessage).toHaveBeenCalledTimes(1);
});
it('terminates an unresponsive Worker rather than permitting stale queued responses', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', MockWorker);
  const client = new B25Worker(async () => new Uint8Array());
  const assertion = expect(client.request('snapshot')).rejects.toThrow('deadline');
  await vi.advanceTimersByTimeAsync(15000);
  await assertion;
  expect(MockWorker.current.terminate).toHaveBeenCalledOnce();
  await expect(client.request('snapshot')).rejects.toThrow('deadline');
});
