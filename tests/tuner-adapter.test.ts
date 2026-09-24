import { expect, it } from 'vitest';
import createTuner from '../src/driver/generated/tuner';

// Executes the compiled adapter and upstream drivers against an I²C register stub.
// This checks routing/control flow, not RF behavior or hardware timing.
it.each([0, 1, 2, 3])(
  'initializes and switches satellite/terrestrial on adapter model %i',
  async (model) => {
    const writes: number[][] = [];
    const pointers = new Map<number, number>();
    const satelliteAddress = model === 2 ? 0x13 : 0x11;
    const module = await createTuner({
      i2cWrite: async (address, data) => {
        pointers.set(address, data[0]);
        writes.push([address, ...data]);
      },
      i2cRead: async (address, length) => {
        const result = new Uint8Array(length);
        if (address === satelliteAddress && [0xce, 0xe6].includes(pointers.get(address)!))
          result.set([0x40, 0x10]);
        if (address === 0x65 && pointers.get(address) === 0x12) result[0] = 0x40;
        return result;
      },
    });
    const call = (name: string, ...args: number[]) =>
      module.ccall(
        name,
        'number',
        args.map(() => 'number'),
        args,
        { async: true },
      );
    expect(await call('receiver_init', model)).toBe(0);
    expect(await call('receiver_frequency', 1613000, 0)).toBe(0);
    expect(await call('receiver_acquire')).toBe(0);
    expect(await call('receiver_lock')).toBe(1);
    if (model !== 3) {
      expect(await call('receiver_tsid', 0)).toBe(0x4010);
      expect(await call('receiver_select_tsid', 0x4010)).toBe(0);
      expect(await call('receiver_current_tsid')).toBe(0x4010);
      expect(writes).toContainEqual([satelliteAddress, 0x8f, 0x40, 0x10]);
      expect(await call('receiver_tsid', 12)).toBeLessThan(0);
    } else {
      expect(writes).toContainEqual([0x65, 0xe9, 0, 0, 1]);
      expect(await call('receiver_tsid', 0)).toBeLessThan(0);
    }
    expect(await call('receiver_capture')).toBe(0);
    if (model !== 3) {
      expect(writes).toContainEqual([satelliteAddress, 0x1c, 0]);
      expect(writes).toContainEqual([satelliteAddress, 0x1f, 0]);
    }
    expect(await call('receiver_pause')).toBe(0);
    expect(await call('receiver_frequency', 473143, 0)).toBe(0);
    expect(await call('receiver_acquire')).toBe(0);
    expect(await call('receiver_capture')).toBe(0);
    if (model !== 3) expect(writes).toContainEqual([0x10, 0x1d, 0]);
    expect(await call('receiver_stop')).toBe(0);
    expect(await call('receiver_capture')).toBeLessThan(0);
  },
  15000,
);
