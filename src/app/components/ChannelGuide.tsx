import { useEffect, useMemo, useRef } from 'react';
import { Box, Button, Group, Modal, Stack, Text, UnstyledButton } from '@mantine/core';
import { timelineEvents } from '../../epg';
import type { ChannelOption } from '../hooks/useReceiverSession';
import { TIMELINE_WIDTH, TimelineHours, TimelineTrack, timelineStart } from './ProgramTimeline';

const STATION_WIDTH = 180;
const ROW_HEIGHT = 56;
const ROW_GAP = 4;
const HOURS_HEIGHT = 13;

interface ChannelGuideProps {
  opened: boolean;
  onClose: () => void;
  bandLabel: string;
  channel: string;
  channelOptions: ChannelOption[];
  now: number;
  busy: boolean;
  scanning: boolean;
  onChannel: (value: string) => void;
  onScan: () => void;
}

export function ChannelGuide({
  opened,
  onClose,
  bandLabel,
  channel,
  channelOptions,
  now,
  busy,
  scanning,
  onChannel,
  onScan,
}: ChannelGuideProps) {
  const firstHour = timelineStart(now);
  const rows = useMemo(
    () =>
      channelOptions.map((option) => ({
        option,
        events: timelineEvents(option.schedule, now, firstHour),
      })),
    [channelOptions, now, firstHour],
  );
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (opened)
      requestAnimationFrame(() => selectedRef.current?.scrollIntoView({ block: 'center' }));
  }, [opened]);

  const select = (value: string) => {
    onClose();
    if (value !== channel) onChannel(value);
  };

  return (
    <Modal.Root
      opened={opened}
      onClose={onClose}
      size="min(1400px, calc(100vw - 32px))"
      centered
      classNames={{ content: 'channel-guide', header: 'channel-guide-header' }}
    >
      <Modal.Overlay backgroundOpacity={0.35} />
      <Modal.Content>
        <Modal.Header>
          <Modal.Title fw={700}>{bandLabel}</Modal.Title>
          <Group gap="xs">
            <Button
              size="xs"
              color="dark"
              variant="white"
              disabled={busy || scanning}
              onClick={() => {
                onClose();
                onScan();
              }}
            >
              Scan channels
            </Button>
            <Modal.CloseButton />
          </Group>
        </Modal.Header>
        <Modal.Body>
          <Box
            className="program-schedule"
            mah="calc(100dvh - 160px)"
            style={{ overflowY: 'auto' }}
            aria-label="Channel guide"
          >
            <Box style={{ display: 'flex' }}>
              <Stack
                gap={ROW_GAP}
                w={STATION_WIDTH}
                pt={HOURS_HEIGHT + ROW_GAP}
                style={{ flex: 'none' }}
              >
                {rows.map(({ option }) => {
                  const selected = option.value === channel;
                  return (
                    <UnstyledButton
                      key={option.value}
                      ref={selected ? selectedRef : undefined}
                      className="channel-guide-station"
                      data-selected={selected || undefined}
                      h={ROW_HEIGHT}
                      px="sm"
                      disabled={busy}
                      aria-current={selected || undefined}
                      onClick={() => select(option.value)}
                    >
                      <Text size="sm" fw={700} truncate>
                        {option.name || `CH ${option.value}`}
                      </Text>
                      {option.name && (
                        <Text size="xs" c="dimmed" truncate>
                          CH {option.value}
                        </Text>
                      )}
                    </UnstyledButton>
                  );
                })}
              </Stack>
              <Box
                className="program-schedule"
                ml={ROW_GAP}
                style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}
              >
                <Stack gap={ROW_GAP} w={TIMELINE_WIDTH}>
                  <Box h={HOURS_HEIGHT}>
                    <TimelineHours firstHour={firstHour} />
                  </Box>
                  {rows.map(({ option, events }) => (
                    <Box
                      key={option.value}
                      pos="relative"
                      style={{ cursor: busy ? undefined : 'pointer' }}
                      onClick={() => !busy && select(option.value)}
                    >
                      <TimelineTrack
                        events={events}
                        firstHour={firstHour}
                        now={now}
                        height={ROW_HEIGHT}
                        descriptionLines={2}
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
                  ))}
                </Stack>
              </Box>
            </Box>
          </Box>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
