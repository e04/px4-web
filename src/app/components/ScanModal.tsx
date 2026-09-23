import { useEffect, useRef } from 'react';
import { Button, Group, Modal, Progress, ScrollArea, Stack, Text } from '@mantine/core';
import { representativeName } from '../../scan';
import type { ScanProgress, ScanResult } from '../hooks/useReceiverSession';

interface ScanModalProps {
  scanning: boolean;
  cancelling: boolean;
  scanProgress: ScanProgress | null;
  scanEvents: ScanResult[];
  onCancel: () => void;
}

export function ScanModal({
  scanning,
  cancelling,
  scanProgress,
  scanEvents,
  onCancel,
}: ScanModalProps) {
  const scanListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scanListRef.current?.scrollTo({ top: scanListRef.current.scrollHeight });
  }, [scanEvents]);

  return (
    <Modal
      opened={scanning}
      onClose={() => {}}
      title="Scanning channels"
      centered
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
    >
      <Stack gap="sm">
        <Group justify="space-between" gap="xs">
          <Text size="sm">
            {cancelling
              ? 'Cancelling scan and restoring channel…'
              : scanProgress
                ? `Scanning CH ${scanProgress.channel} (${scanProgress.done}/${scanProgress.total})`
                : 'Starting…'}
          </Text>
        </Group>
        <Progress
          color="white"
          value={scanProgress ? (scanProgress.done / scanProgress.total) * 100 : 0}
          size="sm"
          aria-label="Scan progress"
        />
        <ScrollArea h={220} viewportRef={scanListRef} aria-label="Scan results">
          <Stack gap={4}>
            {scanEvents.map(({ channel, entry }) => (
              <Group key={channel} justify="space-between" gap="xs">
                <Text size="sm" ff="monospace">
                  CH {channel}
                </Text>
                <Text size="sm" c={entry.locked ? undefined : 'dimmed'}>
                  {representativeName(entry) ||
                    (entry.locked ? 'Locked, no station name' : 'No signal')}
                </Text>
              </Group>
            ))}
            {scanEvents.length === 0 && (
              <Text size="sm" c="dimmed">
                Tuning the first channel…
              </Text>
            )}
          </Stack>
        </ScrollArea>
        <Group justify="flex-end">
          <Button color="dark" variant="white" onClick={onCancel} loading={cancelling}>
            Cancel scan
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
