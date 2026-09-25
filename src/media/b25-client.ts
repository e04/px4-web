export interface B25Snapshot {
  inputBytes: number;
  outputBytes: number;
  queuedBytes: number;
  peakBytes: number;
  packets?: number;
  scrambled?: number;
  tei?: number;
  ccErrors?: number;
  found: boolean;
  error?: string;
  capturedBytes: number;
  captureReason: string;
}
interface Reply {
  snapshot: B25Snapshot;
  blob?: Blob;
}
export class B25Worker {
  private readonly worker = new Worker(new URL('../workers/b25.ts', import.meta.url), {
    type: 'module',
  });
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (reply: Reply) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  private inFlightBytes = 0;
  snapshot?: B25Snapshot;
  error?: string;
  onOutput?: (bytes: ArrayBuffer) => void;
  onDataOutput?: (bytes: ArrayBuffer) => void;
  constructor(private readonly apdu: (bytes: Uint8Array) => Promise<Uint8Array>) {
    this.worker.onmessage = (event) => {
      const data = event.data;
      if (data.type === 'clear-ts') {
        this.onOutput?.(data.bytes);
        return;
      }
      if (data.type === 'data-ts') {
        this.onDataOutput?.(data.bytes);
        return;
      }
      if (data.type === 'apdu') {
        void this.apdu(new Uint8Array(data.bytes)).then(
          (bytes) => {
            if (!this.closed) {
              const response = bytes.slice().buffer;
              this.worker.postMessage({ type: 'apdu', id: data.id, bytes: response }, [response]);
            }
          },
          (error) => {
            if (!this.closed)
              this.worker.postMessage({ type: 'apdu', id: data.id, error: String(error) });
          },
        );
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      this.snapshot = data.snapshot;
      if (data.error) {
        this.error = data.error;
        pending.reject(new Error(data.error));
      } else pending.resolve(data);
    };
    this.worker.onerror = () => this.close('B25 Worker failed');
  }
  request(
    type: string,
    options: {
      bytes?: ArrayBuffer;
      serviceId?: number;
      emm?: boolean;
      file?: boolean;
      enabled?: boolean;
    } = {},
  ): Promise<Reply> {
    if (this.closed || this.error) return Promise.reject(new Error(this.error ?? 'B25 closed'));
    if (this.pending.size >= 128) {
      this.close('B25 request queue overflow');
      return Promise.reject(new Error(this.error));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close('B25 response deadline exceeded'), 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...options }, options.bytes ? [options.bytes] : []);
    });
  }
  async push(bytes: ArrayBuffer): Promise<void> {
    const size = bytes.byteLength;
    if (this.inFlightBytes + size > 8 * 1024 * 1024) {
      this.close('B25 input queue overflow');
      throw new Error(this.error);
    }
    this.inFlightBytes += size;
    try {
      await this.request('chunk', { bytes });
    } finally {
      this.inFlightBytes -= size;
    }
  }
  close(reason = 'B25 session closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.error ??= reason;
    this.worker.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
