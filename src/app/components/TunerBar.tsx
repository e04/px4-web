import { useState } from 'react';
import { Button, Combobox, Group, Input, Select, Text } from '@mantine/core';
import type { Broadcast } from '../../channels';
import type { TransportSnapshot } from '../../transport/pipeline';
import type { ChannelOption } from '../hooks/useReceiverSession';
import { ChannelGuide } from './ChannelGuide';

interface TunerBarProps {
  band: Broadcast;
  channel: string;
  channelOptions: ChannelOption[];
  now: number;
  service: string | null;
  services: number[];
  programs: TransportSnapshot['programs'] | undefined;
  busy: boolean;
  connected: boolean;
  scanning: boolean;
  supported: boolean;
  onChannel: (value: string) => void;
  onService: (value: string | null) => void;
  onConnect: () => void;
  onScan: (band: Broadcast) => void;
}

export function TunerBar({
  band,
  channel,
  channelOptions,
  now,
  service,
  services,
  programs,
  busy,
  connected,
  scanning,
  supported,
  onChannel,
  onService,
  onConnect,
  onScan,
}: TunerBarProps) {
  const [guideOpened, setGuideOpened] = useState(false);
  const selected = channelOptions.find((item) => item.value === channel);
  return (
    <Group align="end" gap="sm">
      <Input
        component="button"
        type="button"
        aria-label="Physical channel"
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
          {selected?.label ?? `CH ${channel}`}
        </Text>
      </Input>
      <ChannelGuide
        opened={guideOpened && !scanning}
        onClose={() => setGuideOpened(false)}
        band={band}
        channel={channel}
        channelOptions={channelOptions}
        now={now}
        busy={busy}
        scanning={scanning}
        onChannel={onChannel}
        onScan={onScan}
      />
      <Select
        aria-label="Service"
        data={services.map((id) => ({
          value: String(id),
          label: programs?.[id]?.stationName || `Service ${id}`,
        }))}
        value={service}
        onChange={(value) => void onService(value)}
        disabled={!services.length || busy}
        allowDeselect={false}
        w={210}
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
