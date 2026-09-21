import { describe, expect, it } from 'vitest';
import { B25Decoder } from '../src/media/b25';
import { ServiceFilter } from '../src/media/service-filter';
import { TsAnalyzer } from '../src/transport/analyzer';
import { mpegCrc32 } from '../src/transport/psi';

function section(table: number, id: number, body: number[], version = 0): Uint8Array {
  const n = body.length + 9;
  const s = new Uint8Array([
    table,
    0xb0 | (n >> 8),
    n & 255,
    id >> 8,
    id & 255,
    0xc1 | (version << 1),
    0,
    0,
    ...body,
  ]);
  const crc = mpegCrc32(s);
  return new Uint8Array([...s, crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]);
}
function packet(pid: number, cc = 0, data?: Uint8Array): Uint8Array {
  const p = new Uint8Array(188).fill(255);
  p.set([0x47, (pid >> 8) | (data ? 0x40 : 0), pid & 255, 0x10 | cc]);
  if (data) p.set([0, ...data], 4);
  return p;
}
function multiplex(): Uint8Array {
  const packets = [
    packet(0, 0, section(0, 10, [0, 1, 0xe1, 0, 0, 2, 0xe2, 0])),
    packet(256, 0, section(2, 1, [0xe1, 1, 0xf0, 0, 2, 0xe1, 1, 0xf0, 0])),
    packet(512, 0, section(2, 2, [0xe2, 1, 0xf0, 0, 2, 0xe2, 1, 0xf0, 0])),
  ];
  for (let i = 0; i < 100; i++) packets.push(packet(257, i & 15), packet(513, i & 15));
  const bytes = new Uint8Array(packets.length * 188);
  packets.forEach((p, i) => bytes.set(p, i * 188));
  return bytes;
}
async function card(apdu: Uint8Array): Promise<Uint8Array> {
  if (apdu[1] === 0x30) {
    const r = new Uint8Array(58);
    r.set([0x21, 0, 0, 5], 4);
    r.set([0x90, 0], 56);
    return r;
  }
  if (apdu[1] === 0x32)
    return new Uint8Array([0, 0, 0, 0, 0x21, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0x90, 0]);
  throw new Error('Unexpected APDU');
}
describe('B25 WASM and selected service output', () => {
  it('rewrites PAT with valid CRC and only emits selected PMT/PCR/ES at arbitrary byte splits', () => {
    const filter = new ServiceFilter(1),
      analyzer = new TsAnalyzer(),
      bytes = multiplex();
    for (let offset = 0; offset < bytes.length; offset += 131) {
      const out = filter.push(bytes.subarray(offset, offset + 131));
      for (let i = 0; i < out.length; i += 188) analyzer.push(out.subarray(i, i + 188));
    }
    filter.finish();
    expect(analyzer.psi.services.map((s) => s.serviceId)).toEqual([1]);
    expect([...analyzer.pids.keys()]).toEqual([0, 256, 257]);
    expect(analyzer.psi.crcErrors).toBe(0);
    expect(analyzer.totals.ccErrors).toBe(0);
    expect(filter.stats).toMatchObject({ packets: 101, scrambled: 0 });
  });
  it('initializes real WASM through async APDUs and streams a plaintext multiplex', async () => {
    const calls: number[] = [];
    const decoder = await B25Decoder.open(1, true, async (apdu) => {
      calls.push(apdu[1]);
      await Promise.resolve();
      return card(apdu);
    });
    try {
      const output: Uint8Array[] = [],
        bytes = multiplex();
      for (let i = 0; i < bytes.length; i += 1133)
        await decoder.push(bytes.subarray(i, i + 1133), (b) => output.push(b));
      await decoder.flush((b) => output.push(b));
      expect(calls).toEqual([0x30, 0x32]);
      expect(output.reduce((n, b) => n + b.length, 0)).toBeGreaterThan(188 * 100);
      expect(decoder.filter.stats.scrambled).toBe(0);
      expect(decoder.filter.found).toBe(true);
    } finally {
      decoder.close();
    }
  });
  it('propagates card errors without falling back to a plaintext success', async () => {
    await expect(
      B25Decoder.open(1, true, async () => {
        throw new Error('Card removed');
      }),
    ).rejects.toThrow('Card removed');
    await expect(B25Decoder.open(1, false, async () => new Uint8Array([0x90, 0]))).rejects.toThrow(
      'B25 error',
    );
  });
  it('decrypts native-generated MULTI2 vectors for both parities across an ECM key update', async () => {
    // Produced by tests/fixtures/b25-vectors.cc with synthetic system/IV/key values.
    const vectors = [
      'c62f618d05cb9594f50909f031f0212a02',
      'a833adbf04d801c09dd349e349a3088c66',
      '6fa523bd0a1786915daffedc25220b7d1b',
      '23dab3fee02082895cfb93945f6f022c70',
    ];
    const packets = [
      packet(0, 0, section(0, 10, [0, 1, 0xe1, 0])),
      packet(
        256,
        0,
        section(2, 1, [0xe1, 1, 0xf0, 6, 9, 4, 0, 5, 0xe1, 0x2c, 2, 0xe1, 1, 0xf0, 0]),
      ),
    ];
    for (let generation = 0; generation < 2; generation++) {
      const ecm = new Uint8Array([0x82, 0x30, 5, generation]);
      const crc = mpegCrc32(ecm);
      packets.push(
        packet(
          300,
          generation,
          new Uint8Array([...ecm, crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]),
        ),
      );
      for (let i = 0; i < 20; i++) {
        const parity = i % 2,
          p = packet(257, (generation * 20 + i) & 15);
        p[3] |= 0x20 | ((parity + 2) << 6);
        p[4] = 166;
        p[5] = 0;
        p.set(
          Uint8Array.from(
            vectors[generation * 2 + parity].match(/../g)!.map((h) => parseInt(h, 16)),
          ),
          171,
        );
        packets.push(p);
      }
    }
    const bytes = new Uint8Array(packets.length * 188);
    packets.forEach((p, i) => bytes.set(p, i * 188));
    const updates: number[] = [];
    const decoder = await B25Decoder.open(1, false, async (apdu) => {
      if (apdu[1] !== 0x34) return card(apdu);
      expect(apdu).toEqual(new Uint8Array([0x90, 0x34, 0, 0, 1, apdu[5], 0]));
      updates.push(apdu[5]);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const response = new Uint8Array(25);
      response[4] = 8;
      response.set(
        Uint8Array.from({ length: 16 }, (_, i) => apdu[5] * 16 + i),
        6,
      );
      response.set([0x90, 0], 23);
      return response;
    });
    try {
      const output: Uint8Array[] = [];
      await decoder.push(bytes, (b) => output.push(b));
      await decoder.flush((b) => output.push(b));
      let checked = 0;
      for (const chunk of output)
        for (let i = 0; i < chunk.length; i += 188) {
          const p = chunk.subarray(i, i + 188);
          if ((((p[1] & 31) << 8) | p[2]) !== 257) continue;
          expect(p[3] & 0xc0).toBe(0);
          expect(p.slice(171)).toEqual(Uint8Array.from({ length: 17 }, (_, i) => i));
          checked++;
        }
      expect(checked).toBe(40);
      expect(updates).toContain(0);
      expect(updates).toContain(1);
      expect(decoder.filter.stats.scrambled).toBe(0);
    } finally {
      decoder.close();
    }
  });
  it('rejects missing selected service, truncated output and invalid sync', () => {
    const filter = new ServiceFilter(3);
    filter.push(multiplex());
    expect(() => filter.finish()).toThrow('PMT');
    const truncated = new ServiceFilter(1);
    truncated.push(new Uint8Array([0x47]));
    expect(() => truncated.finish()).toThrow('Truncated');
    expect(() => new ServiceFilter(1).push(new Uint8Array(188))).toThrow('sync');
  });
  it('retains all packets of the first multi-packet PMT before publishing the service', () => {
    const descriptor = [0x52, 170, ...new Array(170).fill(0)];
    const pmt = section(2, 1, [
      0xe1,
      1,
      0xf0,
      descriptor.length,
      ...descriptor,
      2,
      0xe1,
      1,
      0xf0,
      0,
    ]);
    const first = packet(256, 0, pmt.slice(0, 183)),
      second = packet(256, 1);
    second.set(pmt.slice(183), 4);
    const filter = new ServiceFilter(1),
      analyzer = new TsAnalyzer();
    for (const p of [packet(0, 0, section(0, 10, [0, 1, 0xe1, 0])), first, second, packet(257)]) {
      const out = filter.push(p);
      for (let i = 0; i < out.length; i += 188) analyzer.push(out.subarray(i, i + 188));
    }
    expect(analyzer.psi.services[0].streams).toEqual([{ pid: 257, streamType: 2 }]);
    expect(analyzer.totals.ccErrors).toBe(0);
    expect(analyzer.psi.crcErrors).toBe(0);
  });
});
