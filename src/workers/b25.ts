import { B25Decoder } from '../media/b25';
import { TsCapture } from '../transport/capture';

let decoder: B25Decoder | undefined;
let failure: string | undefined;
let chain = Promise.resolve();
let nextApdu = 0;
let apduPending:
  | { id: number; resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }
  | undefined;
let queuedBytes = 0,
  peakBytes = 0,
  inputBytes = 0,
  outputBytes = 0;
let capture = new TsCapture();
let playback = false;
const output = (bytes: Uint8Array) => {
  outputBytes += bytes.length;
  capture.push(bytes, performance.now());
  if (playback) {
    const copy = bytes.slice().buffer;
    self.postMessage({ type: 'clear-ts', bytes: copy }, { transfer: [copy] });
  }
  if (decoder?.filter.dataEnabled) {
    const data = decoder.filter.takeData();
    if (data.length)
      self.postMessage({ type: 'data-ts', bytes: data.buffer }, { transfer: [data.buffer] });
  }
};
const snapshot = () => ({
  inputBytes,
  outputBytes,
  queuedBytes,
  peakBytes,
  ...decoder?.filter.stats,
  found: decoder?.filter.found ?? false,
  error: failure,
  capturedBytes: capture.bytes,
  captureReason: capture.reason,
});

self.onmessage = (event: MessageEvent) => {
  const { id, type, bytes, serviceId, emm, error, file } = event.data;
  // APDU replies must bypass the processing chain suspended inside Asyncify.
  if (type === 'apdu') {
    if (!apduPending || apduPending.id !== id) return;
    if (error) apduPending.reject(new Error(error));
    else apduPending.resolve(new Uint8Array(bytes));
    apduPending = undefined;
    return;
  }
  if (type === 'snapshot') {
    capture.tick(performance.now());
    self.postMessage({ id, snapshot: snapshot() });
    return;
  }
  const length = bytes?.byteLength ?? 0;
  queuedBytes += length;
  peakBytes = Math.max(peakBytes, queuedBytes);
  if (queuedBytes > 8 * 1024 * 1024) failure = 'B25 input queue overflow';
  chain = chain.then(async () => {
    try {
      if (failure) throw new Error(failure);
      if (type === 'open') {
        decoder = await B25Decoder.open(
          serviceId,
          emm,
          (apdu) =>
            new Promise((resolve, reject) => {
              const id = ++nextApdu;
              apduPending = { id, resolve, reject };
              const bytes = apdu.slice().buffer;
              self.postMessage({ type: 'apdu', id, bytes }, { transfer: [bytes] });
            }),
        );
        capture = new TsCapture(undefined, file ? Number.MAX_SAFE_INTEGER : 10000);
        capture.start(performance.now());
      } else if (type === 'chunk') {
        if (!decoder) throw new Error('B25 not initialized');
        await decoder.push(new Uint8Array(bytes), output);
        inputBytes += length;
      } else if (type === 'flush') {
        if (!decoder) throw new Error('B25 not initialized');
        await decoder.flush(output);
        capture.stop();
      } else if (type === 'playback') playback = !!event.data.enabled;
      else if (type === 'data') {
        if (!decoder) throw new Error('B25 not initialized');
        decoder.filter.dataEnabled = !!event.data.enabled;
        decoder.filter.takeData();
      } else if (type === 'record') capture.start(performance.now());
      else if (type === 'download') capture.stop();
      self.postMessage({
        id,
        snapshot: snapshot(),
        blob: type === 'download' ? capture.blob() : undefined,
      });
    } catch (error) {
      failure = String(error);
      decoder?.close();
      decoder = undefined;
      self.postMessage({ id, error: failure, snapshot: snapshot() });
    } finally {
      queuedBytes -= length;
    }
  });
};
