export type Broadcast = 'T' | 'BS' | 'CS';
export type Channel = number | string;

export const TERRESTRIAL_CHANNELS = Array.from({ length: 50 }, (_, i) => i + 13);
// ISDB-S TMCC has up to 12 transport streams per transponder.
// ponytail: scan candidate slots individually; cache TMCC per transponder if scan time becomes an issue.
export const satelliteChannels = (band: 'BS' | 'CS'): string[] =>
  Array.from({ length: 12 }, (_, i) =>
    Array.from({ length: 12 }, (_, slot) => `${band}${i * 2 + (band === 'BS' ? 1 : 2)}_${slot}`),
  ).flat();

export function parseChannel(channel: Channel) {
  const value = String(channel);
  if (/^\d+$/.test(value)) {
    const physical = Number(value);
    if (physical >= 13 && physical <= 62)
      return { band: 'T' as const, frequencyKHz: 473143 + (physical - 13) * 6000, slot: 0 };
  }
  const match = /^(BS|CS)(\d+)_(\d+)$/.exec(value);
  if (match) {
    const band = match[1] as 'BS' | 'CS';
    const physical = Number(match[2]);
    const slot = Number(match[3]);
    if (physical >= 1 && physical <= 24 && physical % 2 === (band === 'BS' ? 1 : 0) && slot < 12)
      return {
        band,
        frequencyKHz:
          band === 'BS'
            ? 1049480 + ((physical - 1) / 2) * 38360
            : 1613000 + ((physical - 2) / 2) * 40000,
        slot,
      };
  }
  throw new Error('Invalid channel (UHF 13–62, BS1_0–BS23_11, CS2_0–CS24_11)');
}

export const channelsFor = (band: Broadcast): Channel[] =>
  band === 'T' ? TERRESTRIAL_CHANNELS : satelliteChannels(band);
