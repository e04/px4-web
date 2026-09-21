import { afterEach, describe, expect, it, vi } from 'vitest';
import { Psi, captionPid, mpegCrc32, superimposePid } from '../src/transport/psi';
import { PlaybackDemux, type Pes } from '../src/media/demux';
import type { CaptionPacket } from '../src/media/playback-types';
import { FullSegPlayer } from '../src/media/player';

function join(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
function section(table: number, id: number, body: number[], version = 0): Uint8Array {
  const length = body.length + 9;
  const data = new Uint8Array([
    table,
    0xb0 | (length >>> 8),
    length & 255,
    id >>> 8,
    id & 255,
    0xc1 | (version << 1),
    0,
    0,
    ...body,
  ]);
  const crc = mpegCrc32(data);
  return join(data, new Uint8Array([crc >>> 24, crc >>> 16, crc >>> 8, crc]));
}
const es = (type: number, pid: number, info: number[] = []) => [
  type,
  0xe0 | (pid >>> 8),
  pid & 255,
  0xf0 | (info.length >>> 8),
  info.length & 255,
  ...info,
];
const pat = () => section(0, 10, [0, 1, 0xe1, 0]);
const pmt = () =>
  section(2, 1, [
    0xe1,
    1,
    0xf0,
    0,
    ...es(2, 0x101),
    ...es(0x0f, 0x102),
    ...es(6, 0x103, [0x52, 1, 0x30]),
    ...es(6, 0x104, [0x52, 1, 0x38]),
  ]);
const plainPmt = () =>
  section(2, 1, [0xe1, 1, 0xf0, 0, ...es(2, 0x101), ...es(0x0f, 0x102), ...es(6, 0x105)]);
const start = (s: Uint8Array) => join(new Uint8Array([0]), s);

const cc = new Map<number, number>();
function tsPacket(pid: number, payload: Uint8Array, pusi: boolean): Uint8Array {
  const next = (cc.get(pid) ?? 0) & 15;
  cc.set(pid, next + 1);
  const p = new Uint8Array(188).fill(0xff);
  p[0] = 0x47;
  p[1] = (pusi ? 0x40 : 0) | ((pid >>> 8) & 31);
  p[2] = pid & 255;
  p[3] = 0x10 | next;
  p.set(payload.subarray(0, 184), 4);
  return p;
}
function psiPackets(pid: number, body: Uint8Array): Uint8Array[] {
  const payload = start(body);
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < payload.length; offset += 184)
    out.push(tsPacket(pid, payload.subarray(offset, offset + 184), offset === 0));
  return out;
}
const encodePts = (pts: number) =>
  new Uint8Array([
    0x20 | (((pts >>> 30) & 7) << 1) | 1,
    (pts >>> 22) & 255,
    (((pts >>> 15) & 127) << 1) | 1,
    (pts >>> 7) & 255,
    ((pts & 127) << 1) | 1,
  ]);
function captionPesPacket(pid: number, pts: number, payload: number[]): Uint8Array[] {
  const pes = join(
    new Uint8Array([0, 0, 1, 0xbd, 0, 0, 0x80, 0x80, 5, ...encodePts(pts)]),
    new Uint8Array(payload),
  );
  const length = pes.length - 6;
  pes[4] = length >>> 8;
  pes[5] = length & 255;
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < pes.length; offset += 184)
    out.push(tsPacket(pid, pes.subarray(offset, offset + 184), offset === 0));
  return out;
}

describe('caption PID discovery', () => {
  it('maps stream_identifier tags to caption and superimpose PIDs', () => {
    const psi = new Psi();
    psi.push(0, start(pat()), true);
    psi.push(0x100, start(pmt()), true);
    const service = psi.services.find((s) => s.serviceId === 1)!;
    expect(captionPid(service)).toBe(0x103);
    expect(superimposePid(service, 0x103)).toBe(0x104);
  });
  it('falls back to the first private stream for caption only', () => {
    const psi = new Psi();
    psi.push(0, start(pat()), true);
    psi.push(0x100, start(plainPmt()), true);
    const service = psi.services.find((s) => s.serviceId === 1)!;
    expect(captionPid(service)).toBe(0x105);
    expect(superimposePid(service, 0x105)).toBeUndefined();
  });
});

describe('caption PES demux', () => {
  it('releases a multi-packet PES only when complete, including a split length header', () => {
    cc.clear();
    const seen: Pes[] = [];
    const demux = new PlaybackDemux(
      1,
      (pes) => seen.push(pes),
      () => {},
    );
    demux.push(join(...psiPackets(0, pat()), ...psiPackets(0x100, pmt())));
    const body = Array.from({ length: 200 }, (_, i) => i & 255);
    const packets = captionPesPacket(0x103, 90000, body);
    // Limit the first TS payload to five bytes so PES_packet_length spans packets.
    const pes = join(...packets.map((packet) => packet.subarray(4))).subarray(0, 214);
    cc.delete(0x103);
    const first = tsPacket(0x103, new Uint8Array(), true);
    first[3] |= 0x20;
    first[4] = 178;
    first[5] = 0;
    first.set(pes.subarray(0, 5), 183);
    demux.push(first);
    demux.push(tsPacket(0x103, pes.subarray(5, 189), false));
    expect(seen).toHaveLength(0);
    demux.push(tsPacket(0x103, pes.subarray(189), false));
    expect(seen).toHaveLength(1);
    expect([...seen[0].bytes]).toEqual(body);
    demux.flush();
    expect(seen).toHaveLength(1);
  });
  it('extracts caption and superimpose PES without resetting AV timelines', () => {
    cc.clear();
    const pes: Pes[] = [];
    let resets = 0;
    const demux = new PlaybackDemux(
      1,
      (p) => pes.push(p),
      () => resets++,
    );
    demux.push(join(...psiPackets(0, pat()), ...psiPackets(0x100, pmt())));
    expect(resets).toBe(1);
    demux.push(join(...captionPesPacket(0x103, 90000, [0x80, 0xff, 0xf0, 1, 2, 3, 4, 5])));
    expect(pes).toHaveLength(1); // No next PES or flush is needed.
    demux.push(join(...captionPesPacket(0x104, 180000, [0x81, 0xff, 0xf0, 6, 7, 8, 9, 10])));
    expect(pes).toHaveLength(2);
    demux.flush();
    expect(resets).toBe(1);
    const caption = pes.filter((p) => p.kind === 'caption');
    const superPes = pes.filter((p) => p.kind === 'super');
    expect(caption).toHaveLength(1);
    expect(superPes).toHaveLength(1);
    expect(caption[0].pts).toBe(90000);
    expect(superPes[0].pts).toBe(180000);
    expect(caption[0].bytes[0]).toBe(0x80);
    expect(superPes[0].bytes[0]).toBe(0x81);
  });
  it('drops only the caption assembly on a caption continuity error', () => {
    cc.clear();
    const pes: Pes[] = [];
    let resets = 0;
    const demux = new PlaybackDemux(
      1,
      (p) => pes.push(p),
      () => resets++,
    );
    demux.push(join(...psiPackets(0, pat()), ...psiPackets(0x100, pmt())));
    demux.push(join(...captionPesPacket(0x103, 90000, [0x80, 0xff, 0xf0, 1, 2, 3, 4, 5])));
    // Skip one CC value mid-PES on the caption PID: the partial PES is dropped, AV stays up.
    const brokenPayload = Array.from({ length: 200 }, (_, i) => (0x80 + i) & 255);
    brokenPayload[0] = 0x80;
    brokenPayload[1] = 0xff;
    brokenPayload[2] = 0xf0;
    const broken = captionPesPacket(0x103, 180000, brokenPayload);
    expect(broken).toHaveLength(2);
    broken[1][3] = (broken[1][3] & 0xf0) | ((broken[1][3] + 2) & 15);
    demux.push(join(...broken));
    expect(demux.stats.ccErrors).toBe(1);
    expect(resets).toBe(1);
    expect(pes.filter((p) => p.kind === 'caption')).toHaveLength(1);
    demux.push(join(...captionPesPacket(0x103, 270000, [0x80, 0xff, 0xf0, 11, 12, 13, 14, 15])));
    demux.flush();
    const captions = pes.filter((p) => p.kind === 'caption');
    expect(captions).toHaveLength(2);
    expect(captions[1].pts).toBe(270000);
    expect(resets).toBe(1);
  });
});

class MockWorker {
  static current: MockWorker;
  onmessage?: (event: { data: unknown }) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    MockWorker.current = this;
  }
  reply(data: unknown) {
    this.onmessage?.({ data });
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('player caption forwarding', () => {
  it('delivers caption packets and reset notifications to the overlay', () => {
    vi.stubGlobal('Worker', MockWorker);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const player = new FullSegPlayer({} as HTMLCanvasElement, true);
    const seen: CaptionPacket[] = [];
    let resetCalls = 0;
    player.onCaption = (packet) => seen.push(packet);
    player.onCaptionReset = () => resetCalls++;
    MockWorker.current.reply({
      type: 'caption',
      kind: 'super',
      bytes: new Uint8Array([0x81, 1, 2]),
      pts: 9000,
      dts: 9000,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'super', pts: 9000, dts: 9000 });
    MockWorker.current.reply({ type: 'reset' });
    expect(resetCalls).toBe(1);
    player.close();
  });
});
