import { describe, expect, it } from 'vitest';
import { currentChannelProgram, mergeEpg } from '../src/epg';
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
});
