import type { TransportSnapshot } from './pipeline';

interface Reply {
  snapshot?: TransportSnapshot;
  blob?: Blob;
}
export class TransportWorker {
  private worker = new Worker(new URL('../workers/transport.ts', import.meta.url), {
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
  constructor(onTs?: (bytes: ArrayBuffer) => void) {
    this.worker.onmessage = (
      event: MessageEvent<
        Reply & { id: number; error?: string; type?: string; bytes?: ArrayBuffer }
      >,
    ) => {
      if (event.data.type === 'ts') {
        onTs?.(event.data.bytes!);
        return;
      }
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      clearTimeout(pending.timer);
      if (event.data.error) pending.reject(new Error(event.data.error));
      else pending.resolve(event.data);
    };
    this.worker.onerror = () => this.close();
  }
  request(type: string, bytes?: ArrayBuffer): Promise<Reply> {
    if (this.closed) return Promise.reject(new Error('TS Worker closed'));
    if (this.pending.size >= 8) return Promise.reject(new Error('TS Worker queue overflow'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('TS Worker timeout'));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, bytes }, bytes ? [bytes] : []);
    });
  }
  close(): void {
    this.closed = true;
    this.worker.terminate();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('TS Worker closed'));
    }
    this.pending.clear();
  }
}
