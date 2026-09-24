import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { FullSegPlayer } from '../../media/player';
import { CaptionOverlay } from '../../media/captions';
import { isDocumentPipSupported, openPip, type PipHandle } from '../../media/pip';
import type { ReceiverSession } from '../../usb/receiver-session';
import { CAPTION_KEY, VOLUME_KEY, saveValue, settingsStore } from '../../storage';
import { DEFAULT_CAPTION_ENABLED, DEFAULT_VOLUME, loadCaptionEnabled, loadVolume } from '../format';

export type PlayerSnapshot = FullSegPlayer['snapshot'];

interface UsePlaybackOptions {
  sessionRef: RefObject<ReceiverSession | undefined>;
  addLog: (message: string, error?: boolean) => void;
  setStatus: (status: string) => void;
  setBusy: (busy: boolean) => void;
}

export function usePlayback({ sessionRef, addLog, setStatus, setBusy }: UsePlaybackOptions) {
  const [playback, setPlayback] = useState<PlayerSnapshot>();
  const [playing, setPlaying] = useState(false);
  const [videoVisible, setVideoVisible] = useState(false);
  const [captionEnabled, setCaptionEnabled] = useState(DEFAULT_CAPTION_ENABLED);
  const [pipEnabled, setPipEnabled] = useState(false);
  const [pipControlsHost, setPipControlsHost] = useState<HTMLElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [volume, setVolumeState] = useState(DEFAULT_VOLUME);
  const [controlsIdle, setControlsIdle] = useState(false);
  const idleTimerRef = useRef<number | undefined>(undefined);
  const playerRef = useRef<FullSegPlayer | undefined>(undefined);
  const recoveryUsedRef = useRef(false);
  const playbackErrorRef = useRef<string | undefined>(undefined);
  // Set when playback gives up; the session hook reacts by closing the device.
  const [failure, setFailure] = useState<string>();
  const captionRef = useRef<CaptionOverlay | undefined>(undefined);
  const captionEnabledRef = useRef(captionEnabled);
  const videoWrapRef = useRef<HTMLDivElement>(null);
  const videoPaperRef = useRef<HTMLDivElement>(null);
  const pipHandleRef = useRef<PipHandle | undefined>(undefined);
  const volumeRef = useRef(volume);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ambientCanvasRef = useRef<HTMLCanvasElement>(null);
  const hydratedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [caption, level] = await Promise.all([loadCaptionEnabled(), loadVolume()]);
      if (cancelled) return;
      setCaptionEnabled(caption);
      setVolumeState(level);
      volumeRef.current = level;
      hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const pipSupported = isDocumentPipSupported();

  const closePip = useCallback(() => {
    setPipControlsHost(null);
    pipHandleRef.current?.close();
    pipHandleRef.current = undefined;
    setPipEnabled(false);
  }, []);

  // A channel switch passes keepPip so the PiP window stays open for the next player.
  const stopPlayer = useCallback(
    (message?: string, keepPip = false) => {
      if (!keepPip) closePip();
      captionRef.current?.destroy();
      captionRef.current = undefined;
      playerRef.current?.close();
      playerRef.current = undefined;
      playbackErrorRef.current = undefined;
      setFailure(undefined);
      const session = sessionRef.current;
      if (session?.b25) {
        session.b25.onOutput = undefined;
        void session.b25.request('playback', { enabled: false }).catch(() => {});
      }
      setVideoVisible(false);
      setPlaying(false);
      setPlayback(undefined);
      if (message) addLog(message);
    },
    [addLog, closePip, sessionRef],
  );

  // Wire a player (new, or a preview already decoding) to the session's B25 output.
  const attachPlayer = useCallback(
    async (player: FullSegPlayer, serviceId: string) => {
      const session = sessionRef.current;
      if (!session?.b25 || !canvasRef.current) throw new Error('Playback is unavailable');
      player.setCanvas(canvasRef.current);
      player.setVolume(volumeRef.current);
      playerRef.current = player;
      player.onCaption = (packet) => {
        captionRef.current?.push(packet.kind, packet.bytes, packet.pts / 90000, packet.dts / 90000);
      };
      player.onCaptionReset = () => captionRef.current?.reset();
      if (videoWrapRef.current) {
        captionRef.current?.destroy();
        const overlay = new CaptionOverlay(
          videoWrapRef.current,
          () => playerRef.current?.clockSeconds,
        );
        overlay.setEnabled(captionEnabledRef.current);
        captionRef.current = overlay;
      }
      session.b25.onOutput = (bytes) => {
        void player.push(bytes).catch((error) => {
          if (playerRef.current === player)
            playbackErrorRef.current ??= error instanceof Error ? error.message : String(error);
        });
      };
      await session.b25.request('playback', { enabled: true });
      setPlaying(true);
      setStatus('Playing');
      addLog(`Playback started for service ${serviceId}`);
    },
    [addLog, sessionRef, setStatus],
  );

  const openPlayback = useCallback(
    async (serviceId: string, recovering = false) => {
      const session = sessionRef.current;
      if (!session || !canvasRef.current) throw new Error('Playback is unavailable');
      setStatus('Initializing B-CAS');
      if (!recovering) recoveryUsedRef.current = false;
      try {
        await session.startB25(Number(serviceId), true);
      } catch (error) {
        if (!session.b25Error || recoveryUsedRef.current) throw error;
        recoveryUsedRef.current = true;
        addLog(`Restarting B25: ${session.b25Error}`);
        await session.startB25(Number(serviceId), true);
      }
      const player = new FullSegPlayer(canvasRef.current);
      playerRef.current = player;
      player.onFirstFrame = () => {
        if (playerRef.current === player) setVideoVisible(true);
      };
      await player.open(Number(serviceId));
      await attachPlayer(player, serviceId);
    },
    [addLog, sessionRef, setStatus, attachPlayer],
  );

  /** Promote a preview player whose B25 filter the session has adopted; it keeps its decoder state. */
  const adoptPlayer = useCallback(
    async (player: FullSegPlayer, serviceId: string) => {
      recoveryUsedRef.current = false;
      if (player.rendered) setVideoVisible(true);
      else
        player.onFirstFrame = () => {
          if (playerRef.current === player) setVideoVisible(true);
        };
      await attachPlayer(player, serviceId);
    },
    [attachPlayer],
  );

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const session = sessionRef.current;
      if (!playerRef.current || !session) return;
      const error = session.streamError || session.b25Error || playbackErrorRef.current;
      if (!error) return;
      stopPlayer(undefined, true);
      if (session.streamError || recoveryUsedRef.current || !session.b25ServiceId) {
        setFailure(error);
        return;
      }
      recoveryUsedRef.current = true;
      addLog(`Restarting B25: ${error}`);
      setBusy(true);
      void openPlayback(String(session.b25ServiceId), true)
        .catch((failure) => {
          stopPlayer();
          setFailure(failure instanceof Error ? failure.message : String(failure));
        })
        .finally(() => setBusy(false));
    }, 500);
    return () => window.clearInterval(timer);
  }, [playing, sessionRef, stopPlayer, openPlayback, addLog, setStatus, setBusy]);

  const togglePip = async (on: boolean) => {
    if (on) {
      const node = videoWrapRef.current;
      if (!node || pipHandleRef.current || !playing) return;
      try {
        const handle = await openPip(node, {
          onClose: () => {
            pipHandleRef.current = undefined;
            setPipControlsHost(null);
            setPipEnabled(false);
          },
        });
        pipHandleRef.current = handle;
        setPipControlsHost(handle.controlsHost);
        setPipEnabled(true);
      } catch (error) {
        addLog(error instanceof Error ? error.message : String(error), true);
        setPipEnabled(false);
      }
    } else {
      closePip();
    }
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        if (pipHandleRef.current) closePip();
        await videoPaperRef.current?.requestFullscreen();
      }
    } catch (error) {
      addLog(error instanceof Error ? error.message : String(error), true);
    }
  };

  const setVolume = useCallback((next: number) => {
    const clamped = Math.min(1, Math.max(0, next));
    volumeRef.current = clamped;
    setVolumeState(clamped);
    playerRef.current?.setVolume(clamped);
  }, []);

  /** Snapshot the player for the polling loop owned by the session hook. */
  const refreshPlayback = useCallback(() => {
    if (playerRef.current) setPlayback({ ...playerRef.current.snapshot });
  }, []);

  useEffect(() => {
    captionEnabledRef.current = captionEnabled;
    captionRef.current?.setEnabled(captionEnabled);
    if (!hydratedRef.current) return;
    void saveValue(CAPTION_KEY, captionEnabled, settingsStore);
  }, [captionEnabled]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    void saveValue(VOLUME_KEY, volume, settingsStore);
  }, [volume]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!playing) {
      window.clearTimeout(idleTimerRef.current);
      setControlsIdle(false);
      return;
    }
    const poke = () => {
      setControlsIdle(false);
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => setControlsIdle(true), 3000);
    };
    poke();
    const node = videoPaperRef.current;
    const activity = ['mousemove', 'mousedown', 'touchstart', 'wheel'];
    for (const type of activity) node?.addEventListener(type, poke, { passive: true });
    window.addEventListener('keydown', poke);
    const onLeave = () => {
      window.clearTimeout(idleTimerRef.current);
      setControlsIdle(false);
    };
    node?.addEventListener('mouseleave', onLeave);
    return () => {
      window.clearTimeout(idleTimerRef.current);
      for (const type of activity) node?.removeEventListener(type, poke);
      window.removeEventListener('keydown', poke);
      node?.removeEventListener('mouseleave', onLeave);
    };
  }, [playing]);

  // Glow only with a rendered video frame. Off for No signal, PiP and fullscreen.
  const ambientVisible = videoVisible && !pipEnabled && !isFullscreen;

  // Scope-style ambient: copy the main canvas to the backdrop 2D canvas every frame. Blur is CSS-only.
  useEffect(() => {
    const source = canvasRef.current;
    const ambient = ambientCanvasRef.current;
    if (!ambient) return;
    const context = ambient.getContext('2d');
    if (!context) return;
    if (!ambientVisible || !source) return;
    let frameId = 0;
    const win = ambient.ownerDocument.defaultView ?? window;
    const copyFrame = () => {
      frameId = win.requestAnimationFrame(copyFrame);
      if (source.width === 0 || source.height === 0) return;
      const nextWidth = Math.max(1, Math.round(source.width * 0.25));
      const nextHeight = Math.max(1, Math.round(source.height * 0.25));
      if (ambient.width !== nextWidth) ambient.width = nextWidth;
      if (ambient.height !== nextHeight) ambient.height = nextHeight;
      try {
        context.drawImage(source, 0, 0, nextWidth, nextHeight);
      } catch {
        // The canvas can briefly be unavailable (e.g. while moving to PiP). Retry next frame.
      }
    };
    frameId = win.requestAnimationFrame(copyFrame);
    return () => {
      win.cancelAnimationFrame(frameId);
    };
  }, [ambientVisible]);

  return {
    playback,
    playing,
    failure,
    videoVisible,
    captionEnabled,
    setCaptionEnabled,
    pipEnabled,
    pipControlsHost,
    pipSupported,
    isFullscreen,
    volume,
    setVolume,
    controlsIdle,
    ambientVisible,
    canvasRef,
    ambientCanvasRef,
    videoWrapRef,
    videoPaperRef,
    closePip,
    stopPlayer,
    openPlayback,
    adoptPlayer,
    togglePip,
    toggleFullscreen,
    refreshPlayback,
  };
}
