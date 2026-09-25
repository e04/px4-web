import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Alert, Anchor, Box, Button, Container, Grid, Group, Stack, Text } from '@mantine/core';
import { ReceiverSession } from '../usb/receiver-session';
import { usePlayback } from './hooks/usePlayback';
import { useReceiverSession } from './hooks/useReceiverSession';
import { ScanModal } from './components/ScanModal';
import { VideoStage } from './components/VideoStage';
import { PipControls } from './components/PipControls';
import { ChannelGuide } from './components/ChannelGuide';
import { GuideOverlay } from './components/GuideOverlay';
import { LOG_HEIGHT, LogPanel, MetricsGrid, ProgramInfo } from './components/Diagnostics';
import type { Broadcast } from '../channels';
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
    adoptPlayer: playback.adoptPlayer,
    refreshPlayback: playback.refreshPlayback,
    playbackFailure: playback.failure,
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

  // In fullscreen and PiP the page is out of sight, so the guide opens over the video.
  const guideHost = playback.isFullscreen
    ? playback.videoPaperRef.current
    : playback.pipControlsHost;
  const [guideOpen, setGuideOpen] = useState(false);
  const toggleGuide = useCallback(() => setGuideOpen((open) => !open), []);
  const closeGuide = useCallback(() => setGuideOpen(false), []);
  useEffect(() => {
    if (!guideHost) setGuideOpen(false);
  }, [guideHost]);
  const guideProps = {
    band: session.band,
    selected: session.selectedValue,
    service: session.service,
    channelOptions: session.channelOptions,
    now: session.epgNow,
    busy,
    scanning: session.scanning,
    onScan: (band: Broadcast) => void session.runScan(band),
    previewAvailable: session.previewAvailable,
    previewState: session.previewState,
    previewCanvas: session.previewCanvas,
    onPreview: session.setPreviewTarget,
  };

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
              <Group gap="md" wrap="nowrap">
                <Box flex={1} miw={0}>
                  <LogPanel logs={logs} />
                </Box>
                {!session.connected && !session.scanning && (
                  <Button
                    h={LOG_HEIGHT}
                    color="dark"
                    variant="white"
                    disabled={!supported || busy}
                    loading={busy}
                    onClick={() => void session.connect()}
                  >
                    Connect
                  </Button>
                )}
              </Group>
              <VideoStage
                canvasRef={playback.canvasRef}
                ambientCanvasRef={playback.ambientCanvasRef}
                videoWrapRef={playback.videoWrapRef}
                videoPaperRef={playback.videoPaperRef}
                bmlHostRef={playback.bmlHostRef}
                ambientVisible={playback.ambientVisible}
                playing={playback.playing}
                stationName={selectedProgram?.stationName ?? ''}
                programName={currentProgram?.title ?? ''}
                videoVisible={playback.videoVisible}
                busy={busy}
                pipEnabled={playback.pipEnabled}
                pipSupported={playback.pipSupported}
                isFullscreen={playback.isFullscreen}
                guideOpen={guideOpen}
                captionEnabled={playback.captionEnabled}
                dataVisible={playback.dataVisible}
                dataLoading={playback.dataLoading}
                controlsIdle={playback.controlsIdle}
                volume={playback.volume}
                onToggleCaption={() => playback.setCaptionEnabled((current) => !current)}
                onPressData={playback.pressData}
                onDataKey={playback.pressDataKey}
                readZipCode={playback.readZipCode}
                writeZipCode={playback.writeZipCode}
                onTogglePip={() => void playback.togglePip(!playback.pipEnabled)}
                onToggleFullscreen={() => void playback.toggleFullscreen()}
                onVolumeChange={playback.setVolume}
                onToggleGuide={playback.isFullscreen ? toggleGuide : undefined}
              />
              {playback.pipControlsHost &&
                createPortal(
                  <PipControls
                    captionEnabled={playback.captionEnabled}
                    guideOpen={guideOpen}
                    volume={playback.volume}
                    stationName={selectedProgram?.stationName ?? ''}
                    programName={currentProgram?.title ?? ''}
                    onToggleCaption={() => playback.setCaptionEnabled((current) => !current)}
                    onExitPip={playback.closePip}
                    onVolumeChange={playback.setVolume}
                    onToggleGuide={toggleGuide}
                  />,
                  playback.pipControlsHost,
                )}
              <ProgramInfo
                service={session.service}
                programs={session.programs}
                current={currentProgram}
                logo={session.logoFor(session.channel, session.service)}
              />
              {guideOpen && guideHost && (
                <GuideOverlay host={guideHost} onClose={closeGuide}>
                  {(portalTarget) => (
                    <ChannelGuide
                      {...guideProps}
                      fill
                      portalTarget={portalTarget}
                      // The PiP window is too small to fit a station preview.
                      previewAvailable={guideProps.previewAvailable && !playback.pipEnabled}
                      onSelect={(channel, serviceId) => {
                        closeGuide();
                        void session.selectStation(channel, serviceId);
                      }}
                    />
                  )}
                </GuideOverlay>
              )}
              <ChannelGuide
                {...guideProps}
                onSelect={(channel, serviceId) => {
                  // Bring the video back into view; the guide sits below it.
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                  void session.selectStation(channel, serviceId);
                }}
              />
              <MetricsGrid
                transport={session.transport}
                playback={playback.playback}
                deviceLabel={session.deviceLabel}
                cardless={session.cardless}
                b25={session.b25}
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
          <Anchor size="10px" c="dimmed" href="./bml-licenses/NOTICE.md">
            web-bml license
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
