import { loadValue, saveValue, scanStore } from './storage';
import type { ProgramEvent } from './transport/program-info';
import { channelsFor, TERRESTRIAL_CHANNELS, type Broadcast, type Channel } from './channels';
import { SATELLITE_DEFAULTS } from './satellite-defaults';

export interface ScannedService {
  serviceId: number;
  stationName: string;
}

export interface ScanEntry {
  locked: boolean;
  services: ScannedService[];
  scannedAt: number;
}

export type ScanMap = Record<string, ScanEntry>;

export const SCAN_STORAGE_KEY = 'px4-scan-v1';
// UHF physical channels for terrestrial broadcasts in Japan.
export const SCAN_CHANNELS = TERRESTRIAL_CHANNELS;

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Scan cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error('Scan cancelled'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });

function isScanEntry(value: unknown): value is ScanEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.locked === 'boolean' &&
    Array.isArray(entry.services) &&
    entry.services.every(
      (service) =>
        typeof service === 'object' &&
        service !== null &&
        typeof (service as Record<string, unknown>).serviceId === 'number' &&
        typeof (service as Record<string, unknown>).stationName === 'string',
    ) &&
    typeof entry.scannedAt === 'number'
  );
}

// scannedAt 0 marks a built-in entry; real scans always stamp Date.now().
const DEFAULT_SCANNED_AT = 0;

/**
 * Built-in BS/CS lineup: listed slots are receivable, every other satellite
 * slot is hidden. Saved (scanned) entries override these per channel.
 */
export const DEFAULT_SCAN: ScanMap = (() => {
  const known = new Map(SATELLITE_DEFAULTS.map(([channel, ...rest]) => [String(channel), rest]));
  const map: ScanMap = {};
  for (const channel of [...channelsFor('BS'), ...channelsFor('CS')]) {
    const service = known.get(String(channel));
    map[String(channel)] = {
      locked: !!service,
      services: service ? [{ serviceId: service[0], stationName: service[1] }] : [],
      scannedAt: DEFAULT_SCANNED_AT,
    };
  }
  return map;
})();

async function loadSavedScan(): Promise<ScanMap> {
  try {
    const parsed: unknown = await loadValue(SCAN_STORAGE_KEY, scanStore);
    if (!parsed) return {};
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: ScanMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>))
      if (isScanEntry(value)) result[key] = value;
    return result;
  } catch {
    return {};
  }
}

/** Saved scan results layered over the built-in satellite lineup. */
export async function loadScan(): Promise<ScanMap> {
  return { ...DEFAULT_SCAN, ...(await loadSavedScan()) };
}

/** Persists scanned entries only, so built-in defaults stay updatable. */
export async function saveScan(map: ScanMap): Promise<void> {
  const scanned = Object.fromEntries(
    Object.entries(map).filter(([, entry]) => entry.scannedAt !== DEFAULT_SCANNED_AT),
  );
  await saveValue(SCAN_STORAGE_KEY, scanned, scanStore);
}

/** Known-unreceivable channels are hidden from the selector; unscanned stay visible. */
export function isChannelHidden(map: ScanMap, channel: string | number): boolean {
  const entry = map[String(channel)];
  return !!entry && !entry.locked;
}

export function visibleChannels(map: ScanMap, band: Broadcast = 'T'): Channel[] {
  return channelsFor(band).filter((channel) => !isChannelHidden(map, channel));
}

/** First named service; empty when unscanned, unlocked, or nameless. */
export function representativeName(entry: ScanEntry | undefined): string {
  if (!entry || !entry.locked) return '';
  return entry.services.find((service) => service.stationName)?.stationName ?? '';
}

export function channelLabel(channel: Channel, entry: ScanEntry | undefined): string {
  const name = representativeName(entry);
  return name ? `CH ${channel} · ${name}` : `CH ${channel}`;
}

// Structural subset of ReceiverSession so tests can pass a fake.
export interface ScanSession {
  receiver: {
    tune(channel: Channel, timeoutMs?: number): Promise<{ demodLocked: boolean }>;
  };
  startCapture(): Promise<void>;
  retune(channel: Channel): Promise<{ demodLocked: boolean }>;
  refreshTransport(): Promise<void>;
  readonly receiving?: boolean;
  transport?: {
    services?: { serviceId: number }[];
    programs?: Record<
      number,
      {
        stationName?: string;
        current?: ProgramEvent | null;
        next?: ProgramEvent | null;
        future?: ProgramEvent[];
      }
    >;
  };
}

export interface ScanOptions {
  channels?: Channel[];
  tuneTimeoutMs?: number;
  siSettleMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  isAborted?: () => boolean;
  onProgress?: (channel: Channel, entry: ScanEntry, done: number, total: number) => void;
  onPrograms?: (
    channel: Channel,
    programs: NonNullable<NonNullable<ScanSession['transport']>['programs']>,
  ) => Promise<void> | void;
}

const aborted = (options: ScanOptions) => {
  if (options.signal?.aborted || options.isAborted?.()) throw new Error('Scan cancelled');
};

/**
 * Tune every channel in order and collect SDT station names.
 * Lock failures are recorded as unlocked entries; only cancellation aborts.
 * The first channel tunes + starts capture, the rest reuse `retune`
 * (same-USB-session switch, also valid from `ready` after a lock failure).
 */
export async function scanChannels(
  session: ScanSession,
  options: ScanOptions = {},
): Promise<ScanMap> {
  const channels = options.channels ?? SCAN_CHANNELS;
  const tuneTimeoutMs = options.tuneTimeoutMs ?? 2000;
  const siSettleMs = options.siSettleMs ?? 10000;
  const pollMs = options.pollMs ?? 250;
  const result: ScanMap = {};
  let streaming = !!session.receiving;

  const record = (channel: Channel, entry: ScanEntry, done: number) => {
    result[String(channel)] = entry;
    options.onProgress?.(channel, entry, done, channels.length);
  };

  for (let index = 0; index < channels.length; index++) {
    const channel = channels[index]!;
    const done = index + 1;
    aborted(options);
    if (!streaming) {
      const tuned = await session.receiver.tune(channel, tuneTimeoutMs);
      aborted(options);
      if (!tuned.demodLocked) {
        record(channel, { locked: false, services: [], scannedAt: Date.now() }, done);
        continue;
      }
      await session.startCapture();
      aborted(options);
      streaming = true;
    } else {
      try {
        const tuned = await session.retune(channel);
        aborted(options);
        if (!tuned.demodLocked) {
          record(channel, { locked: false, services: [], scannedAt: Date.now() }, done);
          continue;
        }
      } catch (error) {
        aborted(options);
        if (error instanceof Error && /could not be locked/i.test(error.message)) {
          record(channel, { locked: false, services: [], scannedAt: Date.now() }, done);
          continue;
        }
        throw error;
      }
      aborted(options);
    }

    let services: ScannedService[] = [];
    const deadline = Date.now() + siSettleMs;
    for (;;) {
      aborted(options);
      await session.refreshTransport();
      aborted(options);
      const transport = session.transport;
      const current = (transport?.services ?? []).map((service) => ({
        serviceId: service.serviceId,
        stationName: transport?.programs?.[service.serviceId]?.stationName?.trim() ?? '',
      }));
      if (
        current.length > services.length ||
        (current.length > 0 && current.every((service) => service.stationName))
      )
        services = current;
      if (
        current.length > 0 &&
        current.every((service) => {
          const program = transport?.programs?.[service.serviceId];
          return service.stationName && program?.current && program?.next;
        })
      )
        break;
      if (Date.now() >= deadline) break;
      await delay(pollMs, options.signal);
    }
    if (session.transport?.programs)
      await options.onPrograms?.(channel, session.transport.programs);
    aborted(options);
    record(channel, { locked: true, services, scannedAt: Date.now() }, done);
  }
  return result;
}
