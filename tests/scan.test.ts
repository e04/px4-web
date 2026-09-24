import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/storage', () => {
  const mem = new Map<string, unknown>();
  return {
    scanStore: { name: 'scan' },
    settingsStore: { name: 'settings' },
    loadValue: async (key: string) => mem.get(key),
    saveValue: async (key: string, value: unknown) => {
      mem.set(key, value);
    },
  };
});

import { loadValue, saveValue, scanStore } from '../src/storage';
import type { Channel } from '../src/channels';
import {
  DEFAULT_SCAN,
  SCAN_STORAGE_KEY,
  isChannelHidden,
  isTvService,
  listedStations,
  loadScan,
  mainService,
  representativeName,
  saveScan,
  scanChannels,
  serviceNumber,
  visibleChannels,
  type ScanEntry,
  type ScanSession,
} from '../src/scan';

beforeEach(() => {
  vi.clearAllMocks();
});

interface ScriptedChannel {
  locked: boolean;
  services?: { serviceId: number; stationName: string }[];
}

// Minimal structural fake of the session subset used by scanChannels.
function fakeSession(script: Record<string, ScriptedChannel>): ScanSession & {
  tuned: Channel[];
} {
  const tuned: Channel[] = [];
  let current: Channel = 0;
  const session: ScanSession = {
    receiving: false,
    transport: undefined,
    receiver: {
      tune: async (channel: Channel) => {
        tuned.push(channel);
        current = channel;
        return { demodLocked: script[channel]?.locked ?? false };
      },
    },
    startCapture: async () => {
      (session as { receiving: boolean }).receiving = true;
    },
    retune: async (channel: Channel) => {
      tuned.push(channel);
      current = channel;
      const entry = script[channel];
      if (!entry?.locked) throw new Error('The channel could not be locked.');
      return { demodLocked: true };
    },
    refreshTransport: async () => {
      const services = script[current]?.services ?? [];
      session.transport = {
        services: services.map(({ serviceId }) => ({ serviceId })),
        programs: Object.fromEntries(
          services.map(({ serviceId, stationName }) => [serviceId, { stationName }]),
        ),
      };
    },
  };
  return Object.assign(session, { tuned });
}

describe('scan persistence and labels', () => {
  it('shows only the channel number when unscanned and the station name when scanned', () => {
    expect(representativeName(undefined)).toBe('');
    expect(representativeName({ locked: false, services: [], scannedAt: 1 })).toBe('');
    const entry: ScanEntry = {
      locked: true,
      services: [{ serviceId: 1024, stationName: 'NHK総合1' }],
      scannedAt: 1,
    };
    expect(representativeName(entry)).toBe('NHK総合1');
  });

  it('hides only known-unreceivable channels, keeping unscanned visible', () => {
    const map = {
      13: { locked: true, services: [], scannedAt: 1 },
      14: { locked: false, services: [], scannedAt: 1 },
    };
    expect(isChannelHidden(map, 13)).toBe(false);
    expect(isChannelHidden(map, 14)).toBe(true);
    expect(isChannelHidden(map, 15)).toBe(false);
    expect(isChannelHidden({}, 14)).toBe(false);
    const visible = visibleChannels(map);
    expect(visible).toContain(13);
    expect(visible).not.toContain(14);
    expect(visible).toContain(15);
    expect(visible).toHaveLength(49);
  });

  it('round-trips through IndexedDB and drops corrupt payloads', async () => {
    await saveScan({
      27: { locked: true, services: [{ serviceId: 1, stationName: 'A' }], scannedAt: 7 },
    });
    expect((await loadScan())['27']?.services[0]?.stationName).toBe('A');
    await saveValue(SCAN_STORAGE_KEY, 'not json', scanStore);
    expect(await loadScan()).toEqual(DEFAULT_SCAN);
    await saveValue(SCAN_STORAGE_KEY, { 28: { locked: 'yes' } }, scanStore);
    expect(await loadScan()).toEqual(DEFAULT_SCAN);
  });

  it('provides the nationwide BS/CS lineup until the user scans, without persisting it', async () => {
    await saveValue(SCAN_STORAGE_KEY, undefined, scanStore);
    const defaults = await loadScan();
    expect(representativeName(defaults.BS1_0)).toBe('BS朝日');
    expect(visibleChannels(defaults, 'BS')).toContain('BS15_2');
    expect(visibleChannels(defaults, 'BS')).not.toContain('BS9_1');
    expect(visibleChannels(defaults, 'CS')).toHaveLength(12);
    expect(visibleChannels(defaults, 'T')).toHaveLength(50);

    await saveScan({
      ...defaults,
      BS1_0: { locked: false, services: [], scannedAt: 5 },
      BS9_1: { locked: true, services: [{ serviceId: 999, stationName: 'New' }], scannedAt: 5 },
    });
    expect(Object.keys((await loadValue(SCAN_STORAGE_KEY, scanStore)) as object)).toEqual([
      'BS1_0',
      'BS9_1',
    ]);
    const scanned = await loadScan();
    expect(visibleChannels(scanned, 'BS')).not.toContain('BS1_0');
    expect(representativeName(scanned.BS9_1)).toBe('New');
    expect(scanned.BS1_1).toEqual(DEFAULT_SCAN.BS1_1);
  });
});

describe('scanChannels', () => {
  it('scans satellite slots independently and preserves terrestrial entries when merged', async () => {
    const session = fakeSession({
      BS1_0: { locked: true, services: [{ serviceId: 101, stationName: 'BS A' }] },
      BS1_1: { locked: false },
      BS1_2: { locked: true, services: [{ serviceId: 102, stationName: 'BS B' }] },
    });
    const result = await scanChannels(session, {
      channels: ['BS1_0', 'BS1_1', 'BS1_2'],
      siSettleMs: 0,
    });
    expect(session.tuned).toEqual(['BS1_0', 'BS1_1', 'BS1_2']);
    expect(result.BS1_0.services[0].stationName).toBe('BS A');
    expect(result.BS1_1.locked).toBe(false);
    expect(result.BS1_2.services[0].serviceId).toBe(102);
    await saveScan({ 13: { locked: true, services: [], scannedAt: 1 }, ...result });
    const restored = await loadScan();
    expect(restored['13'].locked).toBe(true);
    expect(visibleChannels(restored, 'BS')).not.toContain('BS1_1');
    expect(visibleChannels(restored, 'CS')).toContain('CS2_0');
  });
  it('waits up to 10 seconds by default for a locked channel without a station name', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession({
        13: { locked: true, services: [{ serviceId: 1, stationName: '' }] },
      });
      const scan = scanChannels(session, { channels: [13] });
      const onProgress = vi.fn();
      void scan.then(onProgress);
      await vi.advanceTimersByTimeAsync(9999);
      expect(onProgress).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect((await scan)['13']).toMatchObject({ locked: true });
      expect(onProgress).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for station names even when present and following EIT are already available', async () => {
    const session = fakeSession({
      13: { locked: true, services: [{ serviceId: 1, stationName: '' }] },
    });
    const refresh = session.refreshTransport.bind(session);
    const event = { id: 1, title: 'Now', description: '', genres: [], start: 100, end: 200 };
    let calls = 0;
    session.refreshTransport = async () => {
      await refresh();
      calls++;
      session.transport!.programs![1] = {
        stationName: calls >= 2 ? 'Station A' : '',
        current: event,
        next: { ...event, id: 2 },
      };
    };
    const result = await scanChannels(session, {
      channels: [13],
      siSettleMs: 5000,
      pollMs: 0,
    });
    expect(calls).toBe(2);
    expect(result['13']?.services).toEqual([{ serviceId: 1, stationName: 'Station A' }]);
  });

  it('stops on hardware errors instead of marking remaining channels unreceivable', async () => {
    const session = fakeSession({ 13: { locked: true, services: [] } });
    session.retune = async () => {
      throw new Error('Reconnection required');
    };
    const seen: number[] = [];
    await expect(
      scanChannels(session, {
        channels: [13, 14, 15],
        siSettleMs: 0,
        onProgress: (channel) => seen.push(channel),
      }),
    ).rejects.toThrow('Reconnection required');
    expect(seen).toEqual([13]);
  });

  it('stops scanning if SI reception fails after locking', async () => {
    const session = fakeSession({ 13: { locked: true } });
    session.refreshTransport = async () => {
      throw new Error('TS Worker closed');
    };
    const onProgress = vi.fn();
    await expect(scanChannels(session, { channels: [13, 14], onProgress })).rejects.toThrow(
      'TS Worker closed',
    );
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('moves on once every discovered service has present and following EIT', async () => {
    const session = fakeSession({
      13: { locked: true, services: [{ serviceId: 1, stationName: 'A' }] },
    });
    const refresh = session.refreshTransport.bind(session);
    const event = { id: 1, title: 'Now', description: '', genres: [], start: 100, end: 200 };
    let calls = 0;
    session.refreshTransport = async () => {
      await refresh();
      calls++;
      if (calls >= 2)
        session.transport!.programs![1] = {
          stationName: 'A',
          current: event,
          next: { ...event, id: 2 },
        };
    };
    const seen: number[] = [];
    await scanChannels(session, {
      channels: [13],
      siSettleMs: 5000,
      pollMs: 0,
      onPrograms: (channel, programs) => {
        seen.push(channel);
        expect(programs[1]?.next?.id).toBe(2);
      },
    });
    expect(calls).toBe(2);
    expect(seen).toEqual([13]);
  });
  it('records locks with station names and skips unlocked channels', async () => {
    const session = fakeSession({
      13: { locked: true, services: [{ serviceId: 1, stationName: 'Station A' }] },
      14: { locked: false },
      15: { locked: true, services: [] },
    });
    const seen: [number, ScanEntry][] = [];
    const result = await scanChannels(session, {
      channels: [13, 14, 15],
      siSettleMs: 0,
      pollMs: 0,
      onProgress: (channel, entry, done, total) => {
        seen.push([channel, entry]);
        expect(done).toBeLessThanOrEqual(total);
      },
    });
    expect(result['13']).toMatchObject({ locked: true });
    expect(result['13']?.services).toEqual([{ serviceId: 1, stationName: 'Station A' }]);
    expect(result['14']).toMatchObject({ locked: false, services: [] });
    expect(result['15']).toMatchObject({ locked: true, services: [] });
    expect(seen.map(([channel]) => channel)).toEqual([13, 14, 15]);
    // First channel tunes + captures, the rest reuse the same session.
    expect(session.tuned).toEqual([13, 14, 15]);
  });

  it('stops on cancellation', async () => {
    const session = fakeSession({ 13: { locked: true }, 14: { locked: true } });
    let calls = 0;
    await expect(
      scanChannels(session, {
        channels: [13, 14],
        siSettleMs: 0,
        pollMs: 0,
        isAborted: () => ++calls > 1,
      }),
    ).rejects.toThrow('Scan cancelled');
  });

  it('cancels the SI polling delay without waiting for its timer', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession({ 13: { locked: true } });
      const controller = new AbortController();
      const scan = scanChannels(session, {
        channels: [13],
        siSettleMs: 30_000,
        pollMs: 30_000,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(session.transport).toBeDefined());
      controller.abort();
      await expect(scan).rejects.toThrow('Scan cancelled');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TV service listing', () => {
  const event = (id: number, start: number, end: number) => ({
    id,
    title: 'x',
    description: '',
    start,
    end,
  });
  const entry = (...services: [number, number?][]): ScanEntry => ({
    locked: true,
    services: services.map(([serviceId, serviceType]) => ({
      serviceId,
      stationName: `S${serviceId}`,
      ...(serviceType != null ? { serviceType } : {}),
    })),
    scannedAt: 1,
  });

  it('skips terrestrial one-seg and data services by service_id', () => {
    expect(isTvService('T', 1032)).toBe(true);
    expect(isTvService('T', 1033)).toBe(true);
    expect(isTvService('T', 1032 | 0x180)).toBe(false);
    expect(isTvService('T', 1032 | 0x80)).toBe(false);
    expect(isTvService('T', 1032 | 0x180, 0x01)).toBe(false);
  });

  it('uses service_type when known, else satellite numbering', () => {
    expect(isTvService('BS', 151, 0x01)).toBe(true);
    expect(isTvService('BS', 151, 0xc0)).toBe(false);
    expect(isTvService('BS', 151)).toBe(true);
    expect(isTvService('BS', 700)).toBe(false);
  });

  it('opens the lowest TV service of a TS', () => {
    expect(mainService('T', [1033, 1032 | 0x180, 1032], undefined)).toBe(1032);
    expect(mainService('BS', [700, 153, 151], entry([151, 1], [153, 1], [700, 0xc0]))).toBe(151);
    expect(mainService('BS', [700], undefined)).toBe(700);
  });

  it('groups terrestrial multi-channel slots and drops one-seg', () => {
    const scanned = entry([1032], [1033], [1032 | 0x180]);
    expect(
      listedStations('T', scanned, undefined).map((station) => station.map((s) => s.serviceId)),
    ).toEqual([[1032, 1033]]);
  });

  it('keeps each 110°CS channel of a TS as its own station', () => {
    const now = 1_000_000;
    const scanned = entry([296, 1], [297, 1], [300, 1], [55, 1]);
    const epg = { 296: [event(1, now, now + 10)] };
    expect(
      listedStations('CS', scanned, epg).map((station) => station.map((s) => s.serviceId)),
    ).toEqual([[55], [296], [297], [300]]);
  });

  it('groups BS services by broadcaster within a TS', () => {
    const scanned = entry([151, 1], [152, 1], [161, 1]);
    expect(
      listedStations('BS', scanned, undefined).map((station) => station.map((s) => s.serviceId)),
    ).toEqual([[151, 152], [161]]);
  });

  it('numbers services as a TV does', () => {
    expect(serviceNumber('T', { serviceId: 1033, stationName: '', remoteKey: 2 })).toBe('022');
    expect(serviceNumber('T', { serviceId: 1033, stationName: '' })).toBeUndefined();
    expect(serviceNumber('BS', { serviceId: 151, stationName: '' })).toBe('BS 151');
    expect(serviceNumber('CS', { serviceId: 55, stationName: '' })).toBe('CS 055');
  });

  it('ignores EPG services of other stations on a scanned TS', () => {
    const now = 1_000_000;
    const epg = { 1056: [event(1, now, now + 10)], 1032: [event(2, now, now + 10)] };
    expect(
      listedStations('T', entry([1056, 1]), epg).map((station) => station.map((s) => s.serviceId)),
    ).toEqual([[1056]]);
  });

  it('adds EPG-only services missing from the built-in lineup', () => {
    const now = 1_000_000;
    const epg = { 151: [event(1, now, now + 10)], 152: [event(2, now, now + 10)] };
    expect(
      listedStations('BS', DEFAULT_SCAN.BS1_0, epg).map((g) =>
        g.map((s) => [s.serviceId, s.stationName]),
      ),
    ).toEqual([
      [
        [151, 'BS朝日'],
        [152, ''],
      ],
    ]);
  });
});
