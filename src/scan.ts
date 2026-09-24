import { loadValue, saveValue, scanStore } from './storage';
import type { ProgramEvent } from './transport/program-info';
import type { EpgMap } from './epg';
import {
  channelsFor,
  parseChannel,
  TERRESTRIAL_CHANNELS,
  type Broadcast,
  type Channel,
} from './channels';
import { SATELLITE_DEFAULTS } from './satellite-defaults';

export interface ScannedService {
  serviceId: number;
  stationName: string;
  /** SDT service_type; absent in scans saved before it was recorded. */
  serviceType?: number;
  /** NIT remote_control_key_id (terrestrial one-touch key). */
  remoteKey?: number;
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
        typeof (service as Record<string, unknown>).stationName === 'string' &&
        ['number', 'undefined'].includes(typeof (service as Record<string, unknown>).serviceType) &&
        ['number', 'undefined'].includes(typeof (service as Record<string, unknown>).remoteKey),
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

// ARIB service_type values a TV lists: digital TV, promotional video, UHD TV.
const TV_SERVICE_TYPES = new Set([0x01, 0xa5, 0xad]);

/** Whether a TV would list this service, rather than skip it like data or one-seg. */
export function isTvService(band: Broadcast, serviceId: number, serviceType?: number): boolean {
  // Terrestrial service_id bits 7-8: 0 TV, 1 data, 3 partial reception (one-seg).
  if (band === 'T' && ((serviceId >> 7) & 3) !== 0) return false;
  if (serviceType != null) return TV_SERVICE_TYPES.has(serviceType);
  // Untyped (older scans, built-in lineup): satellite radio and data start at 400.
  return band === 'T' || serviceId < 400;
}

/**
 * The service a TV opens for a TS: the lowest-numbered TV service, as the
 * remote's one-touch key does. Falls back to the first PAT entry.
 */
export function mainService(
  band: Broadcast,
  found: number[],
  entry: ScanEntry | undefined,
): number | undefined {
  const types = new Map(entry?.services.map((service) => [service.serviceId, service.serviceType]));
  return (
    found.filter((id) => isTvService(band, id, types.get(id))).sort((a, b) => a - b)[0] ?? found[0]
  );
}

/**
 * Services of one broadcaster, which a TV treats as a channel and its
 * multi-channel slots: terrestrial service_ids differing only in the service
 * number bits (Eテレ 021/022), BS service_ids in the same ten (BS朝日
 * 151–153). A 110°CS TS multiplexes unrelated channels, so each stands alone.
 */
function stationKey(band: Broadcast, serviceId: number): number {
  if (band === 'T') return serviceId >> 3;
  return band === 'BS' ? Math.floor(serviceId / 10) : serviceId;
}

/**
 * Stations a TV lists for one TS, each as its main (lowest) TV service
 * followed by its other TV services (multi-channel slots).
 */
export function listedStations(
  band: Broadcast,
  entry: ScanEntry | undefined,
  epg: EpgMap | undefined,
): ScannedService[][] {
  const known = new Map(entry?.services.map((service) => [service.serviceId, service]));
  // EPG also names services the scan missed, e.g. sub-services of the built-in
  // lineup, but only of stations on this TS: stored EPG can hold stray services.
  const stationKeys = new Set([...known.keys()].map((id) => stationKey(band, id)));
  for (const id of Object.keys(epg ?? {}).map(Number))
    if (!known.has(id) && (!stationKeys.size || stationKeys.has(stationKey(band, id))))
      known.set(id, { serviceId: id, stationName: '' });
  const tv = [...known.values()]
    .filter((service) => isTvService(band, service.serviceId, service.serviceType))
    .sort((a, b) => a.serviceId - b.serviceId);
  const stations = new Map<number, ScannedService[]>();
  for (const service of tv) {
    const key = stationKey(band, service.serviceId);
    stations.set(key, [...(stations.get(key) ?? []), service]);
  }
  return [...stations.values()];
}

/**
 * The channel number a TV shows: terrestrial remote key + service number
 * (e.g. 011, 022), satellite band + service_id (e.g. BS 151). Undefined for
 * terrestrial services scanned before the remote key was recorded.
 */
export function serviceNumber(band: Broadcast, service: ScannedService): string | undefined {
  if (band !== 'T') return `${band} ${String(service.serviceId).padStart(3, '0')}`;
  if (service.remoteKey == null) return undefined;
  return `${String(service.remoteKey).padStart(2, '0')}${(service.serviceId & 7) + 1}`;
}

/**
 * Sort key matching a TV's remote-control order: terrestrial remote key then
 * service_id, satellite service_id. Terrestrial services without a recorded
 * remote key sort last.
 */
export function remoteOrder(band: Broadcast, service: ScannedService): [number, number] {
  if (band !== 'T') return [service.serviceId, 0];
  return [service.remoteKey ?? Infinity, service.serviceId];
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
        serviceType?: number;
        remoteKey?: number;
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
    // Terrestrial NIT (remote key) repeats far less often than SDT/EIT p/f.
    const needsRemoteKey = parseChannel(channel).band === 'T';
    const deadline = Date.now() + siSettleMs;
    for (;;) {
      aborted(options);
      await session.refreshTransport();
      aborted(options);
      const transport = session.transport;
      const current = (transport?.services ?? []).map((service) => {
        const program = transport?.programs?.[service.serviceId];
        return {
          serviceId: service.serviceId,
          stationName: program?.stationName?.trim() ?? '',
          ...(program?.serviceType != null ? { serviceType: program.serviceType } : {}),
          ...(program?.remoteKey != null ? { remoteKey: program.remoteKey } : {}),
        };
      });
      if (
        current.length > services.length ||
        (current.length > 0 && current.every((service) => service.stationName))
      )
        services = current;
      if (
        current.length > 0 &&
        current.every((service) => {
          const program = transport?.programs?.[service.serviceId];
          return (
            service.stationName &&
            program?.current &&
            program?.next &&
            (!needsRemoteKey || service.remoteKey != null)
          );
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
