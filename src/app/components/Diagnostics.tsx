import { memo, useEffect, useRef, useState } from 'react';
import { Box, Button, Checkbox, Group, Modal, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import type { TransportSnapshot } from '../../transport/pipeline';
import type { ProgramEvent } from '../../transport/program-info';
import type { PlayerSnapshot } from '../hooks/usePlayback';
import { format, schedule } from '../format';

interface ProgramInfoProps {
  service: string | null;
  programs: TransportSnapshot['programs'] | undefined;
  current: ProgramEvent | null | undefined;
  logo?: string;
}

export const ProgramInfo = memo(function ProgramInfo({
  service,
  programs,
  current,
  logo,
}: ProgramInfoProps) {
  const program = service ? programs?.[Number(service)] : undefined;
  return (
    <Paper bg="dark.9" p="md" aria-label="Station and program information">
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap">
          {logo && <img className="station-logo" src={logo} alt="" />}
          <Text fw={700} style={{ overflowWrap: 'anywhere' }}>
            {program?.stationName || (service ? service : '-')}
          </Text>
        </Group>
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
  );
});

interface MetricsGridProps {
  transport: TransportSnapshot | undefined;
  playback: PlayerSnapshot | undefined;
  deviceLabel: string;
  cardless: boolean;
  lnb: boolean;
  lnbSupported: boolean;
  onLnbChange: (on: boolean) => void;
  b25: Record<string, number | boolean | undefined> | undefined;
  status: string;
}

export function MetricsGrid({
  transport,
  playback,
  deviceLabel,
  cardless,
  lnb,
  lnbSupported,
  onLnbChange,
  b25,
  status,
}: MetricsGridProps) {
  const [confirmLnb, setConfirmLnb] = useState(false);
  const metrics: [string, string][] = [
    ['Bitrate', format(transport?.mbps, ' Mbps', 2)],
    ['Max input gap', format(transport?.maxGapMs, ' ms', 0)],
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
        <Box>
          <Text component="dt" size="10px" c="dimmed" mb={5}>
            LNB Power
          </Text>
          <Box component="dd" m={0}>
            <Checkbox
              size="xs"
              aria-label="LNB Power"
              label={lnb ? 'ON' : 'OFF'}
              styles={{ label: { fontFamily: 'monospace' } }}
              checked={lnb}
              disabled={!lnbSupported}
              onChange={(event) => {
                // Powering the LNB puts DC on the antenna cable; ask before switching on.
                if (event.currentTarget.checked) setConfirmLnb(true);
                else onLnbChange(false);
              }}
            />
          </Box>
        </Box>
        <Box style={{ gridColumn: '2 / -1', minWidth: 0 }}>
          <Text component="dt" size="10px" c="dimmed" mb={5}>
            Status
          </Text>
          <Text component="dd" size="xs" m={0} style={{ overflowWrap: 'anywhere' }}>
            {status}
          </Text>
        </Box>
      </SimpleGrid>
      <Modal
        opened={confirmLnb}
        onClose={() => setConfirmLnb(false)}
        title="Turn on LNB power?"
        centered
      >
        <Group justify="flex-end" gap="xs">
          <Button color="gray" variant="subtle" onClick={() => setConfirmLnb(false)}>
            Cancel
          </Button>
          <Button
            color="dark"
            variant="white"
            onClick={() => {
              setConfirmLnb(false);
              onLnbChange(true);
            }}
          >
            Turn on
          </Button>
        </Group>
      </Modal>
    </Paper>
  );
}

/** Log strip height; controls placed beside the log match it. */
export const LOG_HEIGHT = 37;

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
        h={LOG_HEIGHT}
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
