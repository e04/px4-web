// Clear TS recording spooled to IndexedDB, so long recordings do not sit in memory.
const DB_NAME = 'px4-recording';
const STORE = 'chunks';
// Chunks are batched into one record per flush; at ~17 Mbps a second is ~2 MiB.
const FLUSH_MS = 1000;
const FLUSH_BYTES = 8 * 1024 * 1024;

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE, { autoIncrement: true });
  return done(request);
}

export class TsRecorder {
  private pending: Uint8Array<ArrayBuffer>[] = [];
  private pendingBytes = 0;
  private writing = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private stopped = false;
  bytes = 0;
  error?: string;
  /** Called once when a write fails; the recording is stopped by the owner. */
  onError?: (error: string) => void;

  private constructor(private readonly db: IDBDatabase) {
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
  }

  /** Clears the previous recording, which is kept until now so its download can finish. */
  static async start(): Promise<TsRecorder> {
    const db = await openDb();
    await done(db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
    return new TsRecorder(db);
  }

  /** Copies the chunk: the caller may transfer the buffer right after. */
  push(bytes: ArrayBuffer): void {
    if (this.stopped || this.error) return;
    this.pending.push(new Uint8Array(bytes.slice(0)));
    this.pendingBytes += bytes.byteLength;
    this.bytes += bytes.byteLength;
    if (this.pendingBytes >= FLUSH_BYTES) this.flush();
  }

  private flush(): void {
    if (!this.pendingBytes || this.error) return;
    const blob = new Blob(this.pending, { type: 'video/mp2t' });
    this.pending = [];
    this.pendingBytes = 0;
    this.writing = this.writing.then(async () => {
      if (this.error) return;
      try {
        await done(this.db.transaction(STORE, 'readwrite').objectStore(STORE).add(blob));
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.onError?.(this.error);
      }
    });
  }

  /** Flushes and returns the whole recording; stored blobs stay on disk until the next start. */
  async stop(): Promise<Blob> {
    this.stopped = true;
    clearInterval(this.timer);
    this.flush();
    await this.writing;
    const chunks = await done(
      this.db.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<Blob[]>,
    );
    this.db.close();
    return new Blob(chunks, { type: 'video/mp2t' });
  }
}

/** The last few seconds of clear TS, so a recording can start before the button press. */
export class TsPreroll {
  private chunks: { at: number; bytes: ArrayBuffer }[] = [];
  constructor(private readonly durationMs = 10_000) {}

  /** Copies the chunk: the caller may transfer the buffer right after. */
  push(bytes: ArrayBuffer, now = Date.now()): void {
    this.chunks.push({ at: now, bytes: bytes.slice(0) });
    const cutoff = now - this.durationMs;
    let drop = 0;
    while (drop < this.chunks.length && this.chunks[drop].at < cutoff) drop++;
    if (drop) this.chunks.splice(0, drop);
  }

  /** Hands over the buffered chunks with the arrival time of the oldest, and empties the buffer. */
  take(): { chunks: ArrayBuffer[]; startedAt?: number } {
    const taken = this.chunks;
    this.chunks = [];
    return { chunks: taken.map((chunk) => chunk.bytes), startedAt: taken[0]?.at };
  }

  reset(): void {
    this.chunks = [];
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
