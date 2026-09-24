import type { ProgramEvent, ProgramInfo } from './transport/program-info';
import { epgStore, loadValue, saveValue } from './storage';

export type EpgMap = Record<number, ProgramEvent[]>;

/**
 * One entry per event_id; later entries are newer. A broadcaster reschedule keeps the
 * event_id but moves start/end, so the newest timing wins. Text is kept from an older
 * copy while the newer one arrives without a short event descriptor.
 */
function collapseEvents(events: Iterable<ProgramEvent | null | undefined>): ProgramEvent[] {
  const byId = new Map<number, ProgramEvent>();
  for (const event of events) {
    if (!event) continue;
    const known = byId.get(event.id);
    byId.set(
      event.id,
      !event.title && known?.title ? { ...event, title: known.title, description: known.description, genres: event.genres.length ? event.genres : known.genres } : event,
    );
  }
  return [...byId.values()];
}

const overlaps = (a: ProgramEvent, b: ProgramEvent) => a.start! < b.end! && b.start! < a.end!;

export function timelineEvents(events: (ProgramEvent | null)[], now: number, start = now, hourWidth = 100) {
  const msPerPx = 3600000 / hourWidth;
  const end = start + 24 * 3600000;
  return collapseEvents(
    events.filter(
      (event) =>
        event?.start != null && event.end != null && event.end > now && event.start < end && event.end > event.start,
    ),
  )
    .sort((a, b) => a.start! - b.start!)
    .map((event) => ({
      event,
      left: (Math.max(event.start!, start) - start) / msPerPx,
      width: (Math.min(event.end!, end) - Math.max(event.start!, start)) / msPerPx,
    }));
}
export type TimelineItem = ReturnType<typeof timelineEvents>[number] & {
  serviceId?: number;
  /** Vertical slot within the row while services air different programs. */
  lane?: number;
  lanes?: number;
};

const sameProgram = (a: ProgramEvent, b: ProgramEvent) =>
  a.start === b.start && a.end === b.end && a.title === b.title;

/**
 * One station's timeline across its services (main first). Sub-service
 * programs identical to the main one are dropped, so a row normally stays
 * single; where they differ (multi-channel slots) the overlapping programs
 * share the row height in lanes, main on top.
 */
export function stationTimeline(
  services: { serviceId: number; events: (ProgramEvent | null)[] }[],
  now: number,
  start = now,
  hourWidth = 100,
): TimelineItem[] {
  const [main, ...subs] = services.map((service) => ({
    serviceId: service.serviceId,
    items: timelineEvents(service.events, now, start, hourWidth),
  }));
  if (!main) return [];
  const distinct = subs
    .map((sub) => ({
      ...sub,
      // Untitled events are placeholders, not a different program.
      items: sub.items.filter(
        (item) =>
          item.event.title && !main.items.some((other) => sameProgram(other.event, item.event)),
      ),
    }))
    .filter((sub) => sub.items.length);
  if (!distinct.length) return main.items;
  const all = [main, ...distinct];
  return all
    .flatMap((service) =>
      service.items.map((item) => {
        // The main service always airs; others count where they overlap this program.
        const active = all.filter(
          (other, index) =>
            index === 0 ||
            other === service ||
            other.items.some((next) => overlaps(next.event, item.event)),
        );
        return {
          ...item,
          serviceId: service.serviceId,
          lane: active.indexOf(service),
          lanes: active.length,
        };
      }),
    )
    .sort((a, b) => a.lane - b.lane || a.left - b.left);
}

export function currentChannelProgram(epg: EpgMap | undefined, serviceIds: number[], now: number): ProgramEvent | undefined {
  for (const id of serviceIds) {
    const match = epg?.[id]?.find((event) => event.start != null && event.start <= now && event.end != null && now < event.end && event.title);
    if (match) return match;
  }
  return undefined;
}
export function currentServiceProgram(live: ProgramEvent | null | undefined, epg: EpgMap | undefined, serviceId: number, now: number) {
  return live?.title && (live.start == null || live.start <= now) && (live.end == null || live.end > now)
    ? live
    : currentChannelProgram(epg, [serviceId], now);
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
    const valid = (event: ProgramEvent | null): event is ProgramEvent => validEvent(event) && event.end! > now;
    const received = collapseEvents([...program.future, program.current, program.next].filter(valid));
    const receivedIds = new Set(received.map((event) => event.id));
    // Stored events superseded by a reschedule: a different event now occupies their slot.
    const stored = (existing[Number(id)] ?? []).filter(
      (event) => valid(event) && (receivedIds.has(event.id) || !received.some((next) => overlaps(event, next))),
    );
    const events = collapseEvents([...stored, ...received]);
    if (events.length) result[Number(id)] = events.sort((a, b) => a.start! - b.start!);
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
