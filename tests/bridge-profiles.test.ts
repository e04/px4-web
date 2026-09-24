import { expect, it, vi } from 'vitest';
import { It930xBridge } from '../src/driver/bridge';

it.each([
  [0x083f, 2, 0xd8c3, 1, 0x17],
  [0x004b, 3, 0xd8b3, 0, 0x47],
  [0x084b, 3, 0xd8b3, 0, 0x47],
  [0x0854, 3, 0xd8b3, 0, 0x47],
  [0x024e, 3, 0xd8c3, 0, 0x17],
  [0x0253, 1, 0xd8c3, 0, 0x17],
  [0x084e, 3, 0xd8c3, 4, 0x17],
])(
  'uses the upstream bus, reset GPIO and TS port for PID %i',
  async (pid, bus, reset, port, tag) => {
    const command = vi.fn(
      async (_command: number, _payload: Uint8Array, length: number) => new Uint8Array(length),
    );
    const bridge = new It930xBridge({ command }, pid);
    const write = vi.spyOn(bridge, 'write').mockResolvedValue();
    vi.spyOn(bridge, 'read').mockResolvedValue(0);
    await bridge.initialize(512);
    expect(write).toHaveBeenCalledWith(reset + 1, 1);
    expect(write).toHaveBeenCalledWith(reset + 2, 1);
    expect(write).toHaveBeenCalledWith(reset, 1);
    expect(write).toHaveBeenCalledWith(0x4971, bus);
    expect(write).toHaveBeenCalledWith(0xda78 + port, tag);
    expect(write).toHaveBeenCalledWith(0xda4c + port, 1);
    expect(write.mock.calls.some(([reg, value]) => reg === 0xd8d3 && value === 1)).toBe(false);
    await bridge.i2cRead(0x11, 2);
    expect(command).toHaveBeenLastCalledWith(0x2a, new Uint8Array([2, bus, 0x22]), 2);
  },
);
