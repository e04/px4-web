import createB25 from './generated/b25.js';
import { ServiceFilter } from './service-filter';

export class B25Decoder {
  private initial = new Uint8Array();
  private primed = false;
  private constructor(
    private readonly module: Awaited<ReturnType<typeof createB25>>,
    readonly filter: ServiceFilter,
  ) {}
  static async open(
    serviceId: number,
    emm: boolean,
    apdu: (bytes: Uint8Array) => Promise<Uint8Array>,
  ): Promise<B25Decoder> {
    const filter = new ServiceFilter(serviceId);
    const module = await createB25({ apdu });
    const decoder = new B25Decoder(module, filter);
    try {
      decoder.check(
        await module.ccall('b25_open', 'number', ['number'], [Number(emm)], { async: true }),
      );
      return decoder;
    } catch (error) {
      decoder.close();
      throw error;
    }
  }
  private check(result: number): void {
    if (result < 0 || this.module.cardError)
      throw new Error(this.module.cardError ?? `B25 error ${result}`);
  }
  private output(): Uint8Array {
    const size = this.module._b25_get();
    this.check(size);
    const pointer = this.module._b25_output();
    return this.filter.push(this.module.HEAPU8.subarray(pointer, pointer + size));
  }
  async push(bytes: Uint8Array, output: (bytes: Uint8Array) => void): Promise<void> {
    // libarib25's initial unit-size probe requires at least eight sync intervals.
    if (!this.primed) {
      const first = new Uint8Array(this.initial.length + bytes.length);
      first.set(this.initial);
      first.set(bytes, this.initial.length);
      if (first.length < 188 * 16) {
        this.initial = first;
        return;
      }
      this.initial = new Uint8Array();
      this.primed = true;
      bytes = first;
    }
    for (let offset = 0; offset < bytes.length; offset += 188 * 816) {
      const part = bytes.subarray(offset, offset + 188 * 816);
      this.module.HEAPU8.set(part, this.module._b25_input());
      this.check(
        await this.module.ccall('b25_put', 'number', ['number'], [part.length], { async: true }),
      );
      output(this.output());
    }
  }
  async flush(output: (bytes: Uint8Array) => void): Promise<void> {
    if (!this.primed) throw new Error('TS too short: at least 16 packets required');
    this.check(await this.module.ccall('b25_flush', 'number', [], [], { async: true }));
    output(this.output());
    this.filter.finish();
  }
  close(): void {
    this.module._b25_close();
  }
}
