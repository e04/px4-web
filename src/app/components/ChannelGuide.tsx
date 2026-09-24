import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import type { Broadcast } from '../../channels';
import { stationTimeline, type TimelineItem } from '../../epg';
import type { ChannelOption } from '../hooks/useReceiverSession';
import { TimelineHours, TimelineTrack, timelineStart } from './ProgramTimeline';

const STATION_WIDTH = 300;
const ROW_HEIGHT = 84;
const ROW_GAP = 4;
// Rows touch and overlap by the 1px program border so it is not drawn twice.
const ROW_OVERLAP = -1;
const HOURS_HEIGHT = 13;
const HOUR_WIDTH = 200;
// Only programs near the viewport are rendered; the window moves in these steps
// so scrolling re-renders rarely.
const CULL_STEP = 512;

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
  onSelect: (channel: string, serviceId: number | null) => void;
  onScan: (band: Broadcast) => void;
}

export function ChannelGuide({
  band,
  selected: selectedValue,
  service,
  channelOptions,
  now,
  busy,
  scanning,
  onSelect,
  onScan,
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
                <UnstyledButton
                  key={option.value}
                  mt={index ? ROW_OVERLAP : 0}
                  ref={selected ? selectedRef : undefined}
                  className="channel-guide-station"
                  data-selected={selected || undefined}
                  h={ROW_HEIGHT}
                  px="sm"
                  disabled={busy}
                  aria-current={selected || undefined}
                  onClick={() => select(option)}
                >
                  <Group gap="xs" wrap="nowrap">
                    {/* Placeholder keeps names aligned with rows that have a logo. */}
                    {option.logo ? (
                      <img className="station-logo" src={option.logo} alt="" />
                    ) : (
                      <span className="station-logo station-logo-placeholder" aria-hidden="true" />
                    )}
                    <Text size="sm" fw={700} miw={0} truncate>
                      {option.name || option.number}
                    </Text>
                  </Group>
                </UnstyledButton>
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
