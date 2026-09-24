import { describe, expect, it } from 'vitest';
import { ProgramInformation } from '../src/transport/program-info';
import { TsAnalyzer } from '../src/transport/analyzer';
import { mpegCrc32 } from '../src/transport/psi';

const sid = 0x401;
const arib = (value: number[] | string) => [
  0x0e,
  0x89,
  ...(typeof value === 'string' ? [...Buffer.from(value)] : value),
];
const descriptor = (tag: number, bytes: number[]) => [tag, bytes.length, ...bytes];
function section(
  table: number,
  id: number,
  body: number[],
  number = 0,
  current = true,
): Uint8Array {
  const bytes = Uint8Array.from([
    table,
    0xb0,
    0,
    id >> 8,
    id & 255,
    current ? 0xc1 : 0xc0,
    number,
    1,
    ...body,
    0,
    0,
    0,
    0,
  ]);
  const length = bytes.length - 3;
  bytes[1]! |= length >> 8;
  bytes[2]! = length & 255;
  new DataView(bytes.buffer).setUint32(bytes.length - 4, mpegCrc32(bytes.subarray(0, -4)));
  return bytes;
}
function sdt(id = sid, name = arib('Station')): Uint8Array {
  const d = descriptor(0x48, [0xc0, 0, name.length, ...name]);
  return section(0x42, 1, [
    0,
    1,
    255,
    id >> 8,
    id & 255,
    3,
    0x80 | (d.length >> 8),
    d.length & 255,
    ...d,
  ]);
}
function eit({
  id = sid,
  title = 'News',
  description = 'Today',
  number = 0,
  table = 0x4e,
  current = true,
  empty = false,
  date = Date.UTC(2026, 8, 16),
} = {}): Uint8Array {
  const name = arib(title),
    summary = arib(description);
  const d = descriptor(0x4d, [0x6a, 0x70, 0x6e, name.length, ...name, summary.length, ...summary]);
  const mjd = 40587 + Math.floor(date / 86400000);
  return section(
    table,
    id,
    [
      0,
      1,
      0,
      1,
      1,
      table,
      ...(empty
        ? []
        : [
            0,
            7,
            mjd >> 8,
            mjd & 255,
            0x20,
            0x30,
            0,
            1,
            0,
            0,
            0x80 | (d.length >> 8),
            d.length & 255,
            ...d,
          ]),
    ],
    number,
    current,
  );
}
function packet(pid: number, payload: Uint8Array | number[], cc = 0, start = true): Uint8Array {
  const bytes = new Uint8Array(188).fill(255);
  const data = Uint8Array.from(payload);
  const adaptationLength = 183 - data.length;
  if (adaptationLength < 0) throw new Error('payload too long for one packet');
  bytes.set([0x47, (start ? 0x40 : 0) | (pid >> 8), pid & 255, 0x30 | cc, adaptationLength]);
  if (adaptationLength) bytes[5] = 0;
  bytes.set(data, 5 + adaptationLength);
  return bytes;
}
const single = (pid: number, bytes: Uint8Array, cc = 0) => packet(pid, [0, ...bytes], cc);
const snapshot = (info: ProgramInformation, id = sid) => info.snapshot()[id];

describe('program information', () => {
  it('collects future schedule EIT and ignores other-network schedule', () => {
    const info = new ProgramInformation();
    info.pushPacket(
      single(0x12, eit({ table: 0x50, title: 'Future', date: Date.UTC(2027, 0, 1) })),
    );
    info.pushPacket(
      single(0x12, eit({ table: 0x60, title: 'Other', date: Date.UTC(2027, 0, 1) }), 1),
    );
    expect(snapshot(info)?.future.map((event) => event.title)).toEqual(['Future']);
  });
  it('decodes station name and present/following with JST times for the selected service', () => {
    const info = new ProgramInformation();
    // JIS kanji 日本 + katakana テレビ.
    info.pushPacket(single(0x11, sdt(sid, [0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x6f, 0x46, 0x6c, 0x53])));
    info.pushPacket(single(0x27, eit()));
    info.pushPacket(single(0x27, eit({ number: 1, title: 'Next' }), 1));
    const result = snapshot(info)!;
    expect(result.stationName).toBe('日本テレビ');
    expect(result.current?.title).toBe('News');
    expect(result.current?.description).toBe('Today');
    expect(result.current?.start).toBe(Date.UTC(2026, 8, 16, 11, 30));
    expect(result.current?.end).toBe(Date.UTC(2026, 8, 16, 12, 30));
    expect(result.next?.title).toBe('Next');
    expect(snapshot(info, sid + 1)?.current).toBeUndefined();
  });
  it('assembles split sections and uses pointer bytes to complete a preceding section', () => {
    const info = new ProgramInformation();
    const first = eit(),
      next = eit({ number: 1, title: 'Following' });
    info.pushPacket(packet(0x12, [0, ...first.slice(0, 20)], 15));
    info.pushPacket(packet(0x12, [first.length - 20, ...first.slice(20), ...next], 0));
    const result = snapshot(info)!;
    expect(result.current?.title).toBe('News');
    expect(result.next?.title).toBe('Following');
  });
  it('discards CRC errors, future tables and other-transport events', () => {
    const info = new ProgramInformation();
    const damaged = eit();
    damaged[20]! ^= 1;
    for (const [cc, bytes] of [damaged, eit({ current: false }), eit({ table: 0x4f })].entries()) {
      info.pushPacket(single(0x27, bytes, cc));
      expect(snapshot(info)?.current ?? null).toBeNull();
    }
  });
  it('missing packets and discontinuities cannot combine fragments', () => {
    const info = new ProgramInformation(),
      bytes = eit();
    const first = packet(0x27, [0, ...bytes.slice(0, 20)], 0);
    info.pushPacket(first);
    info.pushPacket(first); // duplicate
    info.pushPacket(packet(0x27, bytes.slice(20), 2, false));
    expect(snapshot(info)?.current ?? null).toBeNull();
    info.pushPacket(first);
    info.resetFragments();
    info.pushPacket(packet(0x27, bytes.slice(20), 1, false));
    expect(snapshot(info)?.current ?? null).toBeNull();
    info.pushPacket(single(0x27, bytes, 3));
    expect(snapshot(info)?.current?.title).toBe('News');
  });
  it('a new present section replaces the event; an empty section clears it', () => {
    const info = new ProgramInformation();
    info.pushPacket(single(0x27, eit()));
    info.pushPacket(single(0x27, eit({ title: 'Updated' }), 1));
    expect(snapshot(info)?.current?.title).toBe('Updated');
    info.pushPacket(single(0x27, eit({ empty: true }), 2));
    expect(snapshot(info)?.current ?? null).toBeNull();
  });
  it('NIT provides a station fallback when SDT is absent, and SDT takes priority', () => {
    const info = new ProgramInformation();
    const name = arib('Network');
    const d = descriptor(0xcd, [4, (name.length << 2) | 1, ...name, 0, 1, sid >> 8, sid & 255]);
    const transport = [0, 1, 0, 1, 0xf0, d.length, ...d];
    const nit = section(0x40, 1, [0xf0, 0, 0xf0, transport.length, ...transport]);
    info.pushPacket(single(0x10, nit));
    expect(snapshot(info)?.stationName).toBe('Network');
    info.pushPacket(single(0x11, sdt()));
    expect(snapshot(info)?.stationName).toBe('Station');
  });
  it('flows through TsAnalyzer snapshots without disturbing PAT/PMT', () => {
    const analyzer = new TsAnalyzer();
    const scrambled = single(0x11, sdt());
    scrambled[3]! |= 0x80;
    analyzer.push(scrambled);
    expect(analyzer.snapshot().programs).toEqual({});
    analyzer.push(single(0x11, sdt()));
    analyzer.push(single(0x27, eit()));
    const programs = analyzer.snapshot().programs;
    expect(programs[sid]?.stationName).toBe('Station');
    expect(programs[sid]?.current?.title).toBe('News');
    expect(analyzer.psi.services).toEqual([]);
  });
});
