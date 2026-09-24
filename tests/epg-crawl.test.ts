import { expect, it, vi } from 'vitest';
import { crawlEpg, type EpgCrawlSession } from '../src/epg-crawl';
import type { ProgramInfo } from '../src/transport/program-info';

const program = (events: number): ProgramInfo => ({
  serviceId: 1,
  stationName: 'A',
  current: null,
  next: null,
  future: Array.from({ length: events }, (_, id) => ({
    id,
    title: `P${id}`,
    description: '',
    start: id * 1000,
    end: id * 1000 + 1000,
  })) as ProgramInfo['future'],
});

function fakeSession(lockable: (channel: string) => boolean) {
  const tuned: string[] = [];
  let polls = 0;
  const session: EpgCrawlSession & { receiving: boolean } = {
    receiving: true,
    epgTransport: undefined,
    epgTune: vi.fn(async (channel) => {
      tuned.push(String(channel));
      polls = 0;
      session.epgTransport = undefined;
      return lockable(String(channel));
    }),
    refreshEpgTransport: vi.fn(async () => {
      // EIT keeps growing for three polls, then settles.
      polls++;
      session.epgTransport = { programs: { 1: program(Math.min(polls, 3)) } };
    }),
    stopEpgTuner: vi.fn(async () => {}),
  };
  return { session, tuned };
}

it('visits receivable channels except the main one and saves settled EPG', async () => {
  vi.useFakeTimers();
  const { session, tuned } = fakeSession((channel) => channel !== '20');
  const controller = new AbortController();
  const saved: [string, number][] = [];
  const done = crawlEpg(session, {
    signal: controller.signal,
    channels: () => [13, 20, 27, 'BS1_0'],
    skip: (channel) => channel === 27,
    minDwellMs: 2000,
    quietMs: 2000,
    pollMs: 500,
    onPrograms: (channel, programs) => {
      saved.push([String(channel), programs[1]!.future.length]);
    },
    onRound: () => controller.abort(),
  });
  await vi.runAllTimersAsync();
  await done;
  vi.useRealTimers();
  expect(tuned).toEqual(['13', '20', 'BS1_0']);
  expect(saved).toEqual([
    ['13', 3],
    ['BS1_0', 3],
  ]);
  expect(session.stopEpgTuner).toHaveBeenCalled();
});

it('waits while the main tuner is not streaming', async () => {
  vi.useFakeTimers();
  const { session, tuned } = fakeSession(() => true);
  session.receiving = false;
  const controller = new AbortController();
  const done = crawlEpg(session, {
    signal: controller.signal,
    channels: () => [13],
    idleMs: 1000,
    onPrograms: () => {},
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(tuned).toEqual([]);
  controller.abort();
  await vi.runAllTimersAsync();
  await done;
  vi.useRealTimers();
  expect(session.stopEpgTuner).toHaveBeenCalled();
});

it('keeps crawling after a tuner error', async () => {
  vi.useFakeTimers();
  const { session, tuned } = fakeSession(() => true);
  vi.mocked(session.epgTune).mockRejectedValueOnce(new Error('I2C failed'));
  const controller = new AbortController();
  const errors: string[] = [];
  const done = crawlEpg(session, {
    signal: controller.signal,
    channels: () => [13, 14],
    minDwellMs: 1000,
    quietMs: 1000,
    pollMs: 500,
    onPrograms: () => {},
    onError: (channel) => errors.push(String(channel)),
    onRound: () => controller.abort(),
  });
  await vi.runAllTimersAsync();
  await done;
  vi.useRealTimers();
  expect(errors).toEqual(['13']);
  expect(tuned).toEqual(['14']);
});

it('dwells past the quiet period while hold() asks for more, up to maxDwellMs', async () => {
  vi.useFakeTimers();
  const { session } = fakeSession(() => true);
  const controller = new AbortController();
  const dwell: number[] = [];
  let start = 0;
  const done = crawlEpg(session, {
    signal: controller.signal,
    channels: () => [13, 14],
    minDwellMs: 1000,
    quietMs: 1000,
    maxDwellMs: 10000,
    pollMs: 500,
    hold: (channel) => channel === 13,
    onChannel: (channel) => {
      if (channel != null) start = Date.now();
    },
    onPrograms: () => {
      dwell.push(Date.now() - start);
    },
    onRound: () => controller.abort(),
  });
  await vi.runAllTimersAsync();
  await done;
  vi.useRealTimers();
  expect(dwell[0]).toBeGreaterThanOrEqual(10000);
  expect(dwell[1]).toBeLessThan(5000);
});
