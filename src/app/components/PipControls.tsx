import { ActionIcon, Group, Slider, Text } from '@mantine/core';
import { GuideButtonIcon, SubtitlesButtonIcon } from '../icons';

interface PipControlsProps {
  captionEnabled: boolean;
  volume: number;
  stationName: string;
  programName: string;
  onToggleCaption: () => void;
  onVolumeChange: (volume: number) => void;
  onToggleGuide: () => void;
}

export function PipControls({
  captionEnabled,
  volume,
  stationName,
  programName,
  onToggleCaption,
  onVolumeChange,
  onToggleGuide,
}: PipControlsProps) {
  return (
    <>
      <div className="video-controls pip-controls-gradient" aria-hidden />
      <Group
        gap={4}
        className="video-controls pip-controls-actions"
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
          aria-label="Channel guide"
          title="Channel guide"
          onClick={onToggleGuide}
        >
          <GuideButtonIcon />
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
        <div className="video-controls pip-program-info" aria-label="Current station and program">
          {stationName && (
            <Text size="sm" fw={700}>
              {stationName}
            </Text>
          )}
          {programName && <Text size="sm">{programName}</Text>}
        </div>
      )}
    </>
  );
}
