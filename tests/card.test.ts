import { afterEach, describe, expect, it, vi } from 'vitest';
import { frame, parseAtr, T1Card } from '../src/card/t1';
import { CardUart, type CardIo } from '../src/card/uart';
import { It930xBridge } from '../src/driver/bridge';

// Direct convention, T=1, IFSC=32, LRC, valid TCK.
const atr = new Uint8Array([0x3b, 0x80, 0x81, 0x11, 0x20, 0x30]);
class MockCard implements CardIo {
  chunks: Uint8Array[] = [];
  sent: Uint8Array[] = [];
  inserted = true;
  handler: (bytes: Uint8Array) => void = () => {};
  async initialize() {}
  async present() {
    return this.inserted;
  }
  async reset() {
    this.chunks = [...atr].map((b) => new Uint8Array([b]));
  }
  async baud() {}
  async read() {
    return this.chunks.shift() ?? new Uint8Array();
  }
  async write(bytes: Uint8Array) {
    this.sent.push(bytes);
    if (bytes[1] === 0xc0) this.chunks.push(frame(0xe0));
    else if (bytes[1] === 0xc1) this.chunks.push(frame(0xe1, bytes.slice(3, 4)));
    else this.handler(bytes);
  }
}
afterEach(() => vi.useRealTimers());
describe('ATR / T=1', () => {
  it('waits for every ATR split and verifies checksum, protocol and limits', () => {
    for (let i = 0; i < atr.length; i++) expect(parseAtr(atr.slice(0, i))).toBeUndefined();
    expect(parseAtr(atr)).toMatchObject({ ifsc: 32, crc: false, baud: 0 });
    const corrupt = atr.slice();
    corrupt[5] ^= 1;
    expect(() => parseAtr(corrupt)).toThrow('checksum');
    expect(() => parseAtr(new Uint8Array([0x3b, 0]))).toThrow('T=1');
    expect(() => parseAtr(new Uint8Array(34))).toThrow();
  });
  it('chains command and response blocks and advances both sequence numbers across APDUs', async () => {
    const io = new MockCard(),
      card = new T1Card(io);
    await card.open();
    let count = 0;
    io.handler = (f) => {
      count++;
      if (count === 1) {
        expect(f[1]).toBe(0x20);
        expect(f[2]).toBe(32);
        io.chunks.push(frame(0x90));
      }
      if (count === 2) {
        expect(f[1]).toBe(0x40);
        io.chunks.push(frame(0x20, new Uint8Array([1, 2])));
      }
      if (count === 3) {
        expect(f[1]).toBe(0x90);
        io.chunks.push(frame(0x40, new Uint8Array([0x90, 0])));
      }
      if (count === 4) {
        expect(f[1]).toBe(0);
        io.chunks.push(frame(0, new Uint8Array([0x90, 0])));
      }
    };
    expect(await card.transmit(new Uint8Array(40))).toEqual(new Uint8Array([1, 2, 0x90, 0]));
    expect(await card.transmit(new Uint8Array([0x90, 0x30, 0, 0, 0]))).toEqual(
      new Uint8Array([0x90, 0]),
    );
    expect(card.stats.apdus).toBe(2);
  });
  it('retransmits only the requested sequence, recovers a lost response and answers WTX', async () => {
    const io = new MockCard(),
      card = new T1Card(io);
    await card.open();
    let count = 0;
    io.handler = (f) => {
      count++;
      if (count === 1) io.chunks.push(frame(0x81));
      if (count === 2) {
        expect(f).toEqual(io.sent[2]);
        io.chunks.push(frame(0x90));
      }
      if (count === 3) {
        expect(f[1]).toBe(0x80);
        io.chunks.push(frame(0xc3, new Uint8Array([2])));
      }
      if (count === 4) {
        expect(f[1]).toBe(0xe3);
        io.chunks.push(frame(0, new Uint8Array([0x90, 0])));
      }
    };
    expect(await card.transmit(new Uint8Array([0x90]))).toEqual(new Uint8Array([0x90, 0]));
    expect(card.stats.retries).toBe(1);
  });
  it('retries damaged EDC and rejects wrong response sequence', async () => {
    const io = new MockCard(),
      card = new T1Card(io);
    await card.open();
    let first = true;
    io.handler = () => {
      const f = frame(0, new Uint8Array([0x90, 0]));
      if (first) {
        f[f.length - 1] ^= 1;
        first = false;
      }
      io.chunks.push(f);
    };
    await card.transmit(new Uint8Array([1]));
    expect(card.stats.retries).toBe(1);
    await expect(card.transmit(new Uint8Array([2]))).rejects.toThrow('sequence');
    expect(card.atr).toBeUndefined();
  });
  it('invalidates on removal and discards an in-flight response after close', async () => {
    const io = new MockCard(),
      card = new T1Card(io);
    await card.open();
    io.inserted = false;
    await expect(card.transmit(new Uint8Array([1]))).rejects.toThrow('removed');
    expect(card.atr).toBeUndefined();
    io.inserted = true;
    await card.open();
    io.handler = () => {
      card.invalidate();
      io.chunks.push(frame(0, new Uint8Array([0x90, 0])));
    };
    await expect(card.transmit(new Uint8Array([1]))).rejects.toThrow('invalidated');
    expect(card.stats.apdus).toBe(0);
  });
  it('caps repeated WTX at the absolute APDU deadline', async () => {
    const io = new MockCard(),
      card = new T1Card(io);
    await card.open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    io.handler = () => {
      setTimeout(() => io.chunks.push(frame(0xc3, new Uint8Array([1]))), 100);
    };
    const assertion = expect(card.transmit(new Uint8Array([1]))).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(3100);
    await assertion;
    expect(card.atr).toBeUndefined();
    expect(card.stats.failures).toBe(1);
  });
  it('negotiates CRC EDC and reassembles a fragmented response', async () => {
    const io = new MockCard();
    io.reset = async () => {
      io.chunks = [new Uint8Array([0x3b, 0x80, 0x81, 0x41, 1, 0x41])];
    };
    io.write = async (f) => {
      io.sent.push(f);
      if (f[1] === 0xc0) io.chunks.push(frame(0xe0, new Uint8Array(), true));
      else if (f[1] === 0xc1) {
        expect(f[3]).toBe(250);
        io.chunks.push(frame(0xe1, f.slice(3, 4), true));
      } else {
        const response = frame(0, new Uint8Array([0x90, 0]), true);
        io.chunks.push(response.slice(0, 3), response.slice(3));
      }
    };
    const card = new T1Card(io);
    await card.open();
    expect(await card.transmit(new Uint8Array([1]))).toEqual(new Uint8Array([0x90, 0]));
    expect(io.sent[0]).toHaveLength(5);
  });
});

it('uses UART bulk commands, read chunks <=32 and real-send before the final <=48-byte write', async () => {
  const calls: { command: number; payload: number[]; length: number }[] = [];
  let remaining = 70;
  const bridge = new It930xBridge({
    command: async (command, payload, length) => {
      calls.push({ command, payload: [...payload], length });
      if (command === 0) return new Uint8Array([payload[5] === 0x6a ? 1 : remaining]);
      if (command === 0x33) {
        remaining -= length;
        return new Uint8Array(length).fill(0x5a);
      }
      return new Uint8Array();
    },
  });
  const uart = new CardUart(bridge);
  expect(await uart.read()).toEqual(new Uint8Array(70).fill(0x5a));
  expect(calls.filter((c) => c.command === 0x33).map((c) => c.length)).toEqual([32, 32, 6]);
  calls.length = 0;
  await uart.write(new Uint8Array(100));
  expect(calls.map((c) => c.command)).toEqual([0x34, 0x34, 1, 0x34]);
  expect(calls[2].payload).toEqual([1, 2, 0, 0, 0x49, 0x65, 1]);
  expect(calls.filter((c) => c.command === 0x34).map((c) => c.payload[0])).toEqual([48, 48, 4]);
});
