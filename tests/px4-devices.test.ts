import { expect, it } from 'vitest';
import {
  PX4_DEVICES,
  PX4_VENDOR_ID,
  hasPx4CardReader,
  parsePx4DevId,
  px4DeviceName,
  px4UsbFilters,
} from '../src/usb/px4-devices';

it('covers the six PX4 family PIDs', () => {
  expect(PX4_VENDOR_ID).toBe(0x0511);
  expect(PX4_DEVICES.map((device) => device.productId).sort((a, b) => a - b)).toEqual([
    0x023f, 0x024a, 0x073f, 0x074a, 0x083f, 0x084a,
  ]);
  expect(px4UsbFilters()).toHaveLength(6);
  expect(px4DeviceName(0x023f)).toBe('PX-W3PE4');
  expect(px4DeviceName(0x084a)).toBe('PX-Q3U4');
  expect(px4DeviceName(0xffff)).toBeUndefined();
});

it('parses the trailing dev_id digit of PX4 serials', () => {
  expect(parsePx4DevId('123456781')).toBe(1);
  expect(parsePx4DevId('123456780')).toBe(0);
  expect(parsePx4DevId(undefined)).toBeNull();
  expect(parsePx4DevId('')).toBeNull();
  expect(parsePx4DevId('ABC123')).toBeNull();
});

it('reports card readers like Px4Device::HasCardReader', () => {
  // W系は常にあり
  expect(hasPx4CardReader(0x023f, '123456780')).toBe(true);
  expect(hasPx4CardReader(0x083f, undefined)).toBe(true);
  // Q系は主側(dev_id 1)のみあり
  expect(hasPx4CardReader(0x024a, '123456781')).toBe(true);
  expect(hasPx4CardReader(0x024a, '123456780')).toBe(false);
  expect(hasPx4CardReader(0x084a, '123456782')).toBe(false);
  // シリアル不明時は試行を妨げない
  expect(hasPx4CardReader(0x024a, undefined)).toBe(true);
});
