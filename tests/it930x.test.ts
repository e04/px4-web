import { describe, expect, it } from 'vitest';
import { checksum, createCommand, parseFirmwareVersion, parseResponse } from '../src/driver/it930x';

function response(sequence: number, result: number, payload: number[]): Uint8Array {
  const bytes = new Uint8Array(5 + payload.length);
  bytes[0] = bytes.length - 1;
  bytes[1] = sequence;
  bytes[2] = result;
  bytes.set(payload, 3);
  const value = checksum(bytes.subarray(1, -2));
  bytes[bytes.length - 2] = value >>> 8;
  bytes[bytes.length - 1] = value;
  return bytes;
}

describe('IT930x control protocol', () => {
  it('creates the read-only firmware query used by px4_drv', () => {
    expect([...createCommand(0x0022, 0, new Uint8Array([1]))]).toEqual([
      0x06, 0x00, 0x22, 0x00, 0x01, 0xff, 0xdc,
    ]);
  });

  it('validates and parses a successful response', () => {
    const payload = parseResponse(response(7, 0, [1, 2, 3, 4]), 7);
    expect(parseFirmwareVersion(payload)).toBe('01.02.03.04');
  });

  it('rejects corrupt, stale, and device-error responses', () => {
    const corrupt = response(0, 0, [1, 2, 3, 4]);
    corrupt[3] ^= 1;
    expect(() => parseResponse(corrupt, 0)).toThrow('checksum mismatch');
    expect(() => parseResponse(response(1, 0, []), 0)).toThrow('sequence mismatch');
    expect(() => parseResponse(response(0, 5, []), 0)).toThrow('returned error 5');
  });
});
