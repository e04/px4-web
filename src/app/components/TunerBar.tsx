import { useState } from 'react';
import { Button, Combobox, Group, Input, Text } from '@mantine/core';
import type { Broadcast } from '../../channels';
import type { ChannelOption } from '../hooks/useReceiverSession';
import { ChannelGuide } from './ChannelGuide';

interface TunerBarProps {
  band: Broadcast;
  channel: string;
  channelOptions: ChannelOption[];
  selected: string | undefined;
  selectedLabel: string | undefined;
  service: string | null;
  now: number;
  busy: boolean;
  connected: boolean;
  scanning: boolean;
  supported: boolean;
  onSelect: (channel: string, serviceId: number | null) => void;
  onConnect: () => void;
  onScan: (band: Broadcast) => void;
}

export function TunerBar({
  band,
  channel,
  channelOptions,
  selected,
  selectedLabel,
  service,
  now,
  busy,
  connected,
  scanning,
  supported,
  onSelect,
  onConnect,
  onScan,
}: TunerBarProps) {
  const [guideOpened, setGuideOpened] = useState(false);
  return (
    <Group align="end" gap="sm">
      <Input
        component="button"
        type="button"
        aria-label="Channel"
        aria-haspopup="dialog"
        pointer
        rightSection={<Combobox.Chevron />}
        rightSectionPointerEvents="none"
        disabled={busy}
        onClick={() => setGuideOpened(true)}
        flex={1}
        miw={{ base: '100%', xs: 220 }}
      >
        <Text span size="sm" truncate display="block">
          {selectedLabel ?? `CH ${channel}`}
        </Text>
      </Input>
      <ChannelGuide
        opened={guideOpened && !scanning}
        onClose={() => setGuideOpened(false)}
        band={band}
        selected={selected}
        service={service}
        channelOptions={channelOptions}
        now={now}
        busy={busy}
        scanning={scanning}
        onSelect={onSelect}
        onScan={onScan}
      />
      {!connected && !scanning && (
        <Button
          color="dark"
          variant="white"
          disabled={!supported || busy}
          loading={busy}
          onClick={() => void onConnect()}
        >
          Connect
        </Button>
      )}
    </Group>
  );
}
