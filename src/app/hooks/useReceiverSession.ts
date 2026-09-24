import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { loadBundledFirmware, type FirmwareImage } from '../../driver/firmware';
import type { ReceiverEvent } from '../../driver/receiver';
import type { TransportSnapshot } from '../../transport/pipeline';
import { ReceiverSession } from '../../usb/receiver-session';
import {
  DEFAULT_SCAN,
  isChannelHidden,
  listedStations,
  loadScan,
  mainService,
  representativeName,
  serviceNumber,
  saveScan,
  scanChannels,
  visibleChannels,
  type ScanEntry,
  type ScanMap,
} from '../../scan';
import { CHANNEL_KEY, SERVICE_KEY, loadValue, saveValue, settingsStore } from '../../storage';
import { DEFAULT_CHANNEL, loadChannel, stateLabels } from '../format';
import { loadEpg, mergeEpg, saveEpg, type EpgMap } from '../../epg';
import { crawlEpg } from '../../epg-crawl';
import type { ProgramInfo } from '../../transport/program-info';
import { logoDataUrl, logoKey, type LogoData } from '../../logo';
import { loadLogos, mergeLogos, type LogoLibrary } from '../../logo-store';
import { channelsFor, parseChannel, type Broadcast, type Channel } from '../../channels';

export type StreamStats = NonNullable<ReceiverSession['streamStats']>;

export type ChannelOption = ReturnType<typeof useReceiverSession>['channelOptions'][number];

export interface ScanProgress {
  done: number;
  total: number;
  channel: Channel;
}

export interface ScanResult {
  channel: Channel;
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
  const [scan, setScan] = useState<ScanMap>(DEFAULT_SCAN);
  const [channel, setChannel] = useState<string>(DEFAULT_CHANNEL);
  const band = parseChannel(channel).band;
  const hydratedRef = useRef(false);
  const [service, setService] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanCancelling, setScanCancelling] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const scanAbortRef = useRef(false);
  const scanControllerRef = useRef<AbortController | null>(null);
  const [scanEvents, setScanEvents] = useState<ScanResult[]>([]);
  const [channelEpg, setChannelEpg] = useState<Record<string, EpgMap>>({});
  const [epgNow, setEpgNow] = useState(Date.now());
  const [logoLibrary, setLogoLibrary] = useState<LogoLibrary>({ logos: {}, channels: {} });
  const logoLibraryRef = useRef(logoLibrary);
  const logoUrls = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(logoLibrary.logos).map(([key, logo]) => [key, logoDataUrl(logo.png)]),
      ),
    [logoLibrary.logos],
  );
  const logoFor = (channelValue: string, serviceId: number | string | null | undefined) => {
    const ref =
      serviceId == null ? undefined : logoLibrary.channels[channelValue]?.[Number(serviceId)];
    return ref ? logoUrls[logoKey(ref)] : undefined;
  };
  // One row per station, fronted by its main service; its other services
  // (e.g. an on-air sub-channel) share the row's timeline where their programs
  // differ. A TS may carry several stations (110°CS), each getting its own row.
  const channelOptions = useMemo(
    () =>
      (['T', 'BS', 'CS'] as const).flatMap((optionBand) =>
        visibleChannels(scan, optionBand).flatMap((item) => {
          const entry = scan[String(item)];
          const epg = channelEpg[String(item)];
          const logoRefs = logoLibrary.channels[String(item)];
          const stations = listedStations(optionBand, entry, epg);
          // Unscanned channels have no known service; tuning then opens the main one.
          return (stations.length ? stations : [[]]).map((services, index) => {
            const main = services[0];
            const logoRef = main ? logoRefs?.[main.serviceId] : undefined;
            return {
              value: `${item}/${main?.serviceId ?? ''}`,
              channel: String(item),
              serviceId: main?.serviceId ?? null,
              services,
              name: main?.stationName || (index === 0 ? representativeName(entry) : ''),
              number: (main && serviceNumber(optionBand, main)) ?? `CH ${item}`,
              schedules: services.map((service) => ({
                serviceId: service.serviceId,
                events: epg?.[service.serviceId] ?? [],
              })),
              band: optionBand,
              logo: logoRef ? logoUrls[logoKey(logoRef)] : undefined,
            };
          });
        }),
      ),
    [scan, channelEpg, logoLibrary.channels, logoUrls],
  );
  const tunedOptions = channelOptions.filter((option) => option.channel === channel);
  const selectedOption =
    tunedOptions.find((option) =>
      option.services.some((item) => String(item.serviceId) === service),
    ) ?? tunedOptions[0];
  const [transport, setTransport] = useState<TransportSnapshot>();
  const [programs, setPrograms] = useState<TransportSnapshot['programs']>();
  // Scan-known name of the tuned service; live SDT names take precedence in the UI.
  const selectedName =
    selectedOption &&
    (selectedOption.services.find((item) => String(item.serviceId) === service)?.stationName ||
      selectedOption.name ||
      selectedOption.number);
  const programKeyRef = useRef<string | undefined>(undefined);
  const epgRef = useRef<EpgMap>({});
  const channelRef = useRef(channel);
  channelRef.current = channel;
  // The channel the main tuner's stream carries; unset while a tune is in flight
  // so SI polled from the previous multiplex is never filed under the new one.
  const streamChannelRef = useRef<string | undefined>(undefined);
  const lastEpgSave = useRef(0);
  const epgDirty = useRef(false);
  const scanActiveRef = useRef(false);
  const [stream, setStream] = useState<StreamStats>();
  const [connected, setConnected] = useState(false);
  const [deviceLabel, setDeviceLabel] = useState('');
  const [cardless, setCardless] = useState(false);
  const [b25, setB25] = useState<Record<string, number | boolean | undefined>>();
  // '' = no free tuner; otherwise what the EPG crawl tuner is doing.
  const [epgCrawl, setEpgCrawl] = useState('');
  const scanRef = useRef(scan);
  scanRef.current = scan;
  const crawlDoneRef = useRef<Promise<void>>(Promise.resolve());
  const firmwareRef = useRef<FirmwareImage | undefined>(undefined);

  // The binary is bundled at build time: fetch once, reuse for the session.
  const ensureFirmware = async (): Promise<FirmwareImage> => {
    if (firmwareRef.current) return firmwareRef.current;
    const image = await loadBundledFirmware();
    firmwareRef.current = image;
    addLog(`Firmware loaded: ${image.name} (${image.size} bytes)`);
    return image;
  };

  // Services name their logo in SDT; the image may arrive later, or on another TS.
  const recordLogos = (
    channelValue: string,
    received: Record<number, ProgramInfo>,
    logos: LogoData[],
  ) => {
    const refs = Object.fromEntries(
      Object.values(received).flatMap((program) =>
        program.logo ? [[program.serviceId, program.logo] as const] : [],
      ),
    );
    const next = mergeLogos(logoLibraryRef.current, channelValue, refs, logos);
    if (next === logoLibraryRef.current) return;
    logoLibraryRef.current = next;
    setLogoLibrary(next);
  };
  const logoMissing = (
    transport: { programs?: Record<number, ProgramInfo>; logos?: LogoData[] } | undefined,
  ) =>
    Object.values(transport?.programs ?? {}).some(
      (program) =>
        program.logo &&
        !logoLibraryRef.current.logos[logoKey(program.logo)] &&
        !transport?.logos?.some((logo) => logoKey(logo) === logoKey(program.logo!)),
    );

  const closeSession = async (message?: string) => {
    stopPlayer();
    const session = sessionRef.current;
    sessionRef.current = undefined;
    streamChannelRef.current = undefined;
    setConnected(false);
    if (session) await session.close();
    setService(null);
    setTransport(undefined);
    setPrograms(undefined);
    programKeyRef.current = undefined;
    setStream(undefined);
    setB25(undefined);
    setDeviceLabel('');
    setCardless(false);
    setStatus('Disconnected');
    if (message) addLog(message);
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      (['T', 'BS', 'CS'] as const)
        .flatMap(channelsFor)
        .map(async (number) => [String(number), await loadEpg(String(number))] as const),
    ).then((entries) => {
      if (!cancelled) setChannelEpg((current) => ({ ...Object.fromEntries(entries), ...current }));
    });
    void loadLogos().then((saved) => {
      if (cancelled) return;
      // Anything received before storage answered is newer.
      const current = logoLibraryRef.current;
      const next = {
        logos: { ...saved.logos, ...current.logos },
        channels: { ...saved.channels, ...current.channels },
      };
      logoLibraryRef.current = next;
      setLogoLibrary(next);
    });
    const timer = window.setInterval(() => setEpgNow(Date.now()), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [savedScan, savedChannel, savedService] = await Promise.all([
        loadScan(),
        loadChannel(),
        loadValue<unknown>(SERVICE_KEY, settingsStore),
      ]);
      if (cancelled) return;
      setScan(savedScan);
      if (!isChannelHidden(savedScan, savedChannel)) {
        setChannel(savedChannel);
        if (typeof savedService === 'string') setService(savedService);
      } else {
        const first = visibleChannels(savedScan, parseChannel(savedChannel).band)[0];
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
    if (!hydratedRef.current || service == null) return;
    void saveValue(SERVICE_KEY, service, settingsStore);
  }, [service]);

  useEffect(() => {
    let cancelled = false;
    epgRef.current = {};
    epgDirty.current = false;
    void loadEpg(channel).then((saved) => {
      if (cancelled) return;
      const merged = mergeEpg(
        saved,
        Object.fromEntries(
          Object.entries(epgRef.current).map(([id, future]) => [
            id,
            { serviceId: Number(id), stationName: '', current: null, next: null, future },
          ]),
        ),
      );
      epgRef.current = merged;
      setChannelEpg((current) => ({ ...current, [channel]: merged }));
    });
    return () => {
      cancelled = true;
      if (epgDirty.current) void saveEpg(channel, epgRef.current);
    };
  }, [channel]);

  useEffect(() => {
    let lastProgramPoll = 0;
    const timer = window.setInterval(() => {
      const current = sessionRef.current;
      if (current && !scanActiveRef.current) {
        const streamChannel = streamChannelRef.current;
        void current
          .refreshTransport()
          .then(() => {
            if (sessionRef.current !== current) return;
            setTransport(current.transport ? { ...current.transport } : undefined);
            if (
              current.transport?.programs &&
              streamChannel === channelRef.current &&
              streamChannel === streamChannelRef.current &&
              (programKeyRef.current === undefined || performance.now() - lastProgramPoll >= 2000)
            ) {
              lastProgramPoll = performance.now();
              recordLogos(
                channelRef.current,
                current.transport.programs,
                current.transport.logos ?? [],
              );
              const key = JSON.stringify(current.transport.programs);
              if (key !== programKeyRef.current) {
                programKeyRef.current = key;
                setPrograms(current.transport.programs);
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
            }
            setStream(current.streamStats ? { ...current.streamStats } : undefined);
            const nextServices = current.transport?.services.map((item) => item.serviceId) ?? [];
            setService((selected) =>
              selected && nextServices.includes(Number(selected))
                ? selected
                : (mainService(
                    parseChannel(channelRef.current).band,
                    nextServices,
                    scanRef.current[channelRef.current],
                  )?.toString() ?? null),
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

  // A free tuner (PX4/PX5 second tuner pair) cycles every receivable channel
  // for EPG while the main tuner plays. Scans own the device, so crawl pauses.
  useEffect(() => {
    const session = sessionRef.current;
    if (!connected || scanning || !session?.hasEpgTuner) return;
    const controller = new AbortController();
    const previous = crawlDoneRef.current;
    setEpgCrawl('Idle');
    // Wait for a missing logo once per channel; CDT repeats far less often than EIT.
    const logoWaited = new Set<string>();
    const done = previous.then(() =>
      crawlEpg(session, {
        signal: controller.signal,
        channels: () =>
          (['T', 'BS', 'CS'] as const)
            .flatMap(channelsFor)
            .filter((item) => scanRef.current[String(item)]?.locked),
        skip: (item) => String(item) === channelRef.current,
        hold: (item, transport) => !logoWaited.has(String(item)) && logoMissing(transport),
        onChannel: (item) => {
          if (!controller.signal.aborted) setEpgCrawl(item == null ? 'Idle' : `CH ${item}`);
        },
        onPrograms: async (item, programs, logos) => {
          const key = String(item);
          logoWaited.add(key);
          recordLogos(key, programs, logos);
          // The main tuner now owns this channel's EPG.
          if (key === channelRef.current) return;
          const next = mergeEpg(await loadEpg(key), programs);
          await saveEpg(key, next);
          setChannelEpg((known) => ({ ...known, [key]: next }));
        },
        onError: (item, error) =>
          addLog(
            `EPG tuner CH ${item}: ${error instanceof Error ? error.message : String(error)}`,
            true,
          ),
        onRound: (count) => addLog(`EPG crawl round complete (${count} channels)`),
      }),
    );
    crawlDoneRef.current = done.catch(() => {});
    return () => {
      controller.abort();
      setEpgCrawl('');
    };
    // Session identity changes always toggle `connected`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, scanning]);

  const onReceiverEvent = (event: ReceiverEvent) => {
    const label = stateLabels[event.state] ?? event.state;
    setStatus(label);
    addLog(label, event.state === 'error' || event.state === 'disconnected');
    if (event.state === 'disconnected' && sessionRef.current?.receiver.state === 'disconnected')
      void closeSession().catch((error) => addLog(String(error), true));
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

  // The requested service when the TS carries it, otherwise the TS's main service.
  const pickService = (value: string, found: number[], preferred: string | null) =>
    preferred && found.includes(Number(preferred))
      ? preferred
      : String(mainService(parseChannel(value).band, found, scanRef.current[value]));

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
      // ponytail: no entries for this band = never scanned; partial scan counts as done.
      // BS/CS always have built-in defaults, so only terrestrial auto-scans.
      if (hydratedRef.current && !channelsFor(band).some((item) => scan[String(item)])) {
        addLog('No scan data — starting channel scan');
        await runScan(band, true);
        return;
      }
      const result = await session.receiver.tune(channel);
      if (!result.demodLocked) throw new Error('The channel could not be locked.');
      await session.startCapture();
      streamChannelRef.current = channel;
      setStatus('Discovering services');
      const found = await waitForServices(session);
      const next = pickService(channel, found, service);
      setService(next);
      addLog(`${found.length} service${found.length === 1 ? '' : 's'} found`);
      if (!session.deviceInfo.hasCardReader) {
        addLog('Use the device side with a card reader (Q: primary; MLT8: 5 tuners)', true);
        setStatus('Playback error: No card reader on this device side');
        return;
      }
      try {
        await openPlayback(next);
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

  const changeChannel = async (value: string | null, preferred: string | null = null) => {
    if (!value || busy) return;
    streamChannelRef.current = undefined;
    setChannel(value);
    setService(preferred);
    setPrograms(undefined);
    programKeyRef.current = undefined;
    const session = sessionRef.current;
    if (!session || !connected || busy) return;
    setBusy(true);
    try {
      stopPlayer();
      setStatus(`Switching to CH ${value}`);
      addLog(`Switching to CH ${value}`);
      await session.retune(value);
      streamChannelRef.current = value;
      setStatus('Discovering services');
      const found = await waitForServices(session);
      const next = pickService(value, found, preferred);
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

  // A guide row names both the TS and the service; only a TS change retunes.
  const selectStation = async (value: string, serviceId: number | null) => {
    if (busy) return;
    if (value !== channel) await changeChannel(value, serviceId != null ? String(serviceId) : null);
    else if (serviceId != null && String(serviceId) !== service)
      await changeService(String(serviceId));
  };

  const cancelScan = () => {
    if (!scanActiveRef.current || scanAbortRef.current) return;
    scanAbortRef.current = true;
    scanControllerRef.current?.abort();
    setScanCancelling(true);
    setStatus('Cancelling scan…');
  };

  // Scan a broadcast band (the tuned one by default), persisting station names for channel labels.
  // Works on the live session or connects first when disconnected.
  const runScan = async (scanBand: Broadcast = band, fromConnect = false) => {
    if (scanning || (busy && !fromConnect)) return;
    const scanChannelsForBand = channelsFor(scanBand);
    scanAbortRef.current = false;
    setScanCancelling(false);
    const controller = new AbortController();
    scanControllerRef.current = controller;
    scanActiveRef.current = true;
    setScanning(true);
    setBusy(true);
    setScanEvents([]);
    setPrograms(undefined);
    programKeyRef.current = undefined;
    setScanProgress({
      done: 0,
      total: scanChannelsForBand.length,
      channel: scanChannelsForBand[0],
    });
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
      const fallback = visibleChannels(results, scanBand).find(
        (item) => results[String(item)]?.locked,
      );
      const target =
        results[priorChannel]?.locked || !results[priorChannel]
          ? priorChannel
          : fallback != null
            ? String(fallback)
            : undefined;
      if (target == null) {
        setService(null);
        setStatus(owned ? 'No receivable channels found' : 'Ready');
        return;
      }
      streamChannelRef.current = undefined;
      setChannel(target);
      try {
        await session.retune(target);
        streamChannelRef.current = target;
        setStatus('Discovering services');
        const found = await waitForServices(session);
        const next = pickService(target, found, target === priorChannel ? service : null);
        setService(next);
        addLog(`${found.length} service${found.length === 1 ? '' : 's'} found on CH ${target}`);
        await openPlayback(next);
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
      if (controller.signal.aborted) throw new Error('Scan cancelled');
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
      if (controller.signal.aborted) throw new Error('Scan cancelled');
      streamChannelRef.current = undefined;
      setStatus(`Scanning channels (0/${scanChannelsForBand.length})`);
      await scanChannels(session, {
        channels: scanChannelsForBand,
        signal: controller.signal,
        isAborted: () => scanAbortRef.current,
        onPrograms: async (found, programs) => {
          const channelKey = String(found);
          const saved = await loadEpg(channelKey);
          const complete: Record<number, ProgramInfo> = Object.fromEntries(
            Object.entries(programs).map(([id, program]) => [
              id,
              {
                serviceId: Number(id),
                stationName: program.stationName ?? '',
                current: program.current ?? null,
                next: program.next ?? null,
                future: program.future ?? [],
              },
            ]),
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
      if (controller.signal.aborted) throw new Error('Scan cancelled');
      const locked = scanChannelsForBand.filter((item) => merged[String(item)]?.locked);
      addLog(`Scan complete: ${locked.length}/${scanChannelsForBand.length} channels receivable`);
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
      if (scanControllerRef.current === controller) scanControllerRef.current = null;
      scanActiveRef.current = false;
      setScanning(false);
      setScanCancelling(false);
      setBusy(false);
      setScanProgress(null);
    }
  };

  return {
    scan,
    channel,
    band,
    service,
    channelOptions,
    selectedValue: selectedOption?.value,
    selectedName,
    epgNow,
    epg: channelEpg[channel],
    logoFor,
    scanning,
    scanCancelling,
    scanProgress,
    scanEvents,
    transport,
    programs,
    stream,
    connected,
    deviceLabel,
    cardless,
    b25,
    epgCrawl,
    connect,
    selectStation,
    cancelScan,
    runScan,
  };
}
