import firmwareUrl from '../../firmware/it930x-firmware.bin?url';

export interface FirmwareImage {
  name: string;
  size: number;
  sha256: string;
  blocks: Uint8Array[];
}

// Known-good it930x-firmware.bin (2169 bytes).
export const EXPECTED_FIRMWARE_CRC32 = 0x0b41a994;

// IEEE CRC-32 without dependencies.
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// IT930x scatter format: 03 xx xx count, count * (address-hi, address-lo, length), data.
export function parseFirmware(bytes: Uint8Array): Uint8Array[] {
  if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('FW size must be 1 byte–1 MiB');
  const blocks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 4 || bytes[offset] !== 3)
      throw new Error(`Invalid FW header at ${offset}`);
    const count = bytes[offset + 3];
    const header = 4 + count * 3;
    if (!count || offset + header > bytes.length)
      throw new Error(`Truncated/empty FW descriptor at ${offset}`);
    let dataLength = 0;
    for (let index = 0; index < count; index++) dataLength += bytes[offset + 6 + index * 3];
    const length = header + dataLength;
    if (!dataLength || length > 250 || offset + length > bytes.length)
      throw new Error(`Invalid FW block length ${length} at ${offset}`);
    blocks.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return blocks;
}

// The binary is bundled at build time (px4_drv etc/it930x-firmware.bin,
// fetched by CI; firmware/it930x-firmware.bin locally) — never uploaded.
export async function loadBundledFirmware(): Promise<FirmwareImage> {
  const response = await fetch(firmwareUrl);
  if (!response.ok) throw new Error(`Firmware fetch failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = crc32(bytes);
  if (actual !== EXPECTED_FIRMWARE_CRC32)
    throw new Error(
      `Firmware CRC32 mismatch: expected 0b41a994, got ${actual.toString(16).padStart(8, '0')}`,
    );
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return {
    name: 'it930x-firmware.bin',
    size: bytes.byteLength,
    sha256: [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    blocks: parseFirmware(bytes),
  };
}
