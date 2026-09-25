import { describe, expect, it } from 'vitest';
import { AribKey, aribKeyFromEvent } from '../src/media/data-keys';
import { ServiceFilter } from '../src/media/service-filter';
import { mpegCrc32 } from '../src/transport/psi';

function section(table: number, id: number, body: number[]): Uint8Array {
  const n = body.length + 9;
  const s = new Uint8Array([
    table,
    0xb0 | (n >> 8),
    n & 255,
    id >> 8,
    id & 255,
    0xc1,
    0,
    0,
    ...body,
  ]);
  const crc = mpegCrc32(s);
  return new Uint8Array([...s, crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]);
}
function packet(pid: number, data?: Uint8Array): Uint8Array {
  const p = new Uint8Array(188).fill(255);
  p.set([0x47, (pid >> 8) | (data ? 0x40 : 0), pid & 255, 0x10]);
  if (data) p.set([0, ...data], 4);
  return p;
}
function pcrPacket(pid: number): Uint8Array {
  const p = packet(pid);
  p[3] = 0x30;
  p.set([7, 0x10, 0, 0, 0, 0, 0, 0], 4);
  return p;
}
const stream = (type: number, pid: number) => [type, 0xe0 | (pid >> 8), pid & 255, 0xf0, 0];
// Service 1: video 0x101 (also PCR), AAC 0x110, carousel 0x140. Service 2: carousel 0x240.
const psi = [
  packet(0, section(0, 10, [0, 1, 0xe1, 0, 0, 2, 0xe2, 0])),
  packet(
    0x100,
    section(2, 1, [
      0xe1,
      1,
      0xf0,
      0,
      ...stream(2, 0x101),
      ...stream(0x0f, 0x110),
      ...stream(0x0d, 0x140),
    ]),
  ),
  packet(0x200, section(2, 2, [0xe2, 1, 0xf0, 0, ...stream(2, 0x201), ...stream(0x0d, 0x240)])),
];
const payload = [
  packet(0x11),
  packet(0x12),
  packet(0x14),
  packet(0x24),
  packet(0x10),
  packet(0x101),
  pcrPacket(0x101),
  packet(0x110),
  packet(0x140),
  packet(0x240),
];
const join = (packets: Uint8Array[]) => {
  const bytes = new Uint8Array(packets.length * 188);
  packets.forEach((p, i) => bytes.set(p, i * 188));
  return bytes;
};
const pids = (bytes: Uint8Array) =>
  Array.from(
    { length: bytes.length / 188 },
    (_, i) => ((bytes[i * 188 + 1] & 31) << 8) | bytes[i * 188 + 2],
  );

describe('ServiceFilter data broadcasting tap', () => {
  it('collects SI, the PMT, PCRs and DSM-CC streams of the selected service', () => {
    const plain = new ServiceFilter(1);
    plain.push(join(psi));
    const expected = plain.push(join(payload));
    const filter = new ServiceFilter(1);
    filter.dataEnabled = true;
    filter.push(join(psi));
    expect(pids(filter.takeData())).toEqual([0x100]);
    expect(filter.push(join(payload))).toEqual(expected);
    const data = filter.takeData();
    expect(pids(data)).toEqual([0x11, 0x12, 0x14, 0x24, 0x101, 0x140]);
    expect(data.subarray(4 * 188, 5 * 188)).toEqual(pcrPacket(0x101));
    expect(filter.takeData().length).toBe(0);
  });
  it('collects nothing while disabled', () => {
    const filter = new ServiceFilter(1);
    filter.push(join([...psi, ...payload]));
    expect(filter.takeData().length).toBe(0);
  });
});

describe('aribKeyFromEvent', () => {
  const event = (key: string, init: Partial<KeyboardEvent> = {}) =>
    ({
      key,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      target: null,
      ...init,
    }) as KeyboardEvent;
  it('maps remote keys', () => {
    expect(aribKeyFromEvent(event('ArrowUp'))).toBe(AribKey.Up);
    expect(aribKeyFromEvent(event('D'))).toBe(AribKey.Data);
    expect(aribKeyFromEvent(event('r'))).toBe(AribKey.Red);
    expect(aribKeyFromEvent(event(' '))).toBe(AribKey.Enter);
    expect(aribKeyFromEvent(event('7'))).toBe(AribKey.Digit0 + 7);
    expect(aribKeyFromEvent(event('q'))).toBeUndefined();
  });
  it('leaves modified keys and form controls to the page', () => {
    expect(aribKeyFromEvent(event('d', { metaKey: true }))).toBeUndefined();
    const button = { closest: () => ({}) } as unknown as EventTarget;
    expect(aribKeyFromEvent(event('ArrowLeft', { target: button }))).toBeUndefined();
    const body = { closest: () => null } as unknown as EventTarget;
    expect(aribKeyFromEvent(event('ArrowLeft', { target: body }))).toBe(AribKey.Left);
  });
});
