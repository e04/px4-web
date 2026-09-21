import { TsPipeline } from '../transport/pipeline';

const pipeline = new TsPipeline();
let forward = false;
// One Worker per capture session: old PSI, packet tails and counters cannot enter a new tune.
self.onmessage = (event: MessageEvent<{ id: number; type: string; bytes?: ArrayBuffer }>) => {
  const { id, type, bytes } = event.data;
  try {
    if (type === 'forward') forward = true;
    if (type === 'chunk') {
      const output = pipeline.push(new Uint8Array(bytes!), performance.now());
      if (forward && output.length)
        self.postMessage({ type: 'ts', bytes: output.buffer }, { transfer: [output.buffer] });
    }
    if (type === 'capture') pipeline.capture.start(performance.now());
    if (type === 'stop') pipeline.capture.stop();
    self.postMessage({
      id,
      snapshot: type !== 'chunk' ? pipeline.snapshot(performance.now()) : undefined,
      blob: type === 'download' ? pipeline.capture.blob() : undefined,
    });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
