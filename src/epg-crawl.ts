import type { Channel } from './channels';
import type { ProgramInfo } from './transport/program-info';

// Structural subset of ReceiverSession so tests can pass a fake.
export interface EpgCrawlSession {
  readonly receiving?: boolean;
  epgTune(channel: Channel): Promise<boolean>;
  refreshEpgTransport(): Promise<void>;
  stopEpgTuner(): Promise<void>;
  epgTransport?: { programs?: Record<number, ProgramInfo> };
}

export interface EpgCrawlOptions {
  signal: AbortSignal;
  /** Re-read every round so new scan results are picked up. */
  channels: () => Channel[];
  /** Checked right before tuning, e.g. the channel the main tuner is on. */
  skip?: (channel: Channel) => boolean;
  /** Minimum dwell per channel. */
  minDwellMs?: number;
  /** Leave once no new events arrived for this long (after minDwellMs). */
  quietMs?: number;
  maxDwellMs?: number;
  pollMs?: number;
  /** Pause between complete rounds. */
  roundIntervalMs?: number;
  /** Retry interval while the main tuner is not delivering the USB stream. */
  idleMs?: number;
  onChannel?: (channel: Channel | null) => void;
  onPrograms: (channel: Channel, programs: Record<number, ProgramInfo>) => Promise<void> | void;
  onError?: (channel: Channel, error: unknown) => void;
  onRound?: (channels: number) => void;
}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });

const eventCount = (programs: Record<number, ProgramInfo> | undefined) =>
  Object.values(programs ?? {}).reduce(
    (sum, program) =>
      sum + program.future.length + (program.current ? 1 : 0) + (program.next ? 1 : 0),
    0,
  );

/**
 * Cycle the free tuner over every receivable channel, collecting EIT until the
 * event count settles, until aborted. The auxiliary tuner is always put back
 * to sleep on exit.
 */
export async function crawlEpg(session: EpgCrawlSession, options: EpgCrawlOptions): Promise<void> {
  const {
    signal,
    minDwellMs = 15000,
    quietMs = 10000,
    maxDwellMs = 60000,
    pollMs = 1000,
    roundIntervalMs = 30 * 60000,
    idleMs = 2000,
  } = options;
  try {
    while (!signal.aborted) {
      const channels = options.channels();
      let visited = 0;
      for (let index = 0; index < channels.length && !signal.aborted;) {
        const channel = channels[index]!;
        if (options.skip?.(channel)) {
          index++;
          continue;
        }
        if (!session.receiving) {
          await wait(idleMs, signal);
          continue;
        }
        index++;
        options.onChannel?.(channel);
        try {
          if (!(await session.epgTune(channel)) || signal.aborted) continue;
          const start = Date.now();
          let lastChange = start;
          let count = -1;
          while (!signal.aborted) {
            await wait(pollMs, signal);
            await session.refreshEpgTransport();
            const now = Date.now();
            const next = eventCount(session.epgTransport?.programs);
            if (next !== count) {
              count = next;
              lastChange = now;
            }
            if (now - start >= maxDwellMs) break;
            if (now - start >= minDwellMs && now - lastChange >= quietMs) break;
          }
          const programs = session.epgTransport?.programs;
          if (!signal.aborted && programs && count > 0) {
            await options.onPrograms(channel, programs);
            visited++;
          }
        } catch (error) {
          if (!signal.aborted) options.onError?.(channel, error);
        }
      }
      options.onChannel?.(null);
      if (signal.aborted) break;
      await session.stopEpgTuner().catch(() => {});
      options.onRound?.(visited);
      await wait(channels.length ? roundIntervalMs : idleMs, signal);
    }
  } finally {
    options.onChannel?.(null);
    await session.stopEpgTuner().catch(() => {});
  }
}
