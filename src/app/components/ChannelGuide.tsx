import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Group,
  Loader,
  Paper,
  Popover,
  SegmentedControl,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import type { Broadcast } from '../../channels';
import { stationTimeline, type TimelineItem } from '../../epg';
import type { ChannelOption, PreviewState, PreviewTarget } from '../hooks/useReceiverSession';
import { TimelineHours, TimelineTrack, timelineStart } from './ProgramTimeline';

const STATION_WIDTH = 220;
const ROW_HEIGHT = 84;
const ROW_GAP = 4;
// Rows touch and overlap by the 1px program border so it is not drawn twice.
const ROW_OVERLAP = -1;
const HOURS_HEIGHT = 13;
const HOUR_WIDTH = 200;
// Only programs near the viewport are rendered; the window moves in these steps
// so scrolling re-renders rarely.
const CULL_STEP = 512;

const PREVIEW_WIDTH = 384;
const PREVIEW_OPEN_DELAY = 400;
// The tuner outlives the popup this long, so re-entering the row (or crossing
// the gap between the columns) shows the same preview again without retuning.
const PREVIEW_RELEASE_DELAY = 300;

const NO_EVENTS: TimelineItem[] = [];

const BANDS: { value: Broadcast; label: string }[] = [
  { value: 'T', label: '地デジ' },
  { value: 'BS', label: 'BS' },
  { value: 'CS', label: '110°CS' },
];

interface ChannelGuideProps {
  band: Broadcast;
  selected: string | undefined;
  service: string | null;
  channelOptions: ChannelOption[];
  now: number;
  busy: boolean;
  scanning: boolean;
  previewAvailable: boolean;
  previewState: PreviewState;
  previewCanvas: HTMLCanvasElement;
  onSelect: (channel: string, serviceId: number | null) => void;
  onScan: (band: Broadcast) => void;
  onPreview: (target: PreviewTarget | null) => void;
}

function StationPreview({ canvas, state }: { canvas: HTMLCanvasElement; state: PreviewState }) {
  return (
    <Box
      pos="relative"
      w={PREVIEW_WIDTH}
      bg="black"
      style={{ aspectRatio: '16 / 9', overflow: 'hidden' }}
      aria-label="Station preview"
    >
      <Box
        w="100%"
        h="100%"
        className="station-preview-canvas"
        style={{ visibility: state === 'playing' ? undefined : 'hidden' }}
        ref={(node: HTMLDivElement | null) => {
          if (node && canvas.parentNode !== node) node.appendChild(canvas);
        }}
      />
      {state !== 'playing' && (
        <Group pos="absolute" inset={0} justify="center">
          {state === 'tuning' ? (
            <Loader size="sm" color="gray" />
          ) : (
            <Text size="xs" c="dimmed">
              Preview unavailable
            </Text>
          )}
        </Group>
      )}
    </Box>
  );
}

export function ChannelGuide({
  band,
  selected: selectedValue,
  service,
  channelOptions,
  now,
  busy,
  scanning,
  previewAvailable,
  previewState,
  previewCanvas,
  onSelect,
  onScan,
  onPreview,
}: ChannelGuideProps) {
  // Browsing another band only changes the list; tuning waits for a station click.
  const [viewBand, setViewBand] = useState(band);
  useEffect(() => setViewBand(band), [band]);
  const firstHour = timelineStart(now);
  const rows = useMemo(
    () =>
      channelOptions
        .filter((option) => option.band === viewBand)
        .map((option) => ({
          option,
          events: stationTimeline(option.schedules, now, firstHour, HOUR_WIDTH),
        })),
    [channelOptions, viewBand, now, firstHour],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const [cullX, setCullX] = useState(0);
  const [cullY, setCullY] = useState(0);
  const rangeX = [(cullX - 1) * CULL_STEP, (cullX + 2) * CULL_STEP + window.innerWidth] as const;
  const rangeY = [(cullY - 1) * CULL_STEP, (cullY + 2) * CULL_STEP + window.innerHeight];

  // Keep the tuned station in view without scrolling the page itself.
  useEffect(() => {
    const list = listRef.current;
    const row = selectedRef.current;
    if (!list || !row) return;
    const top = row.offsetTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = top - (list.clientHeight - row.offsetHeight) / 2;
  }, [selectedValue, viewBand]);

  // Hovering a station or its timeline previews it; the popup opens after a pause
  // so sweeping across rows does not retune the free tuner for each one.
  const [hovered, setHovered] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setPreviewed(hovered),
      hovered ? PREVIEW_OPEN_DELAY : PREVIEW_RELEASE_DELAY,
    );
    return () => window.clearTimeout(timer);
  }, [hovered]);
  // The tuned station is already on screen; unscanned ones have no service.
  const previewOption = rows.find(
    ({ option }) =>
      option.value === previewed && option.value !== selectedValue && option.serviceId != null,
  )?.option;
  const previewValue = previewAvailable && !busy ? previewOption?.value : undefined;
  useEffect(() => {
    onPreview(
      previewValue && previewOption?.serviceId != null
        ? {
            value: previewValue,
            channel: previewOption.channel,
            serviceId: previewOption.serviceId,
          }
        : null,
    );
    // The target is keyed by row value; the option object is rebuilt on every EPG update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewValue]);
  const hover = (value: string) => ({
    onMouseEnter: () => setHovered(value),
    onMouseLeave: () => setHovered((current) => (current === value ? null : current)),
  });

  const select = (option: ChannelOption, serviceId = option.serviceId) => {
    if (option.value !== selectedValue || String(serviceId) !== service)
      onSelect(option.channel, serviceId);
  };

  return (
    <Paper bg="dark.9" py="md" aria-label="Program guide">
      <Group justify="space-between" px="md" mb="sm">
        <SegmentedControl
          aria-label="Broadcast"
          size="xs"
          fullWidth
          w={210}
          data={BANDS}
          value={viewBand}
          onChange={(value) => setViewBand(value as Broadcast)}
        />
        <Button
          size="xs"
          color="dark"
          variant="white"
          disabled={busy || scanning}
          onClick={() => onScan(viewBand)}
        >
          Scan channels
        </Button>
      </Group>
      <Box
        ref={listRef}
        className="program-schedule"
        mah="70dvh"
        px="md"
        pos="relative"
        style={{ overflowY: 'auto' }}
        aria-label="Channel guide"
        onScroll={(event) => setCullY(Math.floor(event.currentTarget.scrollTop / CULL_STEP))}
      >
        <Box style={{ display: 'flex' }}>
          <Stack gap={0} w={STATION_WIDTH} pt={HOURS_HEIGHT + ROW_GAP} style={{ flex: 'none' }}>
            {rows.map(({ option }, index) => {
              const selected = option.value === selectedValue;
              return (
                <Popover
                  key={option.value}
                  // Hidden as soon as the pointer leaves the row.
                  opened={option.value === previewValue && option.value === hovered}
                  position="top-start"
                  offset={4}
                  shadow="md"
                  transitionProps={{ duration: 0 }}
                >
                  <Popover.Target>
                    <UnstyledButton
                      mt={index ? ROW_OVERLAP : 0}
                      ref={selected ? selectedRef : undefined}
                      className="channel-guide-station"
                      data-selected={selected || undefined}
                      h={ROW_HEIGHT}
                      px="sm"
                      disabled={busy}
                      aria-current={selected || undefined}
                      onClick={() => select(option)}
                      {...hover(option.value)}
                    >
                      <Group gap="xs" wrap="nowrap">
                        {/* Placeholder keeps names aligned with rows that have a logo. */}
                        {option.logo ? (
                          <img className="station-logo" src={option.logo} alt="" />
                        ) : (
                          <span
                            className="station-logo station-logo-placeholder"
                            aria-hidden="true"
                          />
                        )}
                        <Text size="sm" fw={700} miw={0} truncate>
                          {option.name || option.number}
                        </Text>
                      </Group>
                    </UnstyledButton>
                  </Popover.Target>
                  {/* Pointer events pass through so the rows beneath stay hoverable. */}
                  <Popover.Dropdown
                    p={0}
                    bd={0}
                    style={{ overflow: 'hidden', pointerEvents: 'none' }}
                  >
                    <StationPreview canvas={previewCanvas} state={previewState} />
                  </Popover.Dropdown>
                </Popover>
              );
            })}
          </Stack>
          <Box
            className="program-schedule"
            ml={ROW_GAP}
            style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}
            onScroll={(event) => setCullX(Math.floor(event.currentTarget.scrollLeft / CULL_STEP))}
          >
            <Stack gap={0} w={24 * HOUR_WIDTH}>
              <Box h={HOURS_HEIGHT} mb={ROW_GAP}>
                <TimelineHours firstHour={firstHour} hourWidth={HOUR_WIDTH} />
              </Box>
              {rows.map(({ option, events }, index) => {
                const top = HOURS_HEIGHT + ROW_GAP + index * (ROW_HEIGHT + ROW_OVERLAP);
                const shown = top + ROW_HEIGHT > rangeY[0] && top < rangeY[1];
                return (
                  <Box
                    key={option.value}
                    mt={index ? ROW_OVERLAP : 0}
                    pos="relative"
                    style={{ cursor: busy ? undefined : 'pointer' }}
                    {...hover(option.value)}
                    // A program in a sub-service lane tunes that service.
                    onClick={(event) => {
                      if (busy) return;
                      const lane = (event.target as HTMLElement).closest<HTMLElement>(
                        '[data-service]',
                      );
                      select(option, lane ? Number(lane.dataset.service) : option.serviceId);
                    }}
                  >
                    <TimelineTrack
                      events={shown ? events : NO_EVENTS}
                      range={rangeX}
                      firstHour={firstHour}
                      now={now}
                      height={ROW_HEIGHT}
                      hourWidth={HOUR_WIDTH}
                      descriptionLines={4}
                    />
                    {events.length === 0 && (
                      <Text
                        pos="absolute"
                        top={0}
                        left={8}
                        size="11px"
                        lh={`${ROW_HEIGHT}px`}
                        c="dimmed"
                      >
                        No program data
                      </Text>
                    )}
                  </Box>
                );
              })}
            </Stack>
          </Box>
        </Box>
      </Box>
    </Paper>
  );
}
