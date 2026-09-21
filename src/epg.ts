import type { ProgramEvent, ProgramInfo } from './transport/program-info';
import { epgStore, loadValue, saveValue } from './storage';

export type EpgMap = Record<number, ProgramEvent[]>;
export function currentChannelProgram(epg: EpgMap | undefined, serviceIds: number[], now: number): ProgramEvent | undefined {
  for (const id of serviceIds) {
    const match = epg?.[id]?.find((event) => event.start != null && event.start <= now && event.end != null && now < event.end && event.title);
    if (match) return match;
  }
  return undefined;
}
const key = (channel: string) => `channel:${channel}`;

function validEvent(value: unknown): value is ProgramEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<ProgramEvent>;
  return typeof event.id === 'number' && typeof event.title === 'string' &&
    typeof event.description === 'string' && typeof event.start === 'number' &&
    typeof event.end === 'number' && Number.isFinite(event.start) && Number.isFinite(event.end);
}

export function mergeEpg(existing: EpgMap, programs: Record<number, ProgramInfo>, now = Date.now()): EpgMap {
  const result: EpgMap = {};
  for (const [id, program] of Object.entries(programs)) {
    const events = new Map<string, ProgramEvent>();
    for (const event of [...(existing[Number(id)] ?? []), ...program.future, program.current, program.next]) {
      if (validEvent(event) && event.end! > now)
        events.set(`${event.id}:${event.start}`, event);
    }
    if (events.size) result[Number(id)] = [...events.values()].sort((a, b) => a.start! - b.start!);
  }
  // Preserve services that have not sent SI in this reception window.
  for (const [id, events] of Object.entries(existing))
    if (!(Number(id) in result) && !(Number(id) in programs)) {
      const remaining = events.filter((event) => validEvent(event) && event.end! > now);
      if (remaining.length) result[Number(id)] = remaining;
    }
  return result;
}

export async function loadEpg(channel: string): Promise<EpgMap> {
  const value = await loadValue<unknown>(key(channel), epgStore);
  if (!value || typeof value !== 'object') return {};
  const result: EpgMap = {};
  for (const [id, events] of Object.entries(value))
    if (Number.isInteger(Number(id)) && Array.isArray(events))
      result[Number(id)] = events.filter((event) => validEvent(event) && event.end! > Date.now());
  return result;
}

export async function saveEpg(channel: string, epg: EpgMap): Promise<void> {
  await saveValue(key(channel), epg, epgStore);
}
