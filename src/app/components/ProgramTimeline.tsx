import { memo, useState } from 'react';
import type { ProgramEvent } from '../../transport/program-info';
import { Box, Stack, Text, Tooltip } from '@mantine/core';
import type { TimelineItem } from '../../epg';
import { schedule } from '../format';

/** Default timeline scale: 100 px per hour over 24 hours. */
export const HOUR_WIDTH = 100;

const timelineClock = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
});

export function timelineStart(now: number) {
  return Math.floor(now / 3600000) * 3600000;
}

export function TimelineHours({
  firstHour,
  hourWidth = HOUR_WIDTH,
}: {
  firstHour: number;
  hourWidth?: number;
}) {
  return (
    <Box pos="relative" h={12} mb={1} style={{ overflow: 'hidden' }}>
      {Array.from({ length: 24 }, (_, index) => firstHour + index * 3600000).map((hour) => (
        <Text
          key={hour}
          pos="absolute"
          size="10px"
          lh="12px"
          style={{ left: ((hour - firstHour) / 3600000) * hourWidth, whiteSpace: 'nowrap' }}
        >
          {timelineClock.format(hour)}
        </Text>
      ))}
    </Box>
  );
}

interface TimelineTrackProps {
  events: TimelineItem[];
  firstHour: number;
  now: number;
  height: number;
  hourWidth?: number;
  descriptionLines?: number;
  /** Horizontal pixel range to render; programs outside it are skipped. */
  range?: readonly [number, number];
}

export const TimelineTrack = memo(function TimelineTrack({
  events,
  firstHour,
  now,
  height,
  hourWidth = HOUR_WIDTH,
  descriptionLines = 6,
  range,
}: TimelineTrackProps) {
  // One tooltip per track, mounted only while a program is hovered or focused:
  // a Tooltip per program costs hundreds of ms when a full guide mounts.
  const [active, setActive] = useState<{ target: HTMLElement; event: ProgramEvent } | null>(null);
  const hide = () => setActive(null);
  return (
    <Box pos="relative" h={height}>
      {active && (
        <Tooltip
          opened
          target={active.target}
          multiline
          w={300}
          label={
            <Stack gap={2}>
              <Text size="xs" fw={700}>
                {active.event.title || '—'}
              </Text>
              <Text size="xs">{schedule(active.event)}</Text>
              {active.event.description && (
                <Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>
                  {active.event.description}
                </Text>
              )}
            </Stack>
          }
        />
      )}
      {events.length > 0 && events[0]!.left > 0.5 && (
        <Box
          pos="absolute"
          top={0}
          h="100%"
          p={2}
          aria-hidden="true"
          style={{
            left: 0,
            width: events[0]!.left,
            overflow: 'hidden',
            border: '1px solid var(--mantine-color-dark-4)',
          }}
        />
      )}
      {/* Plain elements: a guide renders hundreds of these at once. */}
      {events.map(({ event, left, width, serviceId, lane = 0, lanes = 1 }, index) =>
        range && (left + width < range[0] || left > range[1]) ? null : (
          <div
            // Sub-services of one station can air the same event_id in their own lanes.
            key={`${serviceId}:${event.id}:${event.start}`}
            className="timeline-event"
            data-service={serviceId}
            tabIndex={0}
            onMouseEnter={(e) => setActive({ target: e.currentTarget, event })}
            onFocus={(e) => setActive({ target: e.currentTarget, event })}
            onMouseLeave={hide}
            onBlur={hide}
            style={{
              left,
              width,
              ...(lanes > 1
                ? {
                    top: `${(lane / lanes) * 100}%`,
                    height: `${100 / lanes}%`,
                    // The lane above already draws the shared edge.
                    borderTop: lane > 0 ? 'none' : undefined,
                  }
                : {}),
              borderLeft:
                (index === 0 && left > 0.5) ||
                (index > 0 &&
                  (events[index - 1]!.lane ?? 0) === lane &&
                  Math.abs(left - (events[index - 1]!.left + events[index - 1]!.width)) < 0.5)
                  ? 'none'
                  : undefined,
            }}
          >
            <div className="timeline-event-title">{event.title || '—'}</div>
            {event.description && descriptionLines > 0 && (
              <div
                className="timeline-event-description"
                style={{ WebkitLineClamp: descriptionLines }}
              >
                {event.description}
              </div>
            )}
          </div>
        ),
      )}
      <Box
        pos="absolute"
        top={0}
        h="100%"
        w={2}
        style={{
          left: ((now - firstHour) / 3600000) * hourWidth,
          background: 'rgba(185, 99, 80, 0.5)',
          pointerEvents: 'none',
        }}
        aria-hidden="true"
      />
    </Box>
  );
});
