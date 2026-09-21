import { Box, Button, CheckIcon, Group, Select, Text } from '@mantine/core';
import type { TransportSnapshot } from '../../transport/pipeline';

interface TunerBarProps {
  channel: string;
  channelOptions: { value: string; label: string; station: string; program: string }[];
  service: string | null;
  services: number[];
  programs: TransportSnapshot['programs'] | undefined;
  busy: boolean;
  connected: boolean;
  scanning: boolean;
  supported: boolean;
  onChannel: (value: string | null) => void;
  onService: (value: string | null) => void;
  onConnect: () => void;
}

export function TunerBar({
  channel,
  channelOptions,
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
}: TunerBarProps) {
  return (
    <Group align="end" gap="sm">
      <Select
        aria-label="Physical channel"
        data={channelOptions}
        renderOption={({ option, checked }) => {
          const entry = channelOptions.find((item) => item.value === option.value);
          return (
            <Box style={{ display: 'grid', gridTemplateColumns: '20px minmax(0, 220px) minmax(0, 1fr)', gap: 12, width: '100%', alignItems: 'center' }}>
              <Box w={20} h={20}>{checked && <CheckIcon size={16} />}</Box>
              <Text size="sm" fw={700} truncate>{entry?.station ?? option.label}</Text>
              <Text size="sm" truncate>{entry?.program ?? ''}</Text>
            </Box>
          );
        }}
        value={channel}
        onChange={(value) => void onChannel(value)}
        searchable
        allowDeselect={false}
        disabled={busy}
        flex={1}
        miw={{ base: '100%', xs: 220 }}
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
