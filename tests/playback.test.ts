import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PlaybackDemux, readTimestamp, unwrapTimestamp, type Pes } from '../src/media/demux';
import { PcmQueue } from '../src/media/pcm-queue';
import createDecoder from '../src/media/generated/decoder.js';

const fixture = () =>
  new Uint8Array(readFileSync(new URL('./fixtures/generated/hd.ts', import.meta.url)));

describe('broadcast timestamps and PES', () => {
  it('unwraps PTS and PCR into one epoch, including B-frame reordering', () => {
    const wrap = 2 ** 33;
    expect(unwrapTimestamp(1000, wrap - 2000)).toBe(wrap + 1000);
    expect(unwrapTimestamp(wrap - 2000, wrap + 1000)).toBe(wrap - 2000);
    expect(readTimestamp(new Uint8Array([0x2f, 0xff, 0xff, 0xff, 0xff]), 0)).toBe(wrap - 1);
    expect(() => readTimestamp(new Uint8Array(5), 0)).toThrow();
  });
  it('preserves PES bytes/timestamps across arbitrary input splits', () => {
    const input = fixture();
    const run = (step: number) => {
      const pes: Pes[] = [];
      const demux = new PlaybackDemux(
        1,
        (p) => pes.push(p),
        () => {},
      );
      for (let offset = 0; offset < input.length; offset += step)
        demux.push(input.subarray(offset, offset + step));
      demux.flush();
      return { pes, stats: demux.stats };
    };
    const whole = run(input.length),
      split = run(317);
    expect(split).toEqual(whole);
    expect(split.stats.pcr).toBeGreaterThan(10);
    expect(split.stats.ccErrors).toBe(0);
    expect(split.pes.some((p) => p.kind === 'video' && p.pts !== p.dts)).toBe(true);
    expect(split.pes.some((p) => p.kind === 'audio')).toBe(true);
  });
  it('resets after selected continuity loss and rejects scrambled selected packets', () => {
    const input = fixture(),
      pes: Pes[] = [];
    let resets = 0;
    const d = new PlaybackDemux(
      1,
      (p) => pes.push(p),
      () => resets++,
    );
    let corrupt = -1;
    for (let i = 0; i < input.length; i += 188) {
      const p = input.slice(i, i + 188);
      if (pes.length > 4 && (p[1] & 31) === 1 && p[2] === 0 && p[3] & 16) {
        corrupt = i;
        break;
      }
      d.push(p);
    }
    expect(corrupt).toBeGreaterThan(0);
    const damaged = input.slice(corrupt, corrupt + 188);
    damaged[3] = (damaged[3] & 240) | ((damaged[3] + 3) & 15);
    d.push(damaged);
    expect(d.stats.ccErrors).toBe(1);
    expect(resets).toBeGreaterThan(1);
    damaged[3] |= 128;
    expect(() => d.push(damaged)).toThrow(/scrambled/);
  });
  it('rejects absent services and truncated input', () => {
    const d = new PlaybackDemux(
      999,
      () => {},
      () => {},
    );
    d.push(fixture());
    expect(() => d.flush()).toThrow(/not found/);
    const truncated = new PlaybackDemux(
      1,
      () => {},
      () => {},
    );
    truncated.push(fixture().subarray(0, 189));
    expect(() => truncated.flush()).toThrow(/Truncated/);
  });
});

describe('AudioWorklet PCM queue', () => {
  it('uses consumed samples as clock and freezes/rebuffers after underflow', () => {
    const queue = new PcmQueue(),
      left = new Float32Array(128),
      right = new Float32Array(128);
    queue.push(new Float32Array(480 * 2).fill(0.25), 90000);
    expect(queue.render(left, right)).toBe(false);
    expect(queue.pts).toBe(90000);
    queue.push(new Float32Array(7200 * 2).fill(0.5), 90900);
    expect(queue.render(left, right)).toBe(true);
    expect(left[0]).toBe(0.25);
    expect(queue.pts).toBe(90240);
    for (let i = 0; i < 60; i++) queue.render(left, right);
    expect(queue.underruns).toBe(1);
    const frozen = queue.pts;
    expect(queue.render(left, right)).toBe(false);
    expect(queue.pts).toBe(frozen);
    expect(left.every((v) => v === 0)).toBe(true);
  });
  it('bounds queue memory, fills short gaps and resets large discontinuities', () => {
    const queue = new PcmQueue();
    queue.push(new Float32Array(480 * 2), 0);
    queue.push(new Float32Array(480 * 2), 1800);
    expect(queue.frames).toBe(1440);
    queue.push(new Float32Array(480 * 2), 900000);
    expect(queue.frames).toBe(480);
    expect(queue.pts).toBe(900000);
    expect(() => queue.push(new Float32Array(96000 * 2), 900900)).toThrow(/overflow/);
    queue.clear();
    expect(queue.frames).toBe(0);
    expect(queue.pts).toBeUndefined();
  });
});

it('decodes real 1080i MPEG-2 with reordered B frames and audible AAC in streaming WASM', async () => {
  const pictures: { pts: number; width: number; height: number; interlaced: number }[] = [];
  let samples = 0,
    energy = 0;
  const audioPts: number[] = [];
  const module = await createDecoder({
    onVideo(bytes, width, height, pts, interlaced) {
      expect(bytes.length).toBe(width * height * 1.5);
      pictures.push({ pts, width, height, interlaced });
    },
    onAudio(pcm, pts) {
      audioPts.push(pts);
      samples += pcm.length / 2;
      for (const value of pcm) energy += value * value;
    },
  });
  let video = 0,
    audio = 0;
  const reset = () => {
    if (video) module._decoder_close(video);
    if (audio) module._decoder_close(audio);
    video = module._decoder_open(0);
    audio = module._decoder_open(1);
  };
  const demux = new PlaybackDemux(
    1,
    (pes) => {
      const p = module._media_alloc(pes.bytes.length);
      try {
        module.HEAPU8.set(pes.bytes, p);
        expect(
          module._decoder_push(
            pes.kind === 'video' ? video : audio,
            p,
            pes.bytes.length,
            pes.pts,
            pes.dts,
          ),
        ).toBe(0);
      } finally {
        module._media_free(p);
      }
    },
    reset,
  );
  try {
    const input = fixture();
    for (let i = 0; i < input.length; i += 188 * 32) demux.push(input.subarray(i, i + 188 * 32));
    demux.flush();
    expect(module._decoder_flush(video)).toBe(0);
    expect(module._decoder_flush(audio)).toBe(0);
    expect(pictures.length).toBeGreaterThanOrEqual(88);
    expect(pictures.every((p) => p.width === 1920 && p.height === 1080 && p.interlaced)).toBe(true);
    expect(pictures.slice(1).every((p, i) => p.pts > pictures[i].pts)).toBe(true);
    expect(samples).toBeGreaterThan(140000);
    expect(energy).toBeGreaterThan(100);
    expect(
      Math.abs(audioPts[0] - pictures[0].pts),
      JSON.stringify({ audio: audioPts.slice(0, 12), video: pictures.slice(0, 3) }),
    ).toBeLessThan(9000);
  } finally {
    module._decoder_close(video);
    module._decoder_close(audio);
  }
}, 20000);
