// SPDX-License-Identifier: GPL-2.0-only
// Adapted from px4_drv SmartCard T=1 state machine. See docs/p3-b25.md.
import { sleep } from '../driver/bridge';
import type { CardIo } from './uart';

class AtrError extends Error {}
export function parseAtr(a: Uint8Array) {
  if (a.length < 2) return;
  if (a.length > 33 || ![0x3b, 0x3f].includes(a[0])) throw new AtrError('Invalid ATR');
  let y = a[1] >> 4,
    offset = 2,
    group = 1,
    protocol = 0;
  let t1 = false,
    nonzero = false,
    baud = 0,
    ifsc = 32,
    crc = false,
    wait = 500;
  while (y) {
    const values: (number | undefined)[] = [];
    for (let bit = 0; bit < 4; bit++) {
      if (y & (1 << bit)) {
        if (offset >= a.length) return;
        values[bit] = a[offset++];
      }
    }
    const [ta, tb, tc, td] = values;
    if (group === 1 && ta !== undefined) {
      if (![0x11, 0x12, 0x13].includes(ta)) throw new Error('Unsupported ATR baud');
      baud = ta === 0x13 ? 0xef : ta - 0x11;
    }
    if (group >= 3 && protocol === 1) {
      if (ta !== undefined) {
        if (!ta || ta === 255) throw new Error('Invalid IFSC');
        ifsc = ta;
      }
      if (tb !== undefined) wait = Math.min(3000, Math.max(500, 100 * 2 ** (tb >> 4)));
      if (tc !== undefined) crc = !!(tc & 1);
    }
    if (td === undefined) break;
    protocol = td & 15;
    t1 ||= protocol === 1;
    nonzero ||= protocol !== 0;
    y = td >> 4;
    group++;
  }
  const length = offset + (a[1] & 15) + Number(nonzero);
  if (length > 33 || a.length > length) throw new AtrError('Invalid ATR length');
  if (a.length < length) return;
  if (!t1) throw new Error('Card requires T=1');
  if (a.subarray(1).reduce((x, v) => x ^ v, 0)) throw new AtrError('ATR checksum');
  return { baud, ifsc, crc, wait };
}
function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}
export function frame(pcb: number, data: Uint8Array = new Uint8Array(), crc = false): Uint8Array {
  const body = new Uint8Array([0, pcb, data.length, ...data]);
  const edc = crc ? [crc16(body) >> 8, crc16(body) & 255] : [body.reduce((x, v) => x ^ v, 0)];
  return new Uint8Array([...body, ...edc]);
}
class RetryError extends Error {}
export class T1Card {
  atr?: Uint8Array;
  readonly stats = { apdus: 0, failures: 0, retries: 0, maxWaitMs: 0 };
  private parameters = { baud: 0, ifsc: 32, crc: false, wait: 500 };
  private sendSequence = 0;
  private receiveSequence = 0;
  private generation = 0;
  private busy = false;
  constructor(private readonly io: CardIo) {}
  async checkPresence(): Promise<void> {
    const generation = this.generation;
    if (!(await this.io.present())) {
      this.invalidate();
      throw new Error('Card removed');
    }
    if (generation !== this.generation) throw new Error('Card session invalidated');
  }
  invalidate(): void {
    this.generation++;
    this.atr = undefined;
    this.sendSequence = this.receiveSequence = 0;
  }
  private check(generation: number, deadline: number): void {
    if (generation !== this.generation) throw new Error('Card session invalidated');
    if (performance.now() >= deadline) throw new RetryError('Card timeout');
  }
  private async receive(deadline: number, generation: number, atr = false): Promise<Uint8Array> {
    const bytes: number[] = [];
    while (true) {
      this.check(generation, deadline);
      if (!(await this.io.present())) throw new Error('Card removed');
      const part = await this.io.read();
      this.check(generation, deadline);
      bytes.push(...part);
      const a = new Uint8Array(bytes);
      if (atr) {
        if (parseAtr(a)) return a;
      } else if (a.length >= 3) {
        const length = 3 + a[2] + (this.parameters.crc ? 2 : 1);
        if (length > 255) throw new Error('T=1 frame overflow');
        if (a.length >= length) {
          // Late duplicate responses can share a UART read. Drain bounded residual data.
          if (a.length > length || part.length === 255) {
            for (let i = 0; i < 4; i++) {
              this.check(generation, deadline);
              if (!(await this.io.read()).length) break;
              if (i === 3) throw new Error('UART residual overflow');
            }
          }
          const f = a.slice(0, length);
          if (f[0]) throw new Error('T=1 NAD');
          const expected = frame(f[1], f.slice(3, 3 + f[2]), this.parameters.crc);
          if (!f.every((v, i) => v === expected[i])) throw new RetryError('T=1 EDC');
          return f;
        }
      }
      await sleep(5);
    }
  }
  private async exchange(
    pcb: number,
    data: Uint8Array,
    deadline: number,
    generation: number,
  ): Promise<Uint8Array> {
    for (let retry = 0; retry < 3; retry++) {
      this.check(generation, deadline);
      await this.io.write(frame(pcb, data, this.parameters.crc));
      try {
        let f = await this.receive(
          Math.min(deadline, performance.now() + this.parameters.wait),
          generation,
        );
        while (f[1] === 0xc3) {
          if (f[2] !== 1 || !f[3] || f[3] > 59) throw new Error('Invalid WTX');
          this.check(generation, deadline);
          await this.io.write(frame(0xe3, f.slice(3, 4), this.parameters.crc));
          f = await this.receive(deadline, generation);
        }
        return f;
      } catch (error) {
        if (!(error instanceof RetryError) || retry === 2) throw error;
        this.stats.retries++;
      }
    }
    throw new Error('T=1 retries exhausted');
  }
  async open(): Promise<void> {
    if (this.busy) throw new Error('Card busy');
    this.busy = true;
    this.invalidate();
    const generation = this.generation;
    const openingDeadline = performance.now() + 5000;
    try {
      await this.io.initialize();
      this.check(generation, openingDeadline);
      if (!(await this.io.present())) throw new Error('Card absent');
      this.check(generation, openingDeadline);
      let atr: Uint8Array | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.io.reset();
        this.check(generation, openingDeadline);
        try {
          atr = await this.receive(performance.now() + 1000, generation, true);
          break;
        } catch (error) {
          if (!(error instanceof AtrError) || attempt) throw error;
        }
      }
      if (!atr) throw new Error('ATR unavailable');
      this.parameters = parseAtr(atr)!;
      await this.io.baud(this.parameters.baud);
      this.check(generation, openingDeadline);
      const deadline = performance.now() + 3000;
      const sync = await this.exchange(0xc0, new Uint8Array(), deadline, generation);
      if (sync[1] !== 0xe0 || sync[2]) throw new Error('T=1 RESYNCH');
      const ifsd = this.parameters.crc ? 250 : 251;
      const ifs = await this.exchange(0xc1, new Uint8Array([ifsd]), deadline, generation);
      if (ifs[1] !== 0xe1 || ifs[2] !== 1 || ifs[3] !== ifsd) throw new Error('T=1 IFS');
      this.check(generation, deadline);
      this.atr = atr;
    } catch (error) {
      this.invalidate();
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async transmit(apdu: Uint8Array): Promise<Uint8Array> {
    if (this.busy || !this.atr) throw new Error('Card not ready / busy');
    if (!apdu.length || apdu.length > 261) throw new Error('APDU length');
    this.busy = true;
    const generation = this.generation,
      start = performance.now(),
      deadline = start + 3000;
    try {
      if (!(await this.io.present())) throw new Error('Card removed');
      let f: Uint8Array = new Uint8Array();
      for (let offset = 0; offset < apdu.length;) {
        const part = apdu.slice(
          offset,
          offset + Math.min(this.parameters.ifsc, this.parameters.crc ? 250 : 251),
        );
        const more = offset + part.length < apdu.length;
        const pcb = (this.sendSequence << 6) | (more ? 0x20 : 0);
        let accepted = false;
        for (let retry = 0; retry < 3; retry++) {
          f = await this.exchange(pcb, part, deadline, generation);
          if ((f[1] & 0xc0) === 0x80) {
            if (f[2] || f[1] & 0x2c) throw new Error('Invalid R block');
            if (((f[1] >> 4) & 1) === this.sendSequence) {
              this.stats.retries++;
              continue;
            }
            if (f[1] & 15) throw new Error('R block error acknowledgement');
          } else if (f[1] & 0x80 || more) throw new Error('Unexpected T=1 block');
          accepted = true;
          break;
        }
        if (!accepted) throw new Error('T=1 retransmit exhausted');
        this.sendSequence ^= 1;
        offset += part.length;
        if (!more && f[1] & 0x80) {
          for (let retry = 0; retry < 3; retry++) {
            f = await this.exchange(
              0x80 | (this.receiveSequence << 4),
              new Uint8Array(),
              deadline,
              generation,
            );
            if (!(f[1] & 0x80)) break;
            if ((f[1] & 0xc0) !== 0x80 || retry === 2) throw new Error('T=1 lost response');
          }
        }
      }
      const response: number[] = [];
      while (true) {
        if (f[1] & 0x9f || ((f[1] >> 6) & 1) !== this.receiveSequence)
          throw new Error('T=1 response sequence');
        response.push(...f.slice(3, 3 + f[2]));
        if (response.length > 4096) throw new Error('APDU response overflow');
        this.receiveSequence ^= 1;
        if (!(f[1] & 0x20)) break;
        f = await this.exchange(
          0x80 | (this.receiveSequence << 4),
          new Uint8Array(),
          deadline,
          generation,
        );
      }
      this.check(generation, deadline);
      this.stats.apdus++;
      return new Uint8Array(response);
    } catch (error) {
      this.stats.failures++;
      this.invalidate();
      throw error;
    } finally {
      this.busy = false;
      this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, performance.now() - start);
    }
  }
}
