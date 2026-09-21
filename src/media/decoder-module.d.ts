declare module '*generated/decoder.js' {
  export interface DecoderModule {
    HEAPU8: Uint8Array;
    _decoder_open(kind: number): number;
    _decoder_set_playback_pts(decoder: number, pts: number): void;
    _decoder_push(decoder: number, p: number, n: number, pts: number, dts: number): number;
    _decoder_flush(decoder: number): number;
    _decoder_close(decoder: number): void;
    _media_alloc(n: number): number;
    _media_free(p: number): void;
  }
  export default function create(options: {
    onVideo(
      bytes: Uint8Array,
      width: number,
      height: number,
      pts: number,
      interlaced: number,
      aspect: number,
    ): void;
    onAudio(samples: Float32Array, pts: number): void;
  }): Promise<DecoderModule>;
}
