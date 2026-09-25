import type { RefObject } from 'react';
import { ActionIcon, Box, Group, Paper, Progress, Slider, Text } from '@mantine/core';
import { DataRemote } from './DataRemote';
import {
  DataButtonIcon,
  GuideButtonIcon,
  MaximizeButtonIcon,
  MinimizeButtonIcon,
  PipButtonIcon,
  SubtitlesButtonIcon,
} from '../icons';

interface VideoStageProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  ambientCanvasRef: RefObject<HTMLCanvasElement | null>;
  videoWrapRef: RefObject<HTMLDivElement | null>;
  videoPaperRef: RefObject<HTMLDivElement | null>;
  bmlHostRef: RefObject<HTMLDivElement | null>;
  ambientVisible: boolean;
  playing: boolean;
  stationName: string;
  programName: string;
  videoVisible: boolean;
  busy: boolean;
  pipEnabled: boolean;
  pipSupported: boolean;
  isFullscreen: boolean;
  guideOpen: boolean;
  captionEnabled: boolean;
  dataVisible: boolean;
  dataLoading: boolean;
  controlsIdle: boolean;
  volume: number;
  onToggleCaption: () => void;
  onPressData: () => void;
  onDataKey: (key: number, down: boolean) => void;
  readZipCode: () => string;
  writeZipCode: (zipCode: string) => void;
  onTogglePip: () => void;
  onToggleFullscreen: () => void;
  onVolumeChange: (volume: number) => void;
  /** Set only in fullscreen, where the page's channel guide is out of sight. */
  onToggleGuide?: () => void;
}

export function VideoStage({
  canvasRef,
  ambientCanvasRef,
  videoWrapRef,
  videoPaperRef,
  bmlHostRef,
  ambientVisible,
  playing,
  stationName,
  programName,
  videoVisible,
  busy,
  pipEnabled,
  pipSupported,
  isFullscreen,
  guideOpen,
  captionEnabled,
  dataVisible,
  dataLoading,
  controlsIdle,
  volume,
  onToggleCaption,
  onPressData,
  onDataKey,
  readZipCode,
  writeZipCode,
  onTogglePip,
  onToggleFullscreen,
  onVolumeChange,
  onToggleGuide,
}: VideoStageProps) {
  return (
    <Box className="television-ambient-wrap">
      <canvas
        aria-hidden="true"
        ref={ambientCanvasRef}
        className={`television-ambient-canvas${ambientVisible ? ' television-ambient-canvas-visible' : ''}`}
      />
      <Paper
        ref={videoPaperRef}
        bg="dark.9"
        className={`television-paper${controlsIdle && playing ? ' is-idle' : ''}`}
        style={{
          aspectRatio: '16 / 9',
          overflow: 'hidden',
          position: 'relative',
          cursor: controlsIdle && playing ? 'none' : 'default',
        }}
      >
        {busy && (
          <Progress
            color="gray"
            value={100}
            striped
            animated
            size={4}
            radius={0}
            aria-label="Loading"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              zIndex: 5,
            }}
          />
        )}
        <div ref={videoWrapRef} style={{ position: 'absolute', inset: 0 }}>
          <canvas
            ref={canvasRef}
            className={`television-canvas${videoVisible ? ' television-canvas-visible' : ''}`}
            width={960}
            height={540}
            aria-label="Television playback"
          />
          <div ref={bmlHostRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
        </div>
        {pipEnabled && playing && (
          <div
            role="img"
            aria-label="Playing in picture-in-picture"
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              color: 'var(--mantine-color-blue-4)',
              lineHeight: 0,
              pointerEvents: 'none',
            }}
          >
            <PipButtonIcon size={64} />
          </div>
        )}
        {playing && (
          <>
            <div
              className="video-controls"
              aria-hidden
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: 96,
                background: 'linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent)',
                pointerEvents: 'none',
                zIndex: 2,
              }}
            />
            <Group
              gap={4}
              className="video-controls"
              style={{
                position: 'absolute',
                left: 8,
                bottom: 8,
                zIndex: 3,
              }}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <ActionIcon
                variant="transparent"
                color={captionEnabled ? 'blue' : 'white'}
                size="lg"
                aria-label="Subtitles"
                aria-pressed={captionEnabled}
                title="Subtitles"
                onClick={onToggleCaption}
              >
                <SubtitlesButtonIcon />
              </ActionIcon>
              <ActionIcon
                variant="transparent"
                color={dataVisible ? 'blue' : 'white'}
                size="lg"
                aria-label="Data broadcasting (d)"
                aria-pressed={dataVisible}
                title="Data broadcasting (d)"
                disabled={pipEnabled}
                loading={dataLoading}
                loaderProps={{ color: 'white', size: 18 }}
                // Mantine tints the loader's backdrop, which shows as a box on the bare icon.
                styles={{ loader: { backgroundColor: 'transparent' } }}
                onClick={onPressData}
              >
                <DataButtonIcon />
              </ActionIcon>
              <ActionIcon
                variant="transparent"
                color={pipEnabled ? 'blue' : 'white'}
                size="lg"
                aria-label={pipEnabled ? 'Exit picture-in-picture' : 'Show picture-in-picture'}
                aria-pressed={pipEnabled}
                title={
                  pipSupported
                    ? pipEnabled
                      ? 'Exit picture-in-picture'
                      : 'Show picture-in-picture'
                    : 'This browser does not support Document PiP'
                }
                disabled={!pipSupported}
                onClick={() => void onTogglePip()}
              >
                <PipButtonIcon />
              </ActionIcon>
              {onToggleGuide && (
                <ActionIcon
                  variant="transparent"
                  color={guideOpen ? 'blue' : 'white'}
                  size="lg"
                  aria-label="Channel guide"
                  aria-pressed={guideOpen}
                  title="Channel guide"
                  onClick={onToggleGuide}
                >
                  <GuideButtonIcon />
                </ActionIcon>
              )}
              <ActionIcon
                variant="transparent"
                color={isFullscreen ? 'blue' : 'white'}
                size="lg"
                aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
                aria-pressed={isFullscreen}
                title={isFullscreen ? 'Exit full screen' : 'Full screen'}
                onClick={() => void onToggleFullscreen()}
              >
                {isFullscreen ? <MinimizeButtonIcon /> : <MaximizeButtonIcon />}
              </ActionIcon>
              <Slider
                value={Math.round(volume * 100)}
                onChange={(next) => onVolumeChange(next / 100)}
                min={0}
                max={100}
                step={1}
                aria-label="Volume"
                w={120}
                ml={4}
                size="sm"
                color="white"
              />
            </Group>
            {dataVisible && !pipEnabled && (
              <DataRemote onKey={onDataKey} readZipCode={readZipCode} writeZipCode={writeZipCode} />
            )}
            {(stationName || programName) && (
              <div
                className="video-controls video-program-info"
                aria-label="Current station and program"
              >
                {stationName && (
                  <Text size="sm" fw={700}>
                    {stationName}
                  </Text>
                )}
                {programName && <Text size="sm">{programName}</Text>}
              </div>
            )}
          </>
        )}
      </Paper>
    </Box>
  );
}
