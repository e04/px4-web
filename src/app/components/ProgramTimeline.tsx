import { memo } from 'react';
import { Box, Stack, Text, Tooltip } from '@mantine/core';
import type { timelineEvents } from '../../epg';
import { schedule } from '../format';

/** Timeline scale: 100 px per hour over 24 hours. */
export const TIMELINE_WIDTH = 2400;

const timelineClock = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
});

export function timelineStart(now: number) {
  return Math.floor(now / 3600000) * 3600000;
}

export function TimelineHours({ firstHour }: { firstHour: number }) {
  return (
    <Box pos="relative" h={12} mb={1} style={{ overflow: 'hidden' }}>
      {Array.from({ length: 24 }, (_, index) => firstHour + index * 3600000).map((hour) => (
        <Text
          key={hour}
          pos="absolute"
          size="10px"
          lh="12px"
          style={{ left: (hour - firstHour) / 36000, whiteSpace: 'nowrap' }}
        >
          {timelineClock.format(hour)}
        </Text>
      ))}
    </Box>
  );
}

interface TimelineTrackProps {
  events: ReturnType<typeof timelineEvents>;
  firstHour: number;
  now: number;
  height: number;
  descriptionLines?: number;
}

export const TimelineTrack = memo(function TimelineTrack({
  events,
  firstHour,
  now,
  height,
  descriptionLines = 6,
}: TimelineTrackProps) {
  return (
    <Box pos="relative" h={height}>
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
      {events.map(({ event, left, width }, index) => (
        <Tooltip
          key={`${event.id}:${event.start}`}
          multiline
          w={300}
          label={
            <Stack gap={2}>
              <Text size="xs" fw={700}>
                {event.title || '—'}
              </Text>
              <Text size="xs">{schedule(event)}</Text>
              {event.description && (
                <Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>
                  {event.description}
                </Text>
              )}
            </Stack>
          }
        >
          <Box
            pos="absolute"
            top={0}
            h="100%"
            p={2}
            tabIndex={0}
            style={{
              left,
              width,
              overflow: 'hidden',
              border: '1px solid var(--mantine-color-dark-4)',
              borderLeft:
                (index === 0 && left > 0.5) ||
                (index > 0 &&
                  Math.abs(left - (events[index - 1]!.left + events[index - 1]!.width)) < 0.5)
                  ? 'none'
                  : undefined,
              fontSize: 11,
            }}
          >
            <Text size="11px" lh={1.2} lineClamp={2} style={{ overflowWrap: 'anywhere' }}>
              {event.title || '—'}
            </Text>
            {event.description && descriptionLines > 0 && (
              <Text
                size="10px"
                c="gray.5"
                lh={1.2}
                lineClamp={descriptionLines}
                style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {event.description}
              </Text>
            )}
          </Box>
        </Tooltip>
      ))}
      <Box
        pos="absolute"
        top={0}
        h="100%"
        w={2}
        style={{
          left: (now - firstHour) / 36000,
          background: 'rgba(185, 99, 80, 0.5)',
          pointerEvents: 'none',
        }}
        aria-hidden="true"
      />
    </Box>
  );
});
