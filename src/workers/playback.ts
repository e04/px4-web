import createDecoder, { type DecoderModule } from '../media/generated/decoder.js';
import { PlaybackDemux } from '../media/demux';

let module: DecoderModule;
let demux: PlaybackDemux;
let video = 0,
  audio = 0,
  benchmark = false;
let frames = 0,
  samples = 0,
  decodeMs = 0,
  mediaTicks = 0;
let previousPts: number | undefined;
let width = 0,
  height = 0,
  interlaced = false;
let chain = Promise.resolve();
let failure: string | undefined;
let selectedService = 0;
let pendingVideo = 0,
  pendingVideoBytes = 0,
  pendingAudio = 0,
  outputBlocked = false;
const send = (data: unknown, transfer: Transferable[] = []) => self.postMessage(data, { transfer });
function reset() {
  previousPts = undefined;
  if (video) module._decoder_close(video);
  if (audio) module._decoder_close(audio);
  video = module._decoder_open(0);
  audio = module._decoder_open(1);
  if (!video || !audio) throw new Error('Cannot initialize MPEG-2/AAC decoder');
  send({ type: 'reset' });
}
function createDemux(): PlaybackDemux {
  return new PlaybackDemux(
    selectedService,
    (pes) => {
      if (pes.kind === 'caption' || pes.kind === 'super') {
        const bytes = pes.bytes.slice().buffer;
        send({ type: 'caption', kind: pes.kind, bytes, pts: pes.pts, dts: pes.dts }, [
          bytes as ArrayBuffer,
        ]);
        return;
      }
      const p = module._media_alloc(pes.bytes.length);
      if (!p) throw new Error('Decoder input allocation failed');
      try {
        module.HEAPU8.set(pes.bytes, p);
        const result = module._decoder_push(
          pes.kind === 'video' ? video : audio,
          p,
          pes.bytes.length,
          pes.pts,
          pes.dts,
        );
        if (result < 0) throw new Error(`FFmpeg ${pes.kind} decode error ${result}`);
      } finally {
        module._media_free(p);
      }
    },
    reset,
  );
}
self.onmessage = (event) => {
  const { id, type, bytes, serviceId } = event.data;
  // Credits bound transferable output even when the main thread is suspended.
  if (type === 'release') {
    pendingVideo = Math.max(0, pendingVideo - (event.data.video ?? 0));
    pendingVideoBytes = Math.max(0, pendingVideoBytes - (event.data.videoBytes ?? 0));
    pendingAudio = Math.max(0, pendingAudio - (event.data.audio ?? 0));
    return;
  }
  if (type === 'playback-pts') {
    if (video) module._decoder_set_playback_pts(video, event.data.pts);
    return;
  }
  const overload = () => {
    if (!outputBlocked) {
      outputBlocked = true;
      send({ type: 'overload' });
    }
  };
  chain = chain.then(async () => {
    try {
      if (failure) throw new Error(failure);
      if (type === 'open') {
        selectedService = serviceId;
        benchmark = !!event.data.benchmark;
        module = await createDecoder({
          onVideo(bytes, w, h, pts, fields, aspect) {
            if (bytes.length !== w * h + 2 * Math.ceil(w / 2) * Math.ceil(h / 2))
              throw new Error(`FFmpeg YUV frame size mismatch: ${bytes.length} for ${w}x${h}`);
            frames++;
            width = w;
            height = h;
            interlaced ||= !!fields;
            if (previousPts !== undefined && pts > previousPts && pts - previousPts < 90000)
              mediaTicks += pts - previousPts;
            previousPts = pts;
            if (!benchmark && !outputBlocked) {
              if (pendingVideo >= 24 || pendingVideoBytes + bytes.byteLength > 96 * 1024 * 1024)
                return;
              pendingVideo++;
              pendingVideoBytes += bytes.byteLength;
              send(
                {
                  type: 'video',
                  picture: {
                    bytes,
                    width: w,
                    height: h,
                    pts,
                    aspect,
                  },
                },
                [bytes.buffer],
              );
            }
          },
          onAudio(pcm, pts) {
            samples += pcm.length / 2;
            if (!benchmark && !outputBlocked) {
              if (pendingAudio + pcm.length / 2 > 96000) {
                overload();
                return;
              }
              pendingAudio += pcm.length / 2;
              send({ type: 'audio', samples: pcm, pts }, [pcm.buffer]);
            }
          },
        });
        demux = createDemux();
      } else {
        const start = performance.now();
        if (type === 'chunk') demux.push(new Uint8Array(bytes));
        else if (type === 'resync') {
          reset();
          demux = createDemux();
          outputBlocked = false;
        } else if (type === 'flush') {
          demux.flush();
          for (const decoder of [video, audio])
            if (module._decoder_flush(decoder) < 0) throw new Error('Decoder flush failed');
          if (!frames || !samples) throw new Error('No decoded MPEG-2 video or AAC audio');
        }
        decodeMs += performance.now() - start;
      }
      const mediaSeconds = mediaTicks / 90000;
      send({
        id,
        stats: {
          videoFrames: frames,
          audioFrames: samples,
          decodeMs,
          mediaSeconds,
          speed: decodeMs ? (mediaSeconds * 1000) / decodeMs : 0,
          width,
          height,
          interlaced,
          ...demux.stats,
        },
      });
    } catch (error) {
      failure = String(error);
      send({ id, error: failure });
    }
  });
};
