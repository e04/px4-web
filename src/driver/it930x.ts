export function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 2) {
    sum += bytes[index] << 8;
    if (index + 1 < bytes.length) sum += bytes[index + 1];
  }
  return ~sum & 0xffff;
}

export function createCommand(command: number, sequence: number, payload: Uint8Array): Uint8Array {
  const length = 6 + payload.length;
  if (length > 256) throw new Error('IT930x command is too long');

  const message = new Uint8Array(length);
  message[0] = length - 1;
  message[1] = command >>> 8;
  message[2] = command;
  message[3] = sequence;
  message.set(payload, 4);
  const value = checksum(message.subarray(1, length - 2));
  message[length - 2] = value >>> 8;
  message[length - 1] = value;
  return message;
}

export function parseResponse(message: Uint8Array, sequence: number): Uint8Array {
  if (message.length < 5) throw new Error(`IT930x response is too short (${message.length} bytes)`);
  if (message[0] + 1 !== message.length)
    throw new Error(`IT930x response length mismatch (${message[0] + 1} != ${message.length})`);

  const expected = checksum(message.subarray(1, message.length - 2));
  const actual = (message[message.length - 2] << 8) | message[message.length - 1];
  if (actual !== expected)
    throw new Error(
      `IT930x response checksum mismatch (expected ${hex16(expected)}, got ${hex16(actual)})`,
    );
  if (message[1] !== sequence)
    throw new Error(`IT930x response sequence mismatch (${message[1]} != ${sequence})`);
  if (message[2] !== 0) throw new Error(`IT930x returned error ${message[2]}`);
  return message.slice(3, -2);
}

export function parseFirmwareVersion(bytes: Uint8Array): string {
  if (bytes.length !== 4) throw new Error(`Unexpected firmware version length (${bytes.length})`);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('.');
}

function hex16(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`;
}
