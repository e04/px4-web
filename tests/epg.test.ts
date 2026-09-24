import { describe, expect, it } from 'vitest';
import {
  currentChannelProgram,
  currentServiceProgram,
  mergeEpg,
  stationTimeline,
  timelineEvents,
} from '../src/epg';
import type { ProgramEvent, ProgramInfo } from '../src/transport/program-info';

describe('EPG merge', () => {
  it('selects only a program airing now for a channel service', () => {
    const event: ProgramEvent = {
      id: 1,
      title: 'On air',
      description: '',
      genres: [],
      start: 100,
      end: 200,
    };
    expect(currentChannelProgram({ 10: [event] }, [10], 150)?.title).toBe('On air');
    expect(currentChannelProgram({ 10: [event] }, [10], 200)).toBeUndefined();
    expect(currentChannelProgram({ 10: [event] }, [11], 150)).toBeUndefined();
  });
  it('retains unreceived future programs and updates matching events', () => {
    const event: ProgramEvent = {
      id: 1,
      title: 'Old',
      description: '',
      genres: [],
      start: 200,
      end: 300,
    };
    const program: ProgramInfo = {
      serviceId: 10,
      stationName: '',
      current: null,
      next: null,
      future: [
        { ...event, title: 'Updated' },
        { id: 2, title: 'Later', description: '', genres: [], start: 400, end: 500 },
      ],
    };
    expect(mergeEpg({ 10: [event], 11: [{ ...event, id: 3 }] }, { 10: program }, 100)).toEqual({
      10: [{ ...event, title: 'Updated' }, program.future[1]],
      11: [{ ...event, id: 3 }],
    });
  });
  it('keeps the known current title while live EIT temporarily lacks it', () => {
    const event: ProgramEvent = {
      id: 1,
      title: 'On air',
      description: '',
      genres: [],
      start: 100,
      end: 200,
    };
    const blank = { ...event, title: '' };
    const epg = { 10: [event] };
    expect(currentServiceProgram(null, epg, 10, 150)).toEqual(event);
    expect(currentServiceProgram(blank, epg, 10, 150)).toEqual(event);
    expect(currentServiceProgram(null, epg, 10, 200)).toBeUndefined();
    expect(
      mergeEpg(
        epg,
        { 10: { serviceId: 10, stationName: '', current: blank, next: null, future: [] } },
        150,
      )[10],
    ).toEqual([event]);
  });
});

describe('24-hour program timeline', () => {
  it('positions programs at 100px/hour, clips the window, and deduplicates live EIT', () => {
    const hour = 3600000;
    const event: ProgramEvent = {
      id: 1,
      title: 'Now',
      description: '',
      genres: [],
      start: -hour,
      end: hour,
    };
    const later: ProgramEvent = {
      id: 2,
      title: 'Later',
      description: '',
      start: 2 * hour,
      end: 25 * hour,
    };
    expect(
      timelineEvents(
        [event, later, { ...event, title: 'Updated' }, { ...event, title: '' }, null],
        0,
      ),
    ).toEqual([
      { event: { ...event, title: 'Updated' }, left: 0, width: 100 },
      { event: later, left: 200, width: 2200 },
    ]);
    expect(timelineEvents([event, later], hour / 2, 0)).toEqual([
      { event, left: 0, width: 100 },
      { event: later, left: 200, width: 2200 },
    ]);
  });
});

describe('rescheduled programs', () => {
  const min = 60000;
  const ev = (id: number, title: string, start: number, end: number): ProgramEvent => ({
    id,
    title,
    description: '',
    genres: [],
    start: start * min,
    end: end * min,
  });
  const info = (future: ProgramEvent[]): ProgramInfo => ({
    serviceId: 10,
    stationName: '',
    current: null,
    next: null,
    future,
  });

  it('moves an event to its new time instead of keeping both copies', () => {
    const stored = [ev(1, 'A', 0, 54), ev(2, 'B', 54, 60), ev(3, 'C', 60, 75), ev(4, 'D', 75, 85)];
    // Everything slides 5 minutes; D (4) was dropped and C now runs until 85.
    const shifted = [ev(1, 'A', 5, 59), ev(2, '', 59, 65), ev(3, 'C', 65, 85)];
    expect(mergeEpg({ 10: stored }, { 10: info(shifted) }, 0)[10]).toEqual([
      ev(1, 'A', 5, 59),
      ev(2, 'B', 59, 65),
      ev(3, 'C', 65, 85),
    ]);
  });

  it('shows one block per event on the timeline', () => {
    const events = timelineEvents([ev(1, 'A', 0, 54), ev(1, 'A', 5, 59)], 0);
    expect(events.map((item) => item.event.start)).toEqual([5 * min]);
  });
});

describe('station timeline', () => {
  const event = (id: number, title: string, start: number, end: number): ProgramEvent => ({
    id,
    title,
    description: '',
    start,
    end,
  });
  const lanes = (items: ReturnType<typeof stationTimeline>) =>
    items.map((item) => [
      item.event.title,
      item.serviceId ?? null,
      item.lane ?? 0,
      item.lanes ?? 1,
    ]);

  it('stays a single lane while sub-services simulcast the main one', () => {
    const main = [event(1, 'News', 0, 3600000), event(2, 'Drama', 3600000, 7200000)];
    const sub = [event(11, 'News', 0, 3600000), event(12, 'Drama', 3600000, 7200000)];
    expect(
      lanes(
        stationTimeline(
          [
            { serviceId: 1024, events: main },
            { serviceId: 1025, events: sub },
          ],
          0,
        ),
      ),
    ).toEqual([
      ['News', null, 0, 1],
      ['Drama', null, 0, 1],
    ]);
  });

  it('splits only the programs overlapping a different sub-service program', () => {
    const main = [event(1, 'News', 0, 3600000), event(2, 'Baseball', 3600000, 7200000)];
    const sub = [event(11, 'News', 0, 3600000), event(12, 'Anime', 3600000, 7200000)];
    expect(
      lanes(
        stationTimeline(
          [
            { serviceId: 1024, events: main },
            { serviceId: 1025, events: sub },
          ],
          0,
        ),
      ),
    ).toEqual([
      ['News', 1024, 0, 1],
      ['Baseball', 1024, 0, 2],
      ['Anime', 1025, 1, 2],
    ]);
  });

  it('ignores untitled sub-service placeholders', () => {
    const main = [event(1, 'News', 0, 3600000)];
    const sub = [event(11, '', 0, 3600000)];
    expect(
      lanes(
        stationTimeline(
          [
            { serviceId: 1024, events: main },
            { serviceId: 1025, events: sub },
          ],
          0,
        ),
      ),
    ).toEqual([['News', null, 0, 1]]);
  });
});
