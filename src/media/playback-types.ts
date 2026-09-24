export interface CaptionPacket {
  kind: 'caption' | 'super';
  bytes: Uint8Array;
  pts: number;
  dts: number;
}
export interface PlaybackStats {
  videoFrames: number;
  audioFrames: number;
  decodeMs: number;
  mediaSeconds: number;
  speed: number;
  width: number;
  height: number;
  interlaced: boolean;
  packets: number;
  ccErrors: number;
  scrambled: number;
  resets: number;
  pcr: number;
  pes: number;
}
