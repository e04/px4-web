// SPDX-License-Identifier: GPL-2.0-only
// Adapted from px4_drv driver/it930x.c, Copyright (c) 2018-2021 nns779.
import type { CommandTransport } from '../usb/control';
import type { FirmwareImage } from './firmware';
import { parseFirmwareVersion } from './it930x';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ponytail: single shared deadline helper; per-call AbortSignal if cancellation granularity matters.
export function withTimeout<T>(task: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class It930xBridge {
  constructor(readonly transport: CommandTransport) {}

  async version(): Promise<string> {
    return parseFirmwareVersion(await this.transport.command(0x22, new Uint8Array([1]), 4));
  }

  async boot(firmware: FirmwareImage): Promise<{ mode: 'cold' | 'warm'; version: string }> {
    const version = await this.version();
    if (version !== '00.00.00.00') return { mode: 'warm', version };
    await this.write(0xf103, 7);
    for (const block of firmware.blocks) await this.transport.command(0x29, block, 0);
    await this.transport.command(0x23, new Uint8Array(), 0);
    const running = await this.version();
    if (running === '00.00.00.00') throw new Error('FW boot failed: version is still zero');
    return { mode: 'cold', version: running };
  }

  private registerPayload(reg: number, length: number): number[] {
    const width = reg > 0xffffff ? 4 : reg > 0xffff ? 3 : reg > 0xff ? 2 : 1;
    return [length, width, (reg >>> 24) & 255, (reg >>> 16) & 255, (reg >>> 8) & 255, reg & 255];
  }
  async read(reg: number): Promise<number> {
    return (await this.transport.command(0, new Uint8Array(this.registerPayload(reg, 1)), 1))[0];
  }
  async write(reg: number, ...values: number[]): Promise<void> {
    await this.transport.command(
      1,
      new Uint8Array([...this.registerPayload(reg, values.length), ...values]),
      0,
    );
  }
  async mask(reg: number, value: number, mask: number): Promise<void> {
    await this.write(reg, ((await this.read(reg)) & ~mask) | (value & mask));
  }
  async i2cRead(address: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(length) || length < 1 || length > 251)
      throw new Error('Invalid I²C read length');
    return this.transport.command(0x2a, new Uint8Array([length, 2, address << 1]), length);
  }
  async i2cWrite(address: number, bytes: Uint8Array): Promise<void> {
    if (!bytes.length || bytes.length > 247) throw new Error('Invalid I²C write length');
    await this.transport.command(
      0x2b,
      new Uint8Array([bytes.length, 2, address << 1, ...bytes]),
      0,
    );
  }

  async initialize(maxPacketSize: number): Promise<void> {
    for (const reg of [0x4976, 0x4bfb, 0x4978, 0x4977, 0xda1a]) await this.write(reg, 0);
    await this.mask(0xf41f, 4, 4);
    await this.mask(0xda10, 0, 1);
    await this.mask(0xf41a, 1, 1);
    await this.mask(0xda1d, 1, 1);
    try {
      await this.mask(0xdd11, 0, 0x20);
      await this.mask(0xdd13, 0, 0x20);
      await this.mask(0xdd11, 0x20, 0x20);
      // Reference default XferPackets=816; matches the TS Bulk IN transfer size.
      const threshold = (188 * 816) / 4;
      await this.write(0xdd88, threshold & 255, threshold >>> 8);
      await this.write(0xdd0c, maxPacketSize / 4);
      await this.mask(0xda05, 0, 1);
      await this.mask(0xda06, 0, 1);
    } finally {
      await this.mask(0xda1d, 0, 1);
      await this.write(0xd920, 0);
    }
    for (const [reg, value] of [
      [0xd833, 1],
      [0xd830, 0],
      [0xd831, 1],
      [0xd832, 0],
      [0xf6a7, 7],
      [0xf103, 7],
    ])
      await this.write(reg, value);
    const addresses = [0x11, 0x13, 0x10, 0x12];
    for (let i = 0; i < 4; i++) {
      await this.write(0x4975 - i, addresses[i] << 1);
      await this.write(0x4971 - i, 2);
    }
    for (let port = 1; port <= 4; port++) {
      if (port < 2) await this.write(0xda58 + port, 0);
      await this.write(0xda73 + port, 1);
      await this.write(0xda78 + port, (port << 4) | 7);
      await this.write(0xda4c + port, 1);
    }
    await this.write(0xda4c, 0);
    for (const reg of [0xd8c4, 0xd8b8]) {
      await this.write(reg, 1);
      await this.write(reg + 1, 1);
    }
    await this.power(false);
    await this.write(0xd8d4, 1);
    await this.write(0xd8d5, 1);
    await this.write(0xd8d3, 0); // LNB off
  }

  async power(on: boolean): Promise<void> {
    if (on) {
      await this.write(0xd8c3, 0); // GPIO7 reset release
      await sleep(80);
      await this.write(0xd8b7, 1); // GPIO2 power
      await sleep(20);
    } else {
      let first: unknown;
      try {
        await this.write(0xd8b7, 0);
      } catch (error) {
        first = error;
      }
      try {
        await this.write(0xd8c3, 1);
      } catch (error) {
        first ??= error;
      }
      if (first) throw first;
    }
  }
}
