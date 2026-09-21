// SPDX-License-Identifier: GPL-2.0-only
// Port of px4_drv it930x.c (nns779 and contributors), see docs/p3-b25.md.
import { It930xBridge, sleep } from '../driver/bridge';

export interface CardIo {
  initialize(): Promise<void>;
  present(): Promise<boolean>;
  reset(): Promise<void>;
  baud(value: number): Promise<void>;
  read(): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
}
export class CardUart implements CardIo {
  constructor(private readonly bridge: It930xBridge) {}
  async initialize(): Promise<void> {
    await this.bridge.transport.command(0x37, new Uint8Array([1]), 0);
    await this.bridge.write(0xd8c8, 0);
    await this.bridge.write(0xd8c9, 1);
  }
  async present(): Promise<boolean> {
    return (await this.bridge.read(0xd8c6)) === 0;
  }
  async baud(value: number): Promise<void> {
    await this.bridge.transport.command(0x35, new Uint8Array([value]), 0);
  }
  async reset(): Promise<void> {
    await this.bridge.write(0xd8e4, 1);
    await this.bridge.write(0xd8e5, 1);
    await this.bridge.write(0xd8e3, 0);
    await this.bridge.write(0x7904, 2);
    await this.baud(0);
    await sleep(5);
    await this.bridge.write(0xd8e3, 1);
  }
  async read(): Promise<Uint8Array> {
    if (!(await this.bridge.read(0x496a))) return new Uint8Array();
    const bytes: number[] = [];
    while (bytes.length < 255) {
      const count = Math.min(await this.bridge.read(0x496b), 32, 255 - bytes.length);
      if (!count) break;
      bytes.push(...(await this.bridge.transport.command(0x33, new Uint8Array([count]), count)));
    }
    return new Uint8Array(bytes);
  }
  async write(bytes: Uint8Array): Promise<void> {
    if (!bytes.length || bytes.length > 255) throw new Error('UART frame length');
    for (let offset = 0; offset < bytes.length; offset += 48) {
      const part = bytes.subarray(offset, offset + 48);
      if (offset + part.length === bytes.length) await this.bridge.write(0x4965, 1);
      await this.bridge.transport.command(0x34, new Uint8Array([part.length, ...part]), 0);
    }
  }
}
