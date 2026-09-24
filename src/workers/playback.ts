import createDecoder, { type DecoderModule } from '../media/generated/decoder.js';
import { PlaybackDemux } from '../media/demux';
import { createVideoFrame } from '../media/video-frame';

// Decoded output bounds: frames in flight to the main thread, PCM in flight to the AudioWorklet.
const MAX_PENDING_FRAMES = 24;
const MAX_PENDING_SAMPLES = 96000;

let module: DecoderModule;
let demux: PlaybackDemux;
let audioPort: MessagePort | undefined;
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
// Every decoder reset starts a new timeline; clocks and PCM from older ones are stale.
let generation = 0;
let pendingFrames = 0,
  pendingSamples = 0,
  outputBlocked = false;
const send = (data: unknown, transfer: Transferable[] = []) => self.postMessage(data, { transfer });
function overload() {
  if (outputBlocked) return;
  outputBlocked = true;
  send({ type: 'overload' });
}
function reset() {
  previousPts = undefined;
  if (video) module._decoder_close(video);
  if (audio) module._decoder_close(audio);
  video = module._decoder_open(0);
  audio = module._decoder_open(1);
  if (!video || !audio) throw new Error('Cannot initialize MPEG-2/AAC decoder');
  generation++;
  audioPort?.postMessage({ type: 'reset', generation });
  send({ type: 'reset', generation });
}
function createDemux(): PlaybackDemux {
  return new PlaybackDemux(
    selectedService,
    (pes) => {
      if (pes.kind === 'caption' || pes.kind === 'super') {
        const bytes = pes.bytes.slice().buffer;
        send({ type: 'caption', kind: pes.kind, bytes, pts: pes.pts, dts: pes.dts }, [bytes]);
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
function attachAudio(port: MessagePort) {
  audioPort = port;
  port.onmessage = (event) => {
    pendingSamples = Math.max(0, pendingSamples - (event.data.accepted ?? 0));
  };
}
self.onmessage = (event) => {
  const { id, type, bytes, serviceId } = event.data;
  // Credits bound transferable output even when the main thread is suspended.
  if (type === 'release') {
    pendingFrames = Math.max(0, pendingFrames - 1);
    return;
  }
  if (type === 'playback-pts') {
    if (video && event.data.generation === generation)
      module._decoder_set_playback_pts(video, event.data.pts);
    return;
  }
  chain = chain.then(async () => {
    try {
      if (failure) throw new Error(failure);
      if (type === 'open') {
        selectedService = serviceId;
        benchmark = !!event.data.benchmark;
        if (event.data.audioPort) attachAudio(event.data.audioPort);
        module = await createDecoder({
          onVideo(picture) {
            frames++;
            width = picture.width;
            height = picture.height;
            interlaced ||= picture.interlaced;
            const pts = picture.pts;
            if (previousPts !== undefined && pts > previousPts && pts - previousPts < 90000)
              mediaTicks += pts - previousPts;
            previousPts = pts;
            // Late frames are dropped here, before they cost a copy out of the WASM heap.
            if (benchmark || outputBlocked || pendingFrames >= MAX_PENDING_FRAMES) return;
            const frame = createVideoFrame(picture);
            pendingFrames++;
            send({ type: 'video', frame }, [frame]);
          },
          onAudio(pcm, pts) {
            samples += pcm.length / 2;
            if (benchmark || outputBlocked || !audioPort) return;
            if (pendingSamples + pcm.length / 2 > MAX_PENDING_SAMPLES) {
              overload();
              return;
            }
            pendingSamples += pcm.length / 2;
            audioPort.postMessage({ type: 'pcm', samples: pcm, pts }, [pcm.buffer]);
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
          // Same port as the PCM, so the worklet sees drain only after the last samples.
          audioPort?.postMessage({ type: 'drain' });
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
