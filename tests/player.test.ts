import { afterEach, expect, it, vi } from 'vitest';
import { FullSegPlayer } from '../src/media/player';

class MockWorker {
  static current: MockWorker;
  onmessage?: (event: { data: unknown }) => void;
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

it('bounds in-flight input and reacquires PSI/codec timelines after overload', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', MockWorker);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const player = new FullSegPlayer({} as HTMLCanvasElement, true);
  const worker = MockWorker.current;
  const queued = player.push(new ArrayBuffer(4 * 1024 * 1024));
  await player.push(new ArrayBuffer(188));
  expect(player.snapshot.discardedBytes).toBe(188);
  expect(player.snapshot.resyncs).toBe(1);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  worker.reply({ id: 1, stats: {} });
  await queued;
  await vi.advanceTimersByTimeAsync(10);
  expect(worker.postMessage.mock.calls[1][0]).toMatchObject({ type: 'resync' });
  worker.reply({ id: 2, stats: {} });
  await vi.advanceTimersByTimeAsync(1);
  const next = player.push(new ArrayBuffer(188));
  expect(worker.postMessage.mock.calls[2][0]).toMatchObject({ type: 'chunk' });
  worker.reply({ id: 3, stats: {} });
  await next;
  expect(player.closed).toBe(false);
  player.close();
});

it('terminates stalled decoding and rejects pending operations on stop', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', MockWorker);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const player = new FullSegPlayer({} as HTMLCanvasElement, true);
  const assertion = expect(player.push(new ArrayBuffer(188))).rejects.toThrow('timeout');
  await vi.advanceTimersByTimeAsync(15000);
  await assertion;
  expect(MockWorker.current.terminate).toHaveBeenCalledOnce();
  expect(player.closed).toBe(true);
  // A late frame from a destroyed generation cannot repopulate the queue.
  MockWorker.current.reply({ type: 'video', picture: { pts: 0 } });
  expect(player.snapshot.videoQueued).toBe(0);
});
