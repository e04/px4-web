import { useEffect, useRef } from 'react';
import { Badge, Box, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import type { TransportSnapshot } from '../../transport/pipeline';
import type { PlayerSnapshot } from '../hooks/usePlayback';
import type { StreamStats } from '../hooks/useReceiverSession';
import { active, format, schedule } from '../format';

interface ProgramInfoProps {
  service: string | null;
  programs: TransportSnapshot['programs'] | undefined;
}

export function ProgramInfo({ service, programs }: ProgramInfoProps) {
  const program = service ? programs?.[Number(service)] : undefined;
  const now = Date.now();
  const current = active(program?.current, now);
  const next = active(program?.next, now);
  return (
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
        {next && (
          <Group gap="xs" mt="xs">
            <Badge color='gray' radius={0}>Next</Badge>
            <Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              <Text component="span" fw={700}>
                {next.title || '—'}
              </Text>{' '}
              · {schedule(next)}
            </Text>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

interface MetricsGridProps {
  stream: StreamStats | undefined;
  transport: TransportSnapshot | undefined;
  playback: PlayerSnapshot | undefined;
  deviceLabel: string;
  cardless: boolean;
  b25: Record<string, number | boolean | undefined> | undefined;
  status: string;
}

export function MetricsGrid({
  stream,
  transport,
  playback,
  deviceLabel,
  cardless,
  b25,
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
        ref={logRef}
        tabIndex={0}
        aria-label="Receiver log"
        onScroll={(event) => {
          const element = event.currentTarget;
          followLogs.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
        }}
        m={0}
        h={74}
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
