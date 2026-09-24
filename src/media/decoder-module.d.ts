declare module '*generated/decoder.js' {
  /** Planar 4:2:0 picture still owned by FFmpeg; valid only during the onVideo call. */
  export interface DecodedPicture {
    heap: Uint8Array;
    layout: [PlaneLayout, PlaneLayout, PlaneLayout];
    width: number;
    height: number;
    displayWidth: number;
    pts: number;
    interlaced: boolean;
    /** FFmpeg AVColorSpace / AVColorPrimaries / AVColorTransferCharacteristic. */
    matrix: number;
    primaries: number;
    transfer: number;
  }
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
    onVideo(picture: DecodedPicture): void;
    onAudio(samples: Float32Array, pts: number): void;
  }): Promise<DecoderModule>;
}
