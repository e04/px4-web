import type { DecodedPicture } from './generated/decoder.js';

// FFmpeg enum values (libavutil/pixfmt.h) for the colorimetry ISDB broadcasts use.
const MATRIX: Record<number, VideoMatrixCoefficients> = {
  1: 'bt709',
  5: 'bt470bg',
  6: 'smpte170m',
};
const PRIMARIES: Record<number, VideoColorPrimaries> = {
  1: 'bt709',
  5: 'bt470bg',
  6: 'smpte170m',
};
const TRANSFER: Record<number, VideoTransferCharacteristics> = {
  1: 'bt709',
  6: 'smpte170m',
  13: 'iec61966-2-1',
};

/** Limited-range colorimetry; unknown values fall back to the HD/SD broadcast default. */
export function videoColorSpace(picture: DecodedPicture): VideoColorSpaceInit {
  const hd = picture.height > 576;
  return {
    matrix: MATRIX[picture.matrix] ?? (hd ? 'bt709' : 'smpte170m'),
    primaries: PRIMARIES[picture.primaries] ?? (hd ? 'bt709' : 'smpte170m'),
    transfer: TRANSFER[picture.transfer] ?? (hd ? 'bt709' : 'smpte170m'),
    fullRange: false,
  };
}

/** VideoFrame timestamps are microseconds; the playback clock is 90 kHz. */
export const ptsToMicroseconds = (pts: number) => Math.round((pts * 100) / 9);
export const microsecondsToPts = (timestamp: number) => (timestamp * 9) / 100;

export function videoFrameInit(picture: DecodedPicture): VideoFrameBufferInit {
  return {
    format: 'I420',
    codedWidth: picture.width,
    codedHeight: picture.height,
    displayWidth: picture.displayWidth,
    displayHeight: picture.height,
    timestamp: ptsToMicroseconds(picture.pts),
    layout: picture.layout,
    colorSpace: videoColorSpace(picture),
  };
}

/** Copies the planes out of the WASM heap once; the browser owns YUV→RGB conversion. */
export function createVideoFrame(picture: DecodedPicture): VideoFrame {
  return new VideoFrame(picture.heap, videoFrameInit(picture));
}
