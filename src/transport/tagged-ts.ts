// SPDX-License-Identifier: GPL-2.0-only
// Synchronization rule: px4_drv ts_sync.h / Px4Device::StreamProcess (nns779).
export class TaggedTs {
  private remainder = new Uint8Array(0);
  private locked = false;
  readonly stats = {
    syncLosses: 0,
    discardedBytes: 0,
    invalidTags: 0,
    packetsByReceiver: [0, 0, 0, 0],
  };
  constructor(
    private readonly packet: (receiver: number, bytes: Uint8Array) => void,
    private readonly lost: () => void = () => {},
  ) {}
  get bufferedBytes(): number {
    return this.remainder.length;
  }
  push(chunk: Uint8Array): void {
    const bytes = new Uint8Array(this.remainder.length + chunk.length);
    bytes.set(this.remainder);
    bytes.set(chunk, this.remainder.length);
    const sync = (offset: number) => (bytes[offset] & 0x8f) === 7;
    let offset = 0;
    while (bytes.length - offset >= 188) {
      if (this.locked && !sync(offset)) {
        this.locked = false;
        this.stats.syncLosses++;
        this.lost();
      }
      if (!this.locked) {
        if (bytes.length - offset < 188 * 4) break;
        if (![0, 188, 376, 564].every((n) => sync(offset + n))) {
          offset++;
          this.stats.discardedBytes++;
          continue;
        }
        this.locked = true;
      }
      const receiver = ((bytes[offset] & 0x70) >>> 4) - 1;
      if (receiver >= 0 && receiver < 4) {
        const packet = bytes.subarray(offset, offset + 188);
        packet[0] = 0x47;
        this.stats.packetsByReceiver[receiver]++;
        this.packet(receiver, packet);
      } else this.stats.invalidTags++;
      offset += 188;
    }
    this.remainder = bytes.slice(offset);
  }
}
