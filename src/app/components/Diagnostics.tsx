import { memo, useEffect, useRef } from 'react';
import { Box, Paper, SimpleGrid, Stack, Text, Tooltip } from '@mantine/core';
import type { TransportSnapshot } from '../../transport/pipeline';
import { timelineEvents, type EpgMap } from '../../epg';
import type { ProgramEvent } from '../../transport/program-info';
import type { PlayerSnapshot } from '../hooks/usePlayback';
import type { StreamStats } from '../hooks/useReceiverSession';
import { format, schedule } from '../format';

interface ProgramInfoProps {
  service: string | null;
  programs: TransportSnapshot['programs'] | undefined;
  epg: EpgMap | undefined;
  current: ProgramEvent | null | undefined;
  now: number;
}

const timelineClock = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
});

export const ProgramInfo = memo(function ProgramInfo({
  service,
  programs,
  epg,
  current,
  now,
}: ProgramInfoProps) {
  const program = service ? programs?.[Number(service)] : undefined;
  const firstHour = Math.floor(now / 3600000) * 3600000;
  const events = timelineEvents(
    [
      ...(service ? epg?.[Number(service)] ?? [] : []),
      ...(program?.future ?? []),
      program?.current ?? null,
      program?.next ?? null,
    ],
    now,
    firstHour,
  );
  return (
    <Stack gap="xs">
      <Paper bg="dark.9" p="md" aria-label="Station and program information">
        <Stack gap="xs">
          <Text fw={700} style={{ overflowWrap: 'anywhere' }}>
            {program?.stationName || (service ? service : '-')}
          </Text>
          <Text style={{ overflowWrap: 'anywhere' }}>
            {current ? (
              <>
                <Text component="span" fw={700}>
                  {current.title || '—'}
                </Text>{' '}
                · {schedule(current)}
              </>
            ) : (
              '—'
            )}
          </Text>
          {current?.description && (
            <Text
              size="sm"
              style={{
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              }}
            >
              {current.description}
            </Text>
          )}
        </Stack>
      </Paper>
      {events.length > 0 && (
        <Paper bg="dark.9" p="md" aria-label="Program schedule">
          <Box
            className="program-schedule"
            style={{ overflowX: 'auto', maxWidth: '100%' }}
            tabIndex={0}
            aria-label="Program schedule (next 24 hours)"
          >
            <Box w={2400}>
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
              <Box pos="relative" h={100}>
                {events[0]!.left > 0.5 && (
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
                      {event.description && (
                        <Text
                          size="10px"
                          c="gray.5"
                          lh={1.2}
                          lineClamp={6}
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
            </Box>
          </Box>
        </Paper>
      )}
    </Stack>
  );
});

interface MetricsGridProps {
  stream: StreamStats | undefined;
  transport: TransportSnapshot | undefined;
  playback: PlayerSnapshot | undefined;
  deviceLabel: string;
  cardless: boolean;
  b25: Record<string, number | boolean | undefined> | undefined;
  epgCrawl: string;
  status: string;
}

export function MetricsGrid({
  stream,
  transport,
  playback,
  deviceLabel,
  cardless,
  b25,
  epgCrawl,
  status,
}: MetricsGridProps) {
  const metrics: [string, string][] = [
    ['Bitrate', format(stream?.mbps, ' Mbps', 2)],
    ['Max input gap', format(stream?.maxGapMs, ' ms', 0)],
    ['CC errors', transport?.ccErrors.toLocaleString() ?? '—'],
    ['TEI errors', transport?.tei.toLocaleString() ?? '—'],
    ['Sync losses', transport?.syncLosses.toLocaleString() ?? '—'],
    ['Discarded bytes', transport?.discardedBytes.toLocaleString() ?? '—'],
    ['Dropped frames', playback?.dropped.toLocaleString() ?? '—'],
    ['A/V offset', format(playback?.avOffsetMs, ' ms', 0)],
    ['Audio buffer', format(playback?.audioQueuedSeconds, ' s', 2)],
    ['Resyncs', playback?.resyncs.toLocaleString() ?? '—'],
    ['Device', deviceLabel || '—'],
    ['Card', cardless ? 'No reader' : b25?.cardReady ? 'Ready' : '—'],
    ['EPG tuner', epgCrawl || '—'],
  ];
  return (
    <Paper bg="dark.9" p="md">
      <SimpleGrid component="dl" cols={{ base: 4, sm: 6 }} spacing="xs" verticalSpacing="lg" m={0}>
        {metrics.map(([label, value]) => (
          <Box key={label}>
            <Text component="dt" size="10px" c="dimmed" mb={5}>
              {label}
            </Text>
            <Text
              component="dd"
              size="xs"
              m={0}
              ff="monospace"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {value}
            </Text>
          </Box>
        ))}
        <Box style={{ gridColumn: '1 / -1', minWidth: 0 }}>
          <Text component="dt" size="10px" c="dimmed" mb={5}>
            Status
          </Text>
          <Text component="dd" size="xs" m={0} style={{ overflowWrap: 'anywhere' }}>
            {status}
          </Text>
        </Box>
      </SimpleGrid>
    </Paper>
  );
}

export function LogPanel({ logs }: { logs: string[] }) {
  const logRef = useRef<HTMLPreElement>(null);
  const followLogs = useRef(true);

  useEffect(() => {
    if (logRef.current && followLogs.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  return (
    <Paper bg="dark.9" style={{ overflow: 'hidden' }}>
      <Box
        component="pre"
        className="receiver-log"
        ref={logRef}
        tabIndex={0}
        aria-label="Receiver log"
        onScroll={(event) => {
          const element = event.currentTarget;
          followLogs.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
        }}
        m={0}
        h={37}
        py="4"
        px="8"
        c="gray.4"
        fz={11}
        lh={1.2}
        style={{
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {logs.map((line, index) => (
          <Text
            component="span"
            c={line.startsWith('[ERROR] ') ? 'red.5' : undefined}
            inherit
            key={`${index}-${line}`}
          >
            {line}
            {'\n'}
          </Text>
        ))}
      </Box>
    </Paper>
  );
}
