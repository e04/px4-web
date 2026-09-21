import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { loadBundledFirmware, type FirmwareImage } from '../../driver/firmware';
import type { ReceiverEvent } from '../../driver/receiver';
import type { TransportSnapshot } from '../../transport/pipeline';
import { ReceiverSession } from '../../usb/receiver-session';
import {
  SCAN_CHANNELS,
  channelLabel,
  isChannelHidden,
  loadScan,
  saveScan,
  scanChannels,
  visibleChannels,
  type ScanEntry,
  type ScanMap,
} from '../../scan';
import { CHANNEL_KEY, saveValue, settingsStore } from '../../storage';
import { DEFAULT_CHANNEL, SCAN_OPTION, loadChannel, stateLabels } from '../format';
import { currentChannelProgram, loadEpg, mergeEpg, saveEpg, type EpgMap } from '../../epg';
import type { ProgramInfo } from '../../transport/program-info';

export type StreamStats = NonNullable<ReceiverSession['streamStats']>;

export interface ScanProgress {
  done: number;
  total: number;
  channel: number;
}

export interface ScanResult {
  channel: number;
  entry: ScanEntry;
}

interface UseReceiverSessionOptions {
  sessionRef: RefObject<ReceiverSession | undefined>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setStatus: (status: string) => void;
  addLog: (message: string, error?: boolean) => void;
  stopPlayer: (message?: string) => void;
  openPlayback: (serviceId: string) => Promise<void>;
  refreshPlayback: () => void;
}

export function useReceiverSession({
  sessionRef,
  busy,
  setBusy,
  setStatus,
  addLog,
  stopPlayer,
  openPlayback,
  refreshPlayback,
}: UseReceiverSessionOptions) {
  const [scan, setScan] = useState<ScanMap>({});
  const [channel, setChannel] = useState<string>(DEFAULT_CHANNEL);
  const hydratedRef = useRef(false);
  const [service, setService] = useState<string | null>(null);
  const [services, setServices] = useState<number[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const scanAbortRef = useRef(false);
  const [scanEvents, setScanEvents] = useState<ScanResult[]>([]);
  const [channelEpg, setChannelEpg] = useState<Record<string, EpgMap>>({});
  const [epgNow, setEpgNow] = useState(Date.now());
  const channelOptions = useMemo(
    () => [
      { value: SCAN_OPTION, label: 'Scan channels…', station: 'Scan channels…', program: '' },
      ...visibleChannels(scan).map((item) => {
        const entry = scan[String(item)];
        const event = currentChannelProgram(
          channelEpg[String(item)], entry?.services.map((service) => service.serviceId) ?? [], epgNow,
        );
        const station = channelLabel(item, entry);
        return {
          value: String(item),
          label: `${station}${event ? ` · ${event.title}` : ''}`,
          station,
          program: event?.title ?? '',
        };
      }),
    ],
    [scan, channelEpg, epgNow],
  );
  const [transport, setTransport] = useState<TransportSnapshot>();
  const epgRef = useRef<EpgMap>({});
  const channelRef = useRef(channel);
  channelRef.current = channel;
  const lastEpgSave = useRef(0);
  const epgDirty = useRef(false);
  const scanActiveRef = useRef(false);
  const [stream, setStream] = useState<StreamStats>();
  const [connected, setConnected] = useState(false);
  const [deviceLabel, setDeviceLabel] = useState('');
  const [cardless, setCardless] = useState(false);
  const [b25, setB25] = useState<Record<string, number | boolean | undefined>>();
  const firmwareRef = useRef<FirmwareImage | undefined>(undefined);

  // The binary is bundled at build time: fetch once, reuse for the session.
  const ensureFirmware = async (): Promise<FirmwareImage> => {
    if (firmwareRef.current) return firmwareRef.current;
    const image = await loadBundledFirmware();
    firmwareRef.current = image;
    addLog(`Firmware loaded: ${image.name} (${image.size} bytes)`);
    return image;
  };

  const closeSession = async (message?: string) => {
    stopPlayer();
    const session = sessionRef.current;
    sessionRef.current = undefined;
    setConnected(false);
    if (session) await session.close();
    setServices([]);
    setService(null);
    setTransport(undefined);
    setStream(undefined);
    setB25(undefined);
    setDeviceLabel('');
    setCardless(false);
    setStatus('Disconnected');
    if (message) addLog(message);
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all(SCAN_CHANNELS.map(async (number) => [String(number), await loadEpg(String(number))] as const)).then((entries) => {
      if (!cancelled) setChannelEpg((current) => ({ ...Object.fromEntries(entries), ...current }));
    });
    const timer = window.setInterval(() => setEpgNow(Date.now()), 30000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [savedScan, savedChannel] = await Promise.all([loadScan(), loadChannel()]);
      if (cancelled) return;
      setScan(savedScan);
      if (!isChannelHidden(savedScan, savedChannel)) setChannel(savedChannel);
      else {
        const first = visibleChannels(savedScan)[0];
        setChannel(first != null ? String(first) : savedChannel);
      }
      hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    void saveValue(CHANNEL_KEY, channel, settingsStore);
  }, [channel]);

  useEffect(() => {
    let cancelled = false;
    epgRef.current = {};
    epgDirty.current = false;
    void loadEpg(channel).then((saved) => {
      if (cancelled) return;
      const merged = mergeEpg(saved, Object.fromEntries(
        Object.entries(epgRef.current).map(([id, future]) => [id, { serviceId: Number(id), stationName: '', current: null, next: null, future }]),
      ));
      epgRef.current = merged;
      setChannelEpg((current) => ({ ...current, [channel]: merged }));
    });
    return () => {
      cancelled = true;
      if (epgDirty.current) void saveEpg(channel, epgRef.current);
    };
  }, [channel]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = sessionRef.current;
      if (current && !scanActiveRef.current) {
        void current
          .refreshTransport()
          .then(() => {
            if (sessionRef.current !== current) return;
            setTransport(current.transport ? { ...current.transport } : undefined);
            if (current.transport?.programs) {
              const next = mergeEpg(epgRef.current, current.transport.programs);
              if (JSON.stringify(next) !== JSON.stringify(epgRef.current)) {
                epgRef.current = next;
                epgDirty.current = true;
                setChannelEpg((known) => ({ ...known, [channelRef.current]: next }));
                if (Date.now() - lastEpgSave.current > 5000) {
                  lastEpgSave.current = Date.now();
                  void saveEpg(channelRef.current, next);
                  epgDirty.current = false;
                }
              }
            }
            setStream(current.streamStats ? { ...current.streamStats } : undefined);
            const nextServices = current.transport?.services.map((item) => item.serviceId) ?? [];
            setServices(nextServices);
            setService((selected) =>
              selected && nextServices.includes(Number(selected))
                ? selected
                : (nextServices[0]?.toString() ?? null),
            );
            const snapshot = current.b25?.snapshot;
            setB25(
              snapshot
                ? {
                    inputBytes: snapshot.inputBytes,
                    outputBytes: snapshot.outputBytes,
                    queuedBytes: snapshot.queuedBytes,
                    packets: snapshot.packets,
                    scrambled: snapshot.scrambled,
                    cardReady: !!current.card?.atr,
                  }
                : undefined,
            );
          })
          .catch(() => {});
      }
      refreshPlayback();
    }, 500);
    const unload = () => {
      void closeSession();
    };
    window.addEventListener('pagehide', unload);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', unload);
      void closeSession();
    };
    // The session is intentionally owned for the lifetime of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onReceiverEvent = (event: ReceiverEvent) => {
    const label = stateLabels[event.state] ?? event.state;
    setStatus(label);
    addLog(label, event.state === 'error' || event.state === 'disconnected');
    if (
      ['stopping', 'stopped', 'error', 'disconnected', 'tuning', 'initializing'].includes(
        event.state,
      )
    )
      stopPlayer();
  };

  const waitForServices = async (session: ReceiverSession) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      await session.refreshTransport();
      if (session.transport?.services.length)
        return session.transport.services.map((item) => item.serviceId);
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    throw new Error('No services were found. Check the antenna and channel.');
  };

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const firmware = await ensureFirmware();
      const session = await ReceiverSession.connect(onReceiverEvent, () => {});
      sessionRef.current = session;
      setConnected(true);
      setDeviceLabel(session.deviceInfo.productName);
      setCardless(!session.deviceInfo.hasCardReader);
      addLog(
        `${session.deviceInfo.productName} connected${session.deviceInfo.devId != null ? ` (dev ${session.deviceInfo.devId})` : ''}${session.deviceInfo.hasCardReader ? '' : ' [no card reader]'}`,
      );
      await session.receiver.initialize(firmware);
      // ponytail: empty map = never scanned; partial scan counts as done.
      if (hydratedRef.current && Object.keys(scan).length === 0) {
        addLog('No scan data — starting channel scan');
        await runScan(true);
        return;
      }
      const result = await session.receiver.tune(Number(channel));
      if (!result.demodLocked) throw new Error('The channel could not be locked.');
      await session.startCapture();
      setStatus('Discovering services');
      const found = await waitForServices(session);
      setServices(found);
      setService(String(found[0]));
      addLog(`${found.length} service${found.length === 1 ? '' : 's'} found`);
      if (!session.deviceInfo.hasCardReader) {
        addLog('Card reader is on the primary side', true);
        setStatus('Playback error: Card reader is on the primary side');
        return;
      }
      try {
        await openPlayback(String(found[0]));
      } catch (error) {
        addLog(error instanceof Error ? error.message : String(error), true);
        stopPlayer();
        setStatus(`Playback error: ${String(error)}`);
      }
    } catch (error) {
      addLog(error instanceof Error ? error.message : String(error), true);
      await closeSession();
    } finally {
      setBusy(false);
    }
  };

  // Tune/service failures keep the USB session so the user can pick another
  // channel. Only a dead receiver or closed device escalates to closeSession.
  const isFatalSession = (session: ReceiverSession) =>
    session.receiver.state === 'error' ||
    session.receiver.state === 'disconnected' ||
    !session.device.opened;

  const failSoft = (error: unknown, fallback: string) => {
    const message = error instanceof Error ? error.message : String(error);
    addLog(message || fallback, true);
    stopPlayer();
    setStatus(`${message || fallback} Select another channel.`);
  };

  const changeChannel = async (value: string | null) => {
    if (!value) return;
    if (value === SCAN_OPTION) {
      void runScan();
      return;
    }
    setChannel(value);
    const session = sessionRef.current;
    if (!session || !connected || busy) return;
    setBusy(true);
    try {
      stopPlayer();
      setStatus(`Switching to CH ${value}`);
      addLog(`Switching to CH ${value}`);
      await session.retune(Number(value));
      setStatus('Discovering services');
      const found = await waitForServices(session);
      setServices(found);
      const next = service && found.includes(Number(service)) ? service : String(found[0]);
      setService(next);
      try {
        await openPlayback(next);
      } catch (error) {
        addLog(error instanceof Error ? error.message : String(error), true);
        stopPlayer();
        setStatus(`Playback error: ${String(error)}`);
        return;
      }
      addLog(`${found.length} service${found.length === 1 ? '' : 's'} found`);
    } catch (error) {
      if (sessionRef.current !== session) return;
      if (isFatalSession(session)) {
        addLog(error instanceof Error ? error.message : String(error), true);
        await closeSession('Stopped after switch failure');
      } else {
        failSoft(error, `CH ${value} is not receivable.`);
      }
    } finally {
      setBusy(false);
    }
  };

  const changeService = async (value: string | null) => {
    if (!value) return;
    setService(value);
    const session = sessionRef.current;
    if (!session || !connected || busy) return;
    setBusy(true);
    try {
      stopPlayer();
      setStatus(`Switching to service ${value}`);
      // Same multiplex: the USB stream keeps running, only the B25 filter and player restart.
      await openPlayback(value);
    } catch (error) {
      addLog(error instanceof Error ? error.message : String(error), true);
      stopPlayer();
      setStatus(`Playback error: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const cancelScan = () => {
    scanAbortRef.current = true;
  };

  // Scan CH 13-62 in order, persisting station names for the channel labels.
  // Works on the live session or connects first when disconnected.
  const runScan = async (fromConnect = false) => {
    if (scanning || (busy && !fromConnect)) return;
    scanAbortRef.current = false;
    scanActiveRef.current = true;
    setScanning(true);
    setBusy(true);
    setScanEvents([]);
    setScanProgress({ done: 0, total: SCAN_CHANNELS.length, channel: SCAN_CHANNELS[0] });
    const priorChannel = channel;
    const seeded = scan;
    const merged: ScanMap = { ...seeded };
    let session: ReceiverSession | undefined = sessionRef.current;
    const owned = !session;
    const restore = async (results: ScanMap) => {
      const current = sessionRef.current;
      if (!session || current !== session) return;
      // Stay on a visible channel: fall back to the first receivable one when
      // the previous channel turned out unreceivable.
      const fallback = visibleChannels(results)[0];
      const target =
        results[priorChannel]?.locked || !results[priorChannel]
          ? priorChannel
          : fallback != null
            ? String(fallback)
            : priorChannel;
      if (target == null) {
        setStatus(owned ? 'No receivable channels found' : 'Ready');
        return;
      }
      setChannel(target);
      try {
        await session.retune(Number(target));
        setStatus('Discovering services');
        const found = await waitForServices(session);
        setServices(found);
        setService(String(found[0]));
        addLog(`${found.length} service${found.length === 1 ? '' : 's'} found on CH ${target}`);
        await openPlayback(String(found[0]));
      } catch (error) {
        if (sessionRef.current !== session) return;
        if (isFatalSession(session)) {
          addLog(error instanceof Error ? error.message : String(error), true);
          await closeSession('Stopped after scan');
        } else {
          failSoft(error, `CH ${target} is not receivable.`);
        }
      }
    };
    try {
      const firmware = await ensureFirmware();
      stopPlayer();
      if (!session) {
        const fresh = await ReceiverSession.connect(onReceiverEvent, () => {});
        sessionRef.current = fresh;
        session = fresh;
        setConnected(true);
        setDeviceLabel(fresh.deviceInfo.productName);
        setCardless(!fresh.deviceInfo.hasCardReader);
        addLog(
          `${fresh.deviceInfo.productName} connected${fresh.deviceInfo.devId != null ? ` (dev ${fresh.deviceInfo.devId})` : ''}${fresh.deviceInfo.hasCardReader ? '' : ' [no card reader]'}`,
        );
        await fresh.receiver.initialize(firmware);
      }
      setStatus(`Scanning channels (0/${SCAN_CHANNELS.length})`);
      await scanChannels(session, {
        isAborted: () => scanAbortRef.current,
        onPrograms: async (found, programs) => {
          const channelKey = String(found);
          const saved = await loadEpg(channelKey);
          const complete: Record<number, ProgramInfo> = Object.fromEntries(
            Object.entries(programs).map(([id, program]) => [id, {
              serviceId: Number(id), stationName: program.stationName ?? '',
              current: program.current ?? null, next: program.next ?? null,
              future: program.future ?? [],
            }]),
          );
          const next = mergeEpg(saved, complete);
          await saveEpg(channelKey, next);
          setChannelEpg((known) => ({ ...known, [channelKey]: next }));
        },
        onProgress: (found, entry, done, total) => {
          merged[String(found)] = entry;
          const snapshot = { ...merged };
          setScan(snapshot);
          void saveScan(snapshot);
          setScanEvents((prev) => [...prev, { channel: found, entry }]);
          setScanProgress({ done, total, channel: found });
          setStatus(`Scanning CH ${found} (${done}/${total})`);
        },
      });
      const locked = Object.values(merged).filter((entry) => entry.locked);
      addLog(`Scan complete: ${locked.length}/${SCAN_CHANNELS.length} channels receivable`);
      await restore(merged);
    } catch (error) {
      const cancelled =
        scanAbortRef.current || (error instanceof Error && error.message === 'Scan cancelled');
      if (cancelled) {
        addLog('Scan cancelled');
        await restore(merged);
      } else if (!session || sessionRef.current !== session) {
        addLog(error instanceof Error ? error.message : String(error), true);
        await closeSession();
      } else if (isFatalSession(session)) {
        addLog(error instanceof Error ? error.message : String(error), true);
        await closeSession('Stopped after scan failure');
      } else {
        failSoft(error, 'Scan failed.');
        await restore(merged);
      }
    } finally {
      scanActiveRef.current = false;
      setScanning(false);
      setBusy(false);
      setScanProgress(null);
    }
  };

  return {
    scan,
    channel,
    service,
    services,
    channelOptions,
    scanning,
    scanProgress,
    scanEvents,
    transport,
    stream,
    connected,
    deviceLabel,
    cardless,
    b25,
    connect,
    changeChannel,
    changeService,
    cancelScan,
    runScan,
  };
}
