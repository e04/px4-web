import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  crc32,
  EXPECTED_FIRMWARE_CRC32,
  parseFirmware,
  type FirmwareImage,
} from '../src/driver/firmware';

// Minimal valid scatter image: 03 xx xx 01 + (hi, lo, len=1) + 1 data byte.
const BLOCK = new Uint8Array([3, 0, 0, 1, 0xf1, 0x03, 1, 0xaa]);

function imageFor(bytes: Uint8Array): FirmwareImage {
  return {
    name: 'it930x-firmware.bin',
    size: bytes.byteLength,
    sha256: '0'.repeat(64),
    blocks: parseFirmware(bytes),
  };
}

describe('parseFirmware', () => {
  it('splits scatter blocks', () => {
    const bytes = new Uint8Array([...BLOCK, ...BLOCK]);
    const blocks = parseFirmware(bytes);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual(BLOCK);
  });

  it('rejects empty, oversized and malformed input', () => {
    expect(() => parseFirmware(new Uint8Array([]))).toThrow();
    expect(() => parseFirmware(new Uint8Array([1, 2, 3, 4]))).toThrow();
    expect(() => parseFirmware(BLOCK.slice(0, 5))).toThrow();
  });

  it('parses the bundled it930x-firmware.bin', () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../firmware/it930x-firmware.bin', import.meta.url)),
    );
    expect(imageFor(bytes).blocks.length).toBeGreaterThan(0);
  });
});

describe('crc32', () => {
  it('matches the IEEE test vector and the known-good firmware', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(EXPECTED_FIRMWARE_CRC32).toBe(0x0b41a994);
    const bytes = new Uint8Array(
      readFileSync(new URL('../firmware/it930x-firmware.bin', import.meta.url)),
    );
    expect(crc32(bytes)).toBe(EXPECTED_FIRMWARE_CRC32);
  });
});
