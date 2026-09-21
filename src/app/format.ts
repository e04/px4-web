import { SCAN_CHANNELS } from '../scan';
import { CAPTION_KEY, CHANNEL_KEY, VOLUME_KEY, loadValue, settingsStore } from '../storage';
import type { ProgramEvent } from '../transport/program-info';

export const channelNumbers = [...SCAN_CHANNELS];
export const SCAN_OPTION = '__scan';

export const stateLabels: Record<string, string> = {
  connected: 'Connected',
  initializing: 'Initializing device',
  ready: 'Ready',
  tuning: 'Tuning',
  locked: 'Signal locked',
  streaming: 'Receiving transport stream',
  stopping: 'Stopping',
  stopped: 'Stopped',
  error: 'Receiver error',
  disconnected: 'Disconnected',
};

export function format(value: number | null | undefined, unit = '', decimals = 1) {
  return value != null && Number.isFinite(value) ? `${value.toFixed(decimals)}${unit}` : '—';
}

const dateTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const clock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
export function schedule(event: ProgramEvent) {
  if (event.start == null) return '—';
  return `${dateTime.format(event.start).replace(',', '')} – ${event.end == null ? '—' : clock.format(event.end)}`;
}
export function active(event: ProgramEvent | null | undefined, now: number) {
  return event && (event.end == null || event.end > now) ? event : null;
}

export const DEFAULT_CHANNEL = '13';
export const DEFAULT_CAPTION_ENABLED = true;
export const DEFAULT_VOLUME = 1;

export async function loadChannel(): Promise<string> {
  const value = await loadValue<string>(CHANNEL_KEY, settingsStore);
  return channelNumbers.some((channel) => String(channel) === value) ? value! : DEFAULT_CHANNEL;
}

export async function loadCaptionEnabled(): Promise<boolean> {
  const value = await loadValue<string | boolean>(CAPTION_KEY, settingsStore);
  return value === 'off' || value === false ? false : DEFAULT_CAPTION_ENABLED;
}

export async function loadVolume(): Promise<number> {
  const raw = Number(await loadValue<number | string>(VOLUME_KEY, settingsStore));
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : DEFAULT_VOLUME;
}
