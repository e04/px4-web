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
const PREVIEW_OFFSET = 4;
const PREVIEW_OPEN_DELAY = 50;
// The tuner outlives the popup this long, so re-entering the row (or crossing
// the gap between the columns) shows the same preview again without retuning.
const PREVIEW_RELEASE_DELAY = 300;

const NO_EVENTS: TimelineItem[] = [];

/** Service of each timeline lane at `now`; a single entry when the station airs one program. */
function airingLanes(events: TimelineItem[], now: number) {
  const lanes: number[] = [];
  for (const { event, serviceId, lane = 0, lanes: count = 1 } of events) {
    if (count < 2 || serviceId == null || event.start == null || event.end == null) continue;
    if (event.start <= now && now < event.end) lanes[lane] = serviceId;
  }
  return lanes.filter((serviceId) => serviceId != null);
}

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
  previewSurface: HTMLDivElement;
  onSelect: (channel: string, serviceId: number | null) => void;
  onScan: (band: Broadcast) => void;
  onPreview: (target: PreviewTarget | null) => void;
  /** Fill the parent's height instead of capping the list, as in the fullscreen/PiP overlay. */
  fill?: boolean;
  /** Where station previews are mounted; defaults to the page body. */
  portalTarget?: HTMLElement;
}

function StationPreview({
  surface,
  state,
  width,
}: {
  surface: HTMLDivElement;
  state: PreviewState;
  width: number;
}) {
  return (
    <Box
      pos="relative"
      w={width}
      bg="black"
      style={{ aspectRatio: '16 / 9', overflow: 'hidden' }}
      aria-label="Station preview"
    >
      <Box
        w="100%"
        h="100%"
        className="station-preview-canvas"
        // Opacity, not visibility: the caption layers force their own `visibility: visible`.
        style={{ opacity: state === 'playing' ? undefined : 0 }}
        ref={(node: HTMLDivElement | null) => {
          if (node && surface.parentNode !== node) node.appendChild(surface);
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
  previewSurface,
  onSelect,
  onScan,
  onPreview,
  fill = false,
  portalTarget,
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
  const stationsRef = useRef<HTMLDivElement>(null);
  const hoursRef = useRef<HTMLDivElement>(null);
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
  // Service under the pointer on a split station button.
  const [hoveredService, setHoveredService] = useState<number | null>(null);
  const [previewed, setPreviewed] = useState<{ value: string; serviceId: number | null } | null>(
    null,
  );
  useEffect(() => {
    const timer = window.setTimeout(
      () => setPreviewed(hovered ? { value: hovered, serviceId: hoveredService } : null),
      hovered ? PREVIEW_OPEN_DELAY : PREVIEW_RELEASE_DELAY,
    );
    return () => window.clearTimeout(timer);
  }, [hovered, hoveredService]);
  // The tuned station is already on screen; unscanned ones have no service.
  const previewOption = rows.find(({ option }) => option.value === previewed?.value)?.option;
  const previewServiceId = previewed?.serviceId ?? previewOption?.serviceId;
  const previewTuned =
    previewOption?.value === selectedValue &&
    (previewed?.serviceId == null || String(previewServiceId) === service);
  const previewValue =
    previewAvailable && !busy && previewServiceId != null && !previewTuned
      ? previewOption?.value
      : undefined;
  useEffect(() => {
    onPreview(
      previewValue && previewOption && previewServiceId != null
        ? {
            value: previewValue,
            channel: previewOption.channel,
            serviceId: previewServiceId,
          }
        : null,
    );
    // The target is keyed by row value; the option object is rebuilt on every EPG update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewValue, previewServiceId]);
  // The preview sits left of the station column when it fits; otherwise it goes
  // above (or below) the row. Placement is decided here rather than by flip,
  // which measures against the viewport instead of the portal target.
  const previewOpen = previewValue !== undefined && previewValue === hovered;
  const previewLeft =
    previewOpen &&
    (stationsRef.current?.getBoundingClientRect().left ?? 0) -
      (portalTarget?.getBoundingClientRect().left ?? 0) >=
      PREVIEW_WIDTH + PREVIEW_OFFSET;
  const hover = (value: string) => ({
    onMouseEnter: () => setHovered(value),
    onMouseLeave: () => setHovered((current) => (current === value ? null : current)),
  });

  const select = (option: ChannelOption, serviceId = option.serviceId) => {
    if (option.value !== selectedValue || String(serviceId) !== service)
      onSelect(option.channel, serviceId);
  };

  return (
    <Paper
      bg={fill ? 'transparent' : 'dark.9'}
      py="md"
      h={fill ? '100%' : undefined}
      style={fill ? { display: 'flex', flexDirection: 'column' } : undefined}
      aria-label="Program guide"
    >
      <Group justify="space-between" px="md" mb="sm">
        <SegmentedControl
          aria-label="Broadcast"
          className="band-switch"
          size="xs"
          fullWidth
          w={210}
          data={BANDS}
          value={viewBand}
          onChange={(value) => setViewBand(value as Broadcast)}
        />
        {/* The scan modal lives on the page, out of sight from fullscreen and PiP. */}
        {!fill && (
          <Button
            className="scan-button"
            size="xs"
            color="gray"
            variant="transparent"
            disabled={busy || scanning}
            onClick={() => onScan(viewBand)}
          >
            Scan channels...
          </Button>
        )}
      </Group>
      {/* Hour labels stay above the vertical scroller and follow the timeline's horizontal scroll. */}
      <Box px="md" mb={ROW_GAP} style={{ display: 'flex' }}>
        <Box w={STATION_WIDTH + ROW_GAP} style={{ flex: 'none' }} />
        <Box ref={hoursRef} h={HOURS_HEIGHT} style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <Box w={24 * HOUR_WIDTH}>
            <TimelineHours firstHour={firstHour} hourWidth={HOUR_WIDTH} />
          </Box>
        </Box>
      </Box>
      <Box
        ref={listRef}
        className="program-schedule"
        mah={fill ? undefined : '70dvh'}
        px="md"
        pos="relative"
        style={fill ? { flex: 1, minHeight: 0, overflowY: 'auto' } : { overflowY: 'auto' }}
        aria-label="Channel guide"
        onScroll={(event) => setCullY(Math.floor(event.currentTarget.scrollTop / CULL_STEP))}
      >
        <Box style={{ display: 'flex' }}>
          <Stack ref={stationsRef} gap={0} w={STATION_WIDTH} style={{ flex: 'none' }}>
            {rows.map(({ option, events }, index) => {
              const selected = option.value === selectedValue;
              const segments = airingLanes(events, now);
              const selectedSegment = selected
                ? segments.findIndex((serviceId) => String(serviceId) === service)
                : -1;
              return (
                <Popover
                  key={option.value}
                  // Hidden as soon as the pointer leaves the row.
                  opened={option.value === previewValue && option.value === hovered}
                  position={previewLeft ? 'left' : 'top'}
                  middlewares={{ flip: !previewLeft, shift: true }}
                  offset={PREVIEW_OFFSET}
                  shadow="md"
                  transitionProps={{ duration: 0 }}
                  portalProps={portalTarget ? { target: portalTarget } : undefined}
                >
                  <Popover.Target>
                    <UnstyledButton
                      mt={index ? ROW_OVERLAP : 0}
                      ref={selected ? selectedRef : undefined}
                      className="channel-guide-station"
                      data-selected={(selected && selectedSegment < 0) || undefined}
                      data-split={segments.length > 1 || undefined}
                      h={ROW_HEIGHT}
                      px="sm"
                      disabled={busy}
                      aria-current={selected || undefined}
                      // Sub-services airing their own programs split the button like the timeline lanes.
                      onClick={(event) => {
                        const segment = (event.target as HTMLElement).closest<HTMLElement>(
                          '[data-service]',
                        );
                        select(
                          option,
                          segment ? Number(segment.dataset.service) : option.serviceId,
                        );
                      }}
                      {...hover(option.value)}
                    >
                      {segments.length > 1 &&
                        segments.map((serviceId, lane) => (
                          <span
                            key={serviceId}
                            className="channel-guide-segment"
                            data-service={serviceId}
                            data-selected={lane === selectedSegment || undefined}
                            onMouseEnter={() => setHoveredService(serviceId)}
                            onMouseLeave={() => setHoveredService(null)}
                            style={{
                              top: `${(lane / segments.length) * 100}%`,
                              height: `${100 / segments.length}%`,
                            }}
                          />
                        ))}
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
                    <StationPreview
                      surface={previewSurface}
                      state={previewState}
                      width={PREVIEW_WIDTH}
                    />
                  </Popover.Dropdown>
                </Popover>
              );
            })}
          </Stack>
          <Box
            className="program-schedule"
            ml={ROW_GAP}
            style={{ flex: 1, minWidth: 0, overflowX: 'auto', cursor: 'grab' }}
            onPointerDown={(event) => {
              // Touch scrolls natively; drag-to-scroll is for the mouse.
              if (event.pointerType !== 'mouse' || event.button !== 0) return;
              const timeline = event.currentTarget;
              const list = listRef.current;
              const origin = {
                x: event.clientX,
                y: event.clientY,
                left: timeline.scrollLeft,
                top: list?.scrollTop ?? 0,
              };
              event.preventDefault();
              timeline.setPointerCapture(event.pointerId);
              timeline.style.cursor = 'grabbing';
              const onMove = (move: PointerEvent) => {
                timeline.scrollLeft = origin.left - (move.clientX - origin.x);
                if (list) list.scrollTop = origin.top - (move.clientY - origin.y);
              };
              const onEnd = () => {
                timeline.style.cursor = 'grab';
                timeline.removeEventListener('pointermove', onMove);
                timeline.removeEventListener('pointerup', onEnd);
                timeline.removeEventListener('pointercancel', onEnd);
              };
              timeline.addEventListener('pointermove', onMove);
              timeline.addEventListener('pointerup', onEnd);
              timeline.addEventListener('pointercancel', onEnd);
            }}
            onScroll={(event) => {
              const { scrollLeft } = event.currentTarget;
              if (hoursRef.current) hoursRef.current.scrollLeft = scrollLeft;
              setCullX(Math.floor(scrollLeft / CULL_STEP));
            }}
          >
            <Stack gap={0} w={24 * HOUR_WIDTH}>
              {rows.map(({ option, events }, index) => {
                const top = index * (ROW_HEIGHT + ROW_OVERLAP);
                const shown = top + ROW_HEIGHT > rangeY[0] && top < rangeY[1];
                return (
                  <Box
                    key={option.value}
                    mt={index ? ROW_OVERLAP : 0}
                    pos="relative"
                    className="channel-guide-track"
                    data-selected={option.value === selectedValue || undefined}
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
