import type { Channel } from './channels';
import type { LogoData } from './logo';
import type { ProgramInfo } from './transport/program-info';

// Structural subset of ReceiverSession so tests can pass a fake.
export interface EpgCrawlSession {
  readonly receiving?: boolean;
  epgTune(channel: Channel): Promise<boolean>;
  refreshEpgTransport(): Promise<void>;
  stopEpgTuner(): Promise<void>;
  epgTransport?: { programs?: Record<number, ProgramInfo>; logos?: LogoData[] };
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
  /**
   * Keep dwelling past the quiet period (up to holdMaxDwellMs) while this
   * returns true, e.g. while a service's logo has not arrived in CDT yet.
   */
  hold?: (channel: Channel, transport: EpgCrawlSession['epgTransport']) => boolean;
  /** Dwell cap while hold() is true; defaults to maxDwellMs. */
  holdMaxDwellMs?: number;
  /**
   * Channels for which this returns true are visited first in every round and
   * revisited every priorityIntervalMs between rounds, e.g. while a logo is missing.
   */
  priority?: (channel: Channel) => boolean;
  priorityIntervalMs?: number;
  pollMs?: number;
  /** Pause between complete rounds. */
  roundIntervalMs?: number;
  /** Retry interval while the main tuner is not delivering the USB stream. */
  idleMs?: number;
  onChannel?: (channel: Channel | null) => void;
  onPrograms: (
    channel: Channel,
    programs: Record<number, ProgramInfo>,
    logos: LogoData[],
  ) => Promise<void> | void;
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
    holdMaxDwellMs = maxDwellMs,
    pollMs = 1000,
    roundIntervalMs = 30 * 60000,
    priorityIntervalMs = 5 * 60000,
    idleMs = 2000,
  } = options;
  const prioritized = (channel: Channel) => options.priority?.(channel) ?? false;
  let nextRound = 0;
  try {
    while (!signal.aborted) {
      const all = options.channels();
      const fullRound = Date.now() >= nextRound;
      const urgent = all.filter(prioritized);
      // Between full rounds only the prioritized channels are revisited.
      const channels = fullRound
        ? [...urgent, ...all.filter((channel) => !urgent.includes(channel))]
        : urgent;
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
            const elapsed = now - start;
            if (elapsed >= holdMaxDwellMs) break;
            if (elapsed < minDwellMs) continue;
            const held = options.hold?.(channel, session.epgTransport) ?? false;
            if (!held && (elapsed >= maxDwellMs || now - lastChange >= quietMs)) break;
          }
          const programs = session.epgTransport?.programs;
          if (!signal.aborted && programs && count > 0) {
            await options.onPrograms(channel, programs, session.epgTransport?.logos ?? []);
            visited++;
          }
        } catch (error) {
          if (!signal.aborted) options.onError?.(channel, error);
        }
      }
      options.onChannel?.(null);
      if (signal.aborted) break;
      await session.stopEpgTuner().catch(() => {});
      if (fullRound) {
        options.onRound?.(visited);
        nextRound = Date.now() + roundIntervalMs;
      }
      const untilRound = Math.max(0, nextRound - Date.now());
      await wait(
        !all.length
          ? idleMs
          : all.some(prioritized)
            ? Math.min(priorityIntervalMs, untilRound)
            : untilRound,
        signal,
      );
    }
  } finally {
    options.onChannel?.(null);
    await session.stopEpgTuner().catch(() => {});
  }
}
