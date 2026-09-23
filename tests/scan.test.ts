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

import { saveValue, scanStore } from '../src/storage';
import {
  SCAN_STORAGE_KEY,
  channelLabel,
  isChannelHidden,
  loadScan,
  saveScan,
  scanChannels,
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
function fakeSession(script: Record<number, ScriptedChannel>): ScanSession & {
  tuned: number[];
} {
  const tuned: number[] = [];
  let current = 0;
  const session: ScanSession = {
    receiving: false,
    transport: undefined,
    receiver: {
      tune: async (channel: number) => {
        tuned.push(channel);
        current = channel;
        return { demodLocked: script[channel]?.locked ?? false };
      },
    },
    startCapture: async () => {
      (session as { receiving: boolean }).receiving = true;
    },
    retune: async (channel: number) => {
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
    expect(channelLabel(13, undefined)).toBe('CH 13');
    expect(channelLabel(13, { locked: false, services: [], scannedAt: 1 })).toBe('CH 13');
    const entry: ScanEntry = {
      locked: true,
      services: [{ serviceId: 1024, stationName: 'NHK総合1' }],
      scannedAt: 1,
    };
    expect(channelLabel(27, entry)).toBe('CH 27 · NHK総合1');
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
    expect(await loadScan()).toEqual({});
    await saveValue(SCAN_STORAGE_KEY, { 28: { locked: 'yes' } }, scanStore);
    expect(await loadScan()).toEqual({});
  });
});

describe('scanChannels', () => {
  it('moves on once every discovered service has present and following EIT', async () => {
    const session = fakeSession({
      13: { locked: true, services: [{ serviceId: 1, stationName: 'A' }] },
    });
    const refresh = session.refreshTransport.bind(session);
    const event = { id: 1, title: 'Now', description: '', start: 100, end: 200 };
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
