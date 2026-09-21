import { createCommand, parseResponse } from '../driver/it930x';
import { withTimeout } from '../driver/bridge';

export interface CommandTransport {
  command(command: number, payload: Uint8Array, responseLength: number): Promise<Uint8Array>;
}

export interface ControlTrace {
  timestamp: string;
  command: number;
  request: number[];
  response?: number[];
  error?: string;
}

export class UsbControl implements CommandTransport {
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private failure?: Error;
  constructor(
    private readonly device: USBDevice,
    private readonly trace: (entry: ControlTrace) => void = () => {},
    private readonly timeoutMs = 3000,
  ) {}

  invalidate(reason = 'USB session closed'): void {
    this.failure ??= new Error(reason);
  }

  command(command: number, payload: Uint8Array, responseLength: number): Promise<Uint8Array> {
    const copy = payload.slice();
    // UART carries card identifiers and key material; diagnostic JSON records no UART bytes.
    const sensitive = command === 0x33 || command === 0x34;
    const operation = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      const sequence = this.sequence++ & 0xff;
      const request = createCommand(command, sequence, copy);
      const entry: ControlTrace = {
        timestamp: new Date().toISOString(),
        command,
        request: sensitive ? [] : [...request],
      };
      const transfer = async () => {
        const out = await this.device.transferOut(2, new Uint8Array(request).buffer);
        if (this.failure) throw this.failure;
        if (out.status !== 'ok' || out.bytesWritten !== request.length)
          throw new Error(
            `USB OUT: ${out.status}, ${out.bytesWritten ?? 0}/${request.length} bytes`,
          );
        const input = await this.device.transferIn(1, 256);
        if (this.failure) throw this.failure;
        if (input.status !== 'ok' || !input.data) throw new Error(`USB IN: ${input.status}`);
        const bytes = new Uint8Array(
          input.data.buffer,
          input.data.byteOffset,
          input.data.byteLength,
        );
        entry.response = sensitive ? [] : [...bytes];
        const result = parseResponse(bytes, sequence);
        if (result.length !== responseLength)
          throw new Error(
            `IT930x payload length: expected ${responseLength}, got ${result.length}`,
          );
        return result;
      };
      try {
        return await withTimeout(transfer(), this.timeoutMs, () => {
          this.invalidate(`USB command 0x${command.toString(16)} timed out; reconnect required`);
          // A deadline does not abort WebUSB. Poison the queue before requesting close.
          void this.device.close().catch(() => {});
          return this.failure!;
        });
      } catch (error) {
        this.invalidate(error instanceof Error ? error.message : String(error));
        entry.error = this.failure!.message;
        throw this.failure;
      } finally {
        this.trace(entry);
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
