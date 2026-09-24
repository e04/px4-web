/** Station logo as carried in CDT (ARIB STD-B21 / TR-B14). */
export interface LogoData {
  networkId: number;
  logoId: number;
  /** logo_type 0–5; see LOGO_PRIORITY. */
  type: number;
  version: number;
  /** Self-contained PNG (the common CLUT already inserted). */
  png: Uint8Array;
}

/** SDT logo_transmission_descriptor reference for a service. */
export interface LogoRef {
  networkId: number;
  logoId: number;
}

export const logoKey = (ref: LogoRef) => `${ref.networkId}:${ref.logoId}`;

// logo_type: 0 SD4:3 small 48x24, 1 SD16:9 small 36x24, 2 HD small 48x27,
// 3 SD4:3 large 72x36, 4 SD16:9 large 54x36, 5 HD large 64x36.
// HD types have square pixels, so they look best; larger wins otherwise.
const LOGO_PRIORITY = [0, 1, 4, 2, 3, 5];
export const betterLogo = (candidate: LogoData, known: LogoData | undefined) =>
  !known ||
  candidate.version !== known.version ||
  LOGO_PRIORITY[candidate.type]! > LOGO_PRIORITY[known.type]!;

// ARIB STD-B24 common fixed CLUT: 0–7 full primaries, 8 transparent, 9–15 at 0xAA,
// 16–64 the remaining 0x00/55/AA/FF mixes, 65–127 = 0–7,9–64 at half alpha.
const CLUT: [number, number, number, number][] = (() => {
  const primaries = (level: number) =>
    Array.from({ length: 8 }, (_, i): [number, number, number, number] => [
      i & 1 ? level : 0,
      i & 2 ? level : 0,
      i & 4 ? level : 0,
      255,
    ]);
  const opaque = [...primaries(255), [0, 0, 0, 0] as [number, number, number, number]];
  opaque.push(...primaries(0xaa).slice(1));
  const levels = [0, 0x55, 0xaa, 0xff];
  for (const r of levels)
    for (const g of levels)
      for (const b of levels) {
        const rgb = [r, g, b];
        if (rgb.every((v) => v === 0 || v === 0xff) || rgb.every((v) => v === 0 || v === 0xaa))
          continue;
        opaque.push([r, g, b, 255]);
      }
  const half = opaque
    .filter((_, i) => i !== 8)
    .map(([r, g, b]) => [r, g, b, 0x80] as (typeof opaque)[number]);
  return [...opaque, ...half].slice(0, 128);
})();

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Broadcast logos are indexed PNGs without PLTE/tRNS; receivers apply the common
 * CLUT. Insert both after IHDR so a browser can decode the image. Returns
 * undefined for data that is not a PNG.
 */
export function completeLogoPng(data: Uint8Array): Uint8Array | undefined {
  if (data.length < 33 || PNG_SIGNATURE.some((byte, i) => data[i] !== byte)) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chunkType = (offset: number) =>
    String.fromCharCode(...data.subarray(offset + 4, offset + 8));
  if (chunkType(8) !== 'IHDR') return undefined;
  const ihdrEnd = 8 + 12 + view.getUint32(8);
  for (let offset = ihdrEnd; offset + 8 <= data.length; offset += 12 + view.getUint32(offset)) {
    const type = chunkType(offset);
    if (type === 'PLTE') return data;
    if (type === 'IDAT') break;
  }
  const plte = new Uint8Array(CLUT.length * 3);
  const trns = new Uint8Array(CLUT.length);
  CLUT.forEach(([r, g, b, a], i) => {
    plte.set([r, g, b], i * 3);
    trns[i] = a;
  });
  const plteChunk = chunk('PLTE', plte);
  const trnsChunk = chunk('tRNS', trns);
  const out = new Uint8Array(data.length + plteChunk.length + trnsChunk.length);
  out.set(data.subarray(0, ihdrEnd));
  out.set(plteChunk, ihdrEnd);
  out.set(trnsChunk, ihdrEnd + plteChunk.length);
  out.set(data.subarray(ihdrEnd), ihdrEnd + plteChunk.length + trnsChunk.length);
  return out;
}

export function logoDataUrl(png: Uint8Array): string {
  let binary = '';
  for (const byte of png) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}
