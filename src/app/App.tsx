import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Alert, Anchor, Container, Grid, Group, Stack, Text } from '@mantine/core';
import { ReceiverSession } from '../usb/receiver-session';
import { usePlayback } from './hooks/usePlayback';
import { useReceiverSession } from './hooks/useReceiverSession';
import { TunerBar } from './components/TunerBar';
import { ScanModal } from './components/ScanModal';
import { VideoStage } from './components/VideoStage';
import { PipControls } from './components/PipControls';
import { LogPanel, MetricsGrid, ProgramInfo } from './components/Diagnostics';
import { currentServiceProgram } from '../epg';

export default function App() {
  // Shared UI state owned here; domain state lives in the hooks below.
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState('Disconnected');
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef<ReceiverSession | undefined>(undefined);
  const supported = window.isSecureContext && 'usb' in navigator;

  const addLog = useCallback((message: string, error = false) => {
    const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setLogs((current) => [
      ...current.slice(-199),
      `${error ? '[ERROR] ' : ''}[${timestamp}]  ${message}`,
    ]);
  }, []);

  const playback = usePlayback({ sessionRef, addLog, setStatus, setBusy });
  const session = useReceiverSession({
    sessionRef,
    busy,
    setBusy,
    setStatus,
    addLog,
    stopPlayer: playback.stopPlayer,
    openPlayback: playback.openPlayback,
    refreshPlayback: playback.refreshPlayback,
  });
  const selectedProgram = session.service ? session.programs?.[Number(session.service)] : undefined;
  const currentProgram = session.service
    ? currentServiceProgram(
        selectedProgram?.current,
        session.epg,
        Number(session.service),
        session.epgNow,
      )
    : null;
  useEffect(() => {
    const stationName = selectedProgram?.stationName ?? '';
    const programTitle = currentProgram?.title ?? '';
    document.title = [stationName, programTitle].filter(Boolean).join(' ') || 'px4-web';
  }, [selectedProgram?.stationName, currentProgram?.title]);
  return (
    <Container fluid mih="100dvh" px={{ base: 'xs', sm: 'md' }} py="sm">
      <Stack maw={1440} mih="calc(100dvh - var(--mantine-spacing-md))" mx="auto" gap="xs">
        {!supported && (
          <Alert title="WebUSB unavailable">Use Chrome over HTTPS or localhost.</Alert>
        )}
        <TunerBar
          band={session.band}
          onBand={session.changeBand}
          channel={session.channel}
          channelOptions={session.channelOptions}
          now={session.epgNow}
          service={session.service}
          services={session.services}
          programs={session.programs}
          busy={busy}
          connected={session.connected}
          scanning={session.scanning}
          supported={supported}
          onChannel={(value) => void session.changeChannel(value)}
          onService={(value) => void session.changeService(value)}
          onConnect={() => void session.connect()}
          onScan={() => void session.runScan()}
        />
        <ScanModal
          scanning={session.scanning}
          cancelling={session.scanCancelling}
          scanProgress={session.scanProgress}
          scanEvents={session.scanEvents}
          onCancel={session.cancelScan}
        />
        <Grid gutter="xs">
          <Grid.Col span={12}>
            <Stack gap="xs">
              <LogPanel logs={logs} />
              <VideoStage
                canvasRef={playback.canvasRef}
                ambientCanvasRef={playback.ambientCanvasRef}
                videoWrapRef={playback.videoWrapRef}
                videoPaperRef={playback.videoPaperRef}
                ambientVisible={playback.ambientVisible}
                playing={playback.playing}
                stationName={selectedProgram?.stationName ?? ''}
                programName={currentProgram?.title ?? ''}
                videoVisible={playback.videoVisible}
                busy={busy}
                pipEnabled={playback.pipEnabled}
                pipSupported={playback.pipSupported}
                isFullscreen={playback.isFullscreen}
                captionEnabled={playback.captionEnabled}
                controlsIdle={playback.controlsIdle}
                volume={playback.volume}
                onToggleCaption={() => playback.setCaptionEnabled((current) => !current)}
                onTogglePip={() => void playback.togglePip(!playback.pipEnabled)}
                onToggleFullscreen={() => void playback.toggleFullscreen()}
                onVolumeChange={playback.setVolume}
                onExitPip={() => playback.closePip()}
              />
              {playback.pipControlsHost &&
                createPortal(
                  <PipControls
                    captionEnabled={playback.captionEnabled}
                    volume={playback.volume}
                    stationName={selectedProgram?.stationName ?? ''}
                    programName={currentProgram?.title ?? ''}
                    onToggleCaption={() => playback.setCaptionEnabled((current) => !current)}
                    onVolumeChange={playback.setVolume}
                  />,
                  playback.pipControlsHost,
                )}
              <ProgramInfo
                service={session.service}
                programs={session.programs}
                epg={session.epg}
                current={currentProgram}
                now={session.epgNow}
              />
              <MetricsGrid
                stream={session.stream}
                transport={session.transport}
                playback={playback.playback}
                deviceLabel={session.deviceLabel}
                cardless={session.cardless}
                b25={session.b25}
                epgCrawl={session.epgCrawl}
                status={status}
              />
            </Stack>
          </Grid.Col>
        </Grid>
        <Group justify="flex-end" gap="xs" pb="xs">
          <Anchor size="10px" c="dimmed" href="./b25-licenses/LICENSE">
            libarib25 license
          </Anchor>
          <Text size="10px" c="dimmed">
            ·
          </Text>
          <Anchor size="10px" c="dimmed" href="./media-licenses/LICENSE.md">
            FFmpeg license
          </Anchor>
          <Text size="10px" c="dimmed">
            ·
          </Text>
          <Anchor
            size="10px"
            c="dimmed"
            href="https://github.com/tsukumijima/px4_drv"
            target="_blank"
            rel="noreferrer"
          >
            Ported from px4_drv
          </Anchor>
        </Group>
      </Stack>
    </Container>
  );
}
