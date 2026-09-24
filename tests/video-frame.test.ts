import { expect, it } from 'vitest';
import type { DecodedPicture } from '../src/media/generated/decoder.js';
import {
  microsecondsToPts,
  ptsToMicroseconds,
  videoColorSpace,
  videoFrameInit,
} from '../src/media/video-frame';

const picture = (overrides: Partial<DecodedPicture>): DecodedPicture => ({
  heap: new Uint8Array(0),
  layout: [
    { offset: 0, stride: 1440 },
    { offset: 0, stride: 720 },
    { offset: 0, stride: 720 },
  ],
  width: 1440,
  height: 1080,
  displayWidth: 1920,
  pts: 0,
  interlaced: true,
  matrix: 1,
  primaries: 1,
  transfer: 1,
  ...overrides,
});

it('stretches anamorphic 1440x1080 to its 16:9 display size', () => {
  expect(videoFrameInit(picture({ pts: 90000 }))).toMatchObject({
    format: 'I420',
    codedWidth: 1440,
    codedHeight: 1080,
    displayWidth: 1920,
    displayHeight: 1080,
    timestamp: 1_000_000,
  });
});

it('maps FFmpeg colorimetry and falls back to the HD/SD broadcast default', () => {
  expect(videoColorSpace(picture({ height: 480, matrix: 6, primaries: 6, transfer: 6 }))).toEqual({
    matrix: 'smpte170m',
    primaries: 'smpte170m',
    transfer: 'smpte170m',
    fullRange: false,
  });
  expect(videoColorSpace(picture({ matrix: 2, primaries: 2, transfer: 2 }))).toMatchObject({
    matrix: 'bt709',
    primaries: 'bt709',
  });
  expect(videoColorSpace(picture({ height: 480, matrix: 2 })).matrix).toBe('smpte170m');
});

it('round-trips 90 kHz timestamps through VideoFrame microseconds beyond 2^33', () => {
  const pts = 2 ** 33 + 3003;
  expect(microsecondsToPts(ptsToMicroseconds(pts))).toBeCloseTo(pts, 0);
});
