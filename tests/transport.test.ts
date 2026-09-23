import { describe, expect, it, vi } from 'vitest';
import { TaggedTs } from '../src/transport/tagged-ts';
import { TsAnalyzer } from '../src/transport/analyzer';
import { mpegCrc32, Psi } from '../src/transport/psi';
import { TsPipeline } from '../src/transport/pipeline';
import { TsCapture } from '../src/transport/capture';
import { TransportWorker } from '../src/transport/worker-client';

function join(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
function packet(pid = 100, cc = 0, tag = 0x37): Uint8Array {
  const p = new Uint8Array(188).fill(0xff);
  p.set([tag, pid >>> 8, pid & 255, 0x10 | cc]);
  return p;
}
function section(
  table: number,
  id: number,
  body: number[],
  version = 0,
  number = 0,
  last = 0,
): Uint8Array {
  const length = body.length + 9;
  const data = new Uint8Array([
    table,
    0xb0 | (length >>> 8),
    length & 255,
    id >>> 8,
    id & 255,
    0xc1 | (version << 1),
    number,
    last,
    ...body,
  ]);
  const crc = mpegCrc32(data);
  return join(data, new Uint8Array([crc >>> 24, crc >>> 16, crc >>> 8, crc]));
}
const pat = (version = 0, service = 1, pid = 0x100) =>
  section(0, 10, [service >>> 8, service & 255, 0xe0 | (pid >>> 8), pid & 255], version);
const pmt = (version = 0) =>
  section(2, 1, [0xe1, 1, 0xf0, 0, 2, 0xe1, 1, 0xf0, 0, 0x0f, 0xe1, 2, 0xf0, 0], version);
const start = (s: Uint8Array) => join(new Uint8Array([0]), s);

describe('tagged TS framing', () => {
  it('restores all tags at every possible two-chunk split', () => {
    const source = join(...[0x17, 0x27, 0x37, 0x47, 0x37].map((t) => packet(100, 0, t)));
    for (let split = 0; split <= source.length; split++) {
      const seen: number[] = [];
      const parser = new TaggedTs((id, bytes) => {
        seen.push(id);
        expect(bytes[0]).toBe(0x47);
        expect(bytes.length).toBe(188);
      });
      parser.push(source.subarray(0, split));
      parser.push(source.subarray(split));
      expect(seen).toEqual([0, 1, 2, 3, 2]);
      expect(parser.bufferedBytes).toBe(0);
    }
    expect(source[0]).toBe(0x17);
  });
  it('handles bytewise input, noise, loss of sync and invalid receiver IDs', () => {
    const seen: number[] = [];
    const parser = new TaggedTs((id) => seen.push(id));
    const good = join(...Array.from({ length: 4 }, () => packet()));
    const bytes = join(
      new Uint8Array([0x87, 0]),
      good,
      new Uint8Array([0x97]),
      good,
      packet(1, 0, 0x77),
    );
    for (const byte of bytes) parser.push(new Uint8Array([byte]));
    expect(seen).toHaveLength(8);
    expect(parser.stats).toMatchObject({ syncLosses: 1, discardedBytes: 3, invalidTags: 1 });
    expect(parser.bufferedBytes).toBe(0);
    parser.push(new Uint8Array(10000));
    expect(parser.bufferedBytes).toBeLessThan(752);
  });
});

describe('TS diagnostics', () => {
  it('counts CC gaps, rollover, exact duplicates, TEI and scrambling separately', () => {
    const a = new TsAnalyzer();
    a.push(packet(100, 15));
    a.push(packet(100, 0));
    a.push(packet(100, 0));
    const changed = packet(100, 0);
    changed[10] = 0;
    a.push(changed);
    a.push(packet(100, 4));
    const tei = packet(100, 5);
    tei[1] |= 0x80;
    a.push(tei);
    const scrambled = packet(100, 9);
    scrambled[3] |= 0x80;
    a.push(scrambled);
    expect(a.totals).toMatchObject({
      packets: 7,
      ccErrors: 2,
      duplicates: 1,
      tei: 1,
      scrambled: 1,
    });
  });
  it('handles adaptation-only CC, discontinuity, malformed lengths and null PID', () => {
    const a = new TsAnalyzer();
    a.push(packet(100, 0));
    const adaptation = packet(100, 0);
    adaptation[3] = 0x20;
    adaptation[4] = 183;
    adaptation[5] = 0;
    a.push(adaptation);
    a.push(packet(100, 1));
    adaptation[3] = 0x28;
    adaptation[5] = 0x80;
    a.push(adaptation);
    a.push(packet(100, 9));
    adaptation[4] = 184;
    a.push(adaptation);
    a.push(packet(0x1fff, 0));
    a.push(packet(0x1fff, 9));
    expect(a.totals).toMatchObject({ ccErrors: 0, discontinuities: 1, malformedPackets: 1 });
  });
});

describe('PAT/PMT sections', () => {
  it('uses the MPEG-2 CRC test vector', () => {
    expect(mpegCrc32(new TextEncoder().encode('123456789'))).toBe(0x0376e6e7);
  });
  it('assembles PAT/PMT at every section split and extracts streams', () => {
    for (let split = 1; split < pmt().length; split++) {
      const psi = new Psi();
      psi.push(0, start(pat()), true);
      psi.push(256, start(pmt().subarray(0, split)), true);
      psi.push(256, pmt().subarray(split), false);
      expect(psi.services).toEqual([
        {
          serviceId: 1,
          pmtPid: 256,
          pmtVersion: 0,
          pcrPid: 257,
          streams: [
            { pid: 257, streamType: 2 },
            { pid: 258, streamType: 15 },
          ],
        },
      ]);
    }
  });
  it('completes a previous section via pointer, processes multiple sections, and waits for all PAT sections', () => {
    const psi = new Psi();
    const a = section(0, 10, [0, 1, 0xe1, 0], 0, 0, 1);
    const b = section(0, 10, [0, 2, 0xe1, 1], 0, 1, 1);
    psi.push(0, start(a.subarray(0, 7)), true);
    expect(psi.services).toEqual([]);
    psi.push(
      0,
      join(new Uint8Array([a.length - 7]), a.subarray(7), b, new Uint8Array([255])),
      true,
    );
    expect(psi.services.map((s) => s.serviceId)).toEqual([1, 2]);
    psi.push(256, start(pmt()), true);
    psi.push(0, start(pat(1, 3, 300)), true);
    expect(psi.services).toEqual([{ serviceId: 3, pmtPid: 300 }]);
    psi.push(256, start(pmt(1)), true);
    expect(psi.services).toHaveLength(1);
  });
  it('rejects bad CRC, impossible descriptors, next tables and partial sections after reset', () => {
    const psi = new Psi();
    const bad = pat();
    bad[8] ^= 1;
    psi.push(0, start(bad), true);
    expect(psi.crcErrors).toBe(1);
    expect(psi.services).toEqual([]);
    psi.push(0, start(pat().subarray(0, 8)), true);
    psi.resetPid(0);
    psi.push(0, pat().subarray(8), false);
    expect(psi.services).toEqual([]);
    const next = pat();
    next[5] &= ~1;
    const crc = mpegCrc32(next.subarray(0, -4));
    next.set([crc >>> 24, crc >>> 16, crc >>> 8, crc], next.length - 4);
    psi.push(0, start(next), true);
    expect(psi.services).toEqual([]);
    psi.push(0, start(pat()), true);
    psi.push(256, start(section(2, 1, [0xe1, 1, 0xff, 0xff])), true);
    expect(psi.malformedSections).toBe(1);
    expect(psi.services[0].pmtVersion).toBeUndefined();
  });
  it('discards a section spanning a CC error, but accepts the next PUSI', () => {
    const a = new TsAnalyzer(),
      data = pat();
    const first = packet(0, 0);
    first[1] |= 0x40;
    first[3] = 0x30;
    first[4] = 174;
    first[5] = 0;
    first.set(start(data.subarray(0, 8)), 179);
    const second = packet(0, 2);
    second.set(data.subarray(8), 4);
    a.push(first);
    a.push(second);
    expect(a.psi.services).toEqual([]);
    expect(a.totals.ccErrors).toBe(1);
    const complete = packet(0, 3);
    complete[1] |= 0x40;
    complete.set(start(data), 4);
    a.push(complete);
    expect(a.psi.services[0].serviceId).toBe(1);
  });
  it('rejects a PMT with a truncated stream descriptor', () => {
    const psi = new Psi();
    psi.push(0, start(pat()), true);
    psi.push(
      256,
      start(section(2, 1, [0xe1, 1, 0xf0, 0, 2, 0xe1, 1, 0xf0, 3, 0x52, 2, 0x30])),
      true,
    );
    expect(psi.services[0].streams).toBeUndefined();
    expect(psi.malformedSections).toBe(1);
  });
});

it('waits for B25 forwarding before accepting the next TS chunk', async () => {
  let release!: () => void;
  vi.stubGlobal(
    'Worker',
    class {
      onmessage?: (event: MessageEvent) => void;
      postMessage({ id, type }: { id: number; type: string }) {
        queueMicrotask(() => {
          if (type === 'chunk')
            this.onmessage?.({ data: { type: 'ts', bytes: new ArrayBuffer(188) } } as MessageEvent);
          this.onmessage?.({ data: { id } } as MessageEvent);
        });
      }
      terminate() {}
    },
  );
  try {
    const worker = new TransportWorker(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let done = false;
    const chunk = worker.request('chunk', new ArrayBuffer(188)).then(() => {
      done = true;
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(done).toBe(false);
    release();
    await chunk;
    expect(done).toBe(true);
    worker.close();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('bounded capture and long-running pipeline', () => {
  it('saves selected receiver packets, restored to 188 bytes, with time and capacity limits', async () => {
    const pipeline = new TsPipeline();
    pipeline.capture.start(0);
    pipeline.push(
      join(packet(100, 0, 0x17), packet(100, 0), packet(100, 1), packet(100, 1, 0x47)),
      1,
    );
    expect(pipeline.analyzer.totals.packets).toBe(2);
    const bytes = new Uint8Array(await pipeline.capture.blob().arrayBuffer());
    expect(bytes.length).toBe(376);
    expect(bytes[0]).toBe(0x47);
    expect(bytes[188]).toBe(0x47);
    pipeline.snapshot(10000);
    expect(pipeline.capture.active).toBe(false);
    const capture = new TsCapture(376, 1000);
    capture.start(0);
    capture.push(join(packet(), packet(), packet()), 1);
    expect(capture.bytes).toBe(376);
    expect(capture.reason).toBe('Size limit');
    capture.start(10);
    capture.push(packet(), 1010);
    expect(capture.bytes).toBe(0);
  });
  it('keeps buffers bounded over ten minutes of virtual 19.6 Mbps input', () => {
    const pipeline = new TsPipeline();
    pipeline.capture.start(0);
    const chunk = join(...Array.from({ length: 816 * 16 }, () => packet(0x1fff)));
    for (let second = 0; second < 600; second++) pipeline.push(chunk, second * 1000);
    expect(pipeline.analyzer.totals.packets).toBe(816 * 16 * 600);
    expect(pipeline.analyzer.totals.ccErrors).toBe(0);
    expect(pipeline.analyzer.pids.size).toBe(1);
    expect(pipeline.tagged.bufferedBytes).toBe(0);
    expect(pipeline.capture.bytes).toBe(chunk.length * 10);
    const fresh = new TsPipeline();
    expect(fresh.snapshot(0).packets).toBe(0);
    expect(fresh.snapshot(0).services).toEqual([]);
  }, 20000);
});
