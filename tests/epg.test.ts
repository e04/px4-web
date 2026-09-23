import { describe, expect, it } from 'vitest';
import { currentChannelProgram, currentServiceProgram, mergeEpg, timelineEvents } from '../src/epg';
import type { ProgramEvent, ProgramInfo } from '../src/transport/program-info';

describe('EPG merge', () => {
  it('selects only a program airing now for a channel service', () => {
    const event: ProgramEvent = { id: 1, title: 'On air', description: '', start: 100, end: 200 };
    expect(currentChannelProgram({ 10: [event] }, [10], 150)?.title).toBe('On air');
    expect(currentChannelProgram({ 10: [event] }, [10], 200)).toBeUndefined();
    expect(currentChannelProgram({ 10: [event] }, [11], 150)).toBeUndefined();
  });
  it('retains unreceived future programs and updates matching events', () => {
    const event: ProgramEvent = { id: 1, title: 'Old', description: '', start: 200, end: 300 };
    const program: ProgramInfo = {
      serviceId: 10, stationName: '', current: null, next: null,
      future: [{ ...event, title: 'Updated' }, { id: 2, title: 'Later', description: '', start: 400, end: 500 }],
    };
    expect(mergeEpg({ 10: [event], 11: [{ ...event, id: 3 }] }, { 10: program }, 100)).toEqual({
      10: [{ ...event, title: 'Updated' }, program.future[1]],
      11: [{ ...event, id: 3 }],
    });
  });
  it('keeps the known current title while live EIT temporarily lacks it', () => {
    const event: ProgramEvent = { id: 1, title: 'On air', description: '', start: 100, end: 200 };
    const blank = { ...event, title: '' };
    const epg = { 10: [event] };
    expect(currentServiceProgram(null, epg, 10, 150)).toEqual(event);
    expect(currentServiceProgram(blank, epg, 10, 150)).toEqual(event);
    expect(currentServiceProgram(null, epg, 10, 200)).toBeUndefined();
    expect(mergeEpg(epg, { 10: { serviceId: 10, stationName: '', current: blank, next: null, future: [] } }, 150)[10]).toEqual([event]);
  });
});

describe('24-hour program timeline', () => {
  it('positions programs at 100px/hour, clips the window, and deduplicates live EIT', () => {
    const hour = 3600000;
    const event: ProgramEvent = { id: 1, title: 'Now', description: '', start: -hour, end: hour };
    const later: ProgramEvent = {
      id: 2, title: 'Later', description: '', start: 2 * hour, end: 25 * hour,
    };
    expect(timelineEvents([event, later, { ...event, title: 'Updated' }, { ...event, title: '' }, null], 0)).toEqual([
      { event: { ...event, title: 'Updated' }, left: 0, width: 100 },
      { event: later, left: 200, width: 2200 },
    ]);
    expect(timelineEvents([event, later], hour / 2, 0)).toEqual([
      { event, left: 0, width: 100 },
      { event: later, left: 200, width: 2200 },
    ]);
  });
});
