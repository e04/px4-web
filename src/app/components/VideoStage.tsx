import type { RefObject } from 'react';
import { ActionIcon, Box, Group, Paper, Progress, Slider, Text } from '@mantine/core';
import {
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
  ambientVisible: boolean;
  playing: boolean;
  stationName: string;
  programName: string;
  videoVisible: boolean;
  busy: boolean;
  pipEnabled: boolean;
  pipSupported: boolean;
  isFullscreen: boolean;
  captionEnabled: boolean;
  controlsIdle: boolean;
  volume: number;
  onToggleCaption: () => void;
  onTogglePip: () => void;
  onToggleFullscreen: () => void;
  onVolumeChange: (volume: number) => void;
  onExitPip: () => void;
  /** Set only in fullscreen, where the page's channel guide is out of sight. */
  onToggleGuide?: () => void;
}

export function VideoStage({
  canvasRef,
  ambientCanvasRef,
  videoWrapRef,
  videoPaperRef,
  ambientVisible,
  playing,
  stationName,
  programName,
  videoVisible,
  busy,
  pipEnabled,
  pipSupported,
  isFullscreen,
  captionEnabled,
  controlsIdle,
  volume,
  onToggleCaption,
  onTogglePip,
  onToggleFullscreen,
  onVolumeChange,
  onExitPip,
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
        onClick={() => {
          if (pipEnabled) onExitPip();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (pipEnabled) onExitPip();
          }
        }}
        role={pipEnabled ? 'button' : undefined}
        tabIndex={pipEnabled ? 0 : -1}
        aria-pressed={pipEnabled}
        aria-label={pipEnabled ? 'Exit picture-in-picture' : 'Video'}
        title={pipEnabled ? 'Click to exit picture-in-picture' : undefined}
        style={{
          aspectRatio: '16 / 9',
          overflow: 'hidden',
          position: 'relative',
          cursor: controlsIdle && playing ? 'none' : pipEnabled ? 'pointer' : 'default',
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
        </div>
        {pipEnabled && playing && (
          <Text
            c="white"
            pos="absolute"
            top="50%"
            left="50%"
            style={{ transform: 'translate(-50%, -50%)' }}
          >
            Showing in PiP
          </Text>
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
                color="white"
                size="lg"
                aria-label="Subtitles"
                aria-pressed={captionEnabled}
                title="Subtitles"
                style={{ opacity: captionEnabled ? 1 : 0.45 }}
                onClick={onToggleCaption}
              >
                <SubtitlesButtonIcon />
              </ActionIcon>
              <ActionIcon
                variant="transparent"
                color="white"
                size="lg"
                aria-label={pipEnabled ? 'Exit picture-in-picture' : 'Show picture-in-picture'}
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
                  color="white"
                  size="lg"
                  aria-label="Channel guide"
                  title="Channel guide"
                  onClick={onToggleGuide}
                >
                  <GuideButtonIcon />
                </ActionIcon>
              )}
              <ActionIcon
                variant="transparent"
                color="white"
                size="lg"
                aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
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
