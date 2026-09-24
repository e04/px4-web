import { expect, it } from 'vitest';
import { channelsFor, parseChannel } from '../src/channels';

it('maps terrestrial and satellite channel/slot selections to px4_drv IF frequencies', () => {
  expect(parseChannel(13)).toEqual({ band: 'T', frequencyKHz: 473143, slot: 0 });
  expect(parseChannel('62').frequencyKHz).toBe(767143);
  expect(parseChannel('BS1_0')).toEqual({ band: 'BS', frequencyKHz: 1049480, slot: 0 });
  expect(parseChannel('BS23_11')).toEqual({ band: 'BS', frequencyKHz: 1471440, slot: 11 });
  expect(parseChannel('CS2_0')).toEqual({ band: 'CS', frequencyKHz: 1613000, slot: 0 });
  expect(parseChannel('CS24_11').frequencyKHz).toBe(2053000);
  for (const band of ['T', 'BS', 'CS'] as const) {
    const channels = channelsFor(band);
    expect(new Set(channels).size).toBe(channels.length);
    for (const channel of channels) expect(parseChannel(channel).band).toBe(band);
  }
  for (const channel of [
    12,
    63,
    13.5,
    NaN,
    '',
    'BS2_0',
    'CS1_0',
    'BS25_0',
    'CS26_0',
    'BS1_12',
    'BS1_-1',
  ])
    expect(() => parseChannel(channel)).toThrow('Invalid channel');
});
