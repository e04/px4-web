import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { completeLogoPng } from '../src/logo';
import { ProgramInformation } from '../src/transport/program-info';
import { mpegCrc32 } from '../src/transport/psi';

function pngChunk(type: string, data: number[] | Uint8Array): number[] {
  const body = [...Buffer.from(type, 'latin1'), ...data];
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.set(body, 4);
  out.writeUInt32BE(crc32(Uint8Array.from(body)), 8 + data.length);
  return [...out];
}
// 2x1 indexed PNG without PLTE, as broadcast: pixel 1 (red), pixel 8 (transparent).
const logoPng = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...pngChunk('IHDR', [0, 0, 0, 2, 0, 0, 0, 1, 8, 3, 0, 0, 0]),
  ...pngChunk('IDAT', deflateSync(Uint8Array.from([0, 1, 8]))),
  ...pngChunk('IEND', []),
]);

function chunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const result: { type: string; data: Uint8Array; crcOk: boolean }[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    const crcOk =
      crc32(png.subarray(offset + 4, offset + 8 + length)) === view.getUint32(offset + 8 + length);
    result.push({ type, data, crcOk });
    offset += 12 + length;
  }
  return result;
}

describe('station logos', () => {
  it('inserts the ARIB common CLUT as PLTE/tRNS after IHDR', () => {
    const png = completeLogoPng(logoPng)!;
    const list = chunks(png);
    expect(list.map((c) => c.type)).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
    expect(list.every((c) => c.crcOk)).toBe(true);
    const [plte, trns] = [list[1]!.data, list[2]!.data];
    expect(plte.length).toBe(128 * 3);
    expect([...plte.subarray(3, 6)]).toEqual([255, 0, 0]);
    expect([...plte.subarray(9 * 3, 10 * 3)]).toEqual([0xaa, 0, 0]);
    expect([...plte.subarray(16 * 3, 17 * 3)]).toEqual([0, 0, 0x55]);
    expect([...plte.subarray(64 * 3, 65 * 3)]).toEqual([0xff, 0xff, 0xaa]);
    expect([...plte.subarray(127 * 3)]).toEqual([0xff, 0xff, 0x55]);
    expect([trns[0], trns[8], trns[64], trns[65], trns[127]]).toEqual([255, 0, 255, 0x80, 0x80]);
    // Already complete or not a PNG.
    expect(completeLogoPng(png)).toBe(png);
    expect(completeLogoPng(new Uint8Array(40))).toBeUndefined();
  });

  it('links SDT logo references to CDT logo data', () => {
    const section = (table: number, id: number, body: number[], number = 0) => {
      const bytes = Uint8Array.from([
        table,
        0xb0,
        0,
        id >> 8,
        id & 255,
        0xc1,
        number,
        1,
        ...body,
        0,
        0,
        0,
        0,
      ]);
      bytes[2] = bytes.length - 3;
      new DataView(bytes.buffer).setUint32(bytes.length - 4, mpegCrc32(bytes.subarray(0, -4)));
      return bytes;
    };
    const packet = (pid: number, bytes: Uint8Array, cc: number) => {
      const out = new Uint8Array(188).fill(255);
      out.set([0x47, 0x40 | (pid >> 8), pid & 255, 0x10 | cc, 0, ...bytes]);
      return out;
    };
    const onid = 0x7fe0,
      sid = 0x400,
      logoId = 0x123;
    const logo = [0xcf, 7, 1, 0xfe | (logoId >> 8), logoId & 255, 0xf0, 2, 0, 5];
    const sdt = section(0x42, 1, [
      onid >> 8,
      onid & 255,
      255,
      sid >> 8,
      sid & 255,
      3,
      0x80,
      logo.length,
      ...logo,
    ]);
    const cdt = (type: number, number: number) =>
      section(
        0xc8,
        5,
        [
          onid >> 8,
          onid & 255,
          1,
          0xf0,
          0,
          type,
          0xfe | (logoId >> 8),
          logoId & 255,
          0xf0,
          2,
          0,
          logoPng.length,
          ...logoPng,
        ],
        number,
      );
    const info = new ProgramInformation();
    info.pushPacket(packet(0x11, sdt, 0));
    info.pushPacket(packet(0x29, cdt(2, 0), 0));
    info.pushPacket(packet(0x29, cdt(5, 1), 1));
    info.pushPacket(packet(0x29, cdt(0, 0), 2));
    expect(info.snapshot()[sid]?.logo).toEqual({ networkId: onid, logoId });
    const logos = info.logos();
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatchObject({ networkId: onid, logoId, type: 5, version: 2 });
    expect(chunks(logos[0]!.png).map((c) => c.type)).toContain('PLTE');
  });
});
