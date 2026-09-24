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
    expect(await loadScan()).toEqual(DEFAULT_SCAN);
    await saveValue(SCAN_STORAGE_KEY, { 28: { locked: 'yes' } }, scanStore);
    expect(await loadScan()).toEqual(DEFAULT_SCAN);
  });

  it('provides the nationwide BS/CS lineup until the user scans, without persisting it', async () => {
    await saveValue(SCAN_STORAGE_KEY, undefined, scanStore);
    const defaults = await loadScan();
    expect(channelLabel('BS1_0', defaults.BS1_0)).toBe('CH BS1_0 · BS朝日');
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
    expect(channelLabel('BS9_1', scanned.BS9_1)).toBe('CH BS9_1 · New');
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
    const event = { id: 1, title: 'Now', description: '', start: 100, end: 200 };
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
