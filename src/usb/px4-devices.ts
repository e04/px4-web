// SPDX-License-Identifier: GPL-2.0-only
// PX4 family catalog adapted from px4_drv driver/px4_usb.h and
// Px4Device::HasCardReader / ParseSerialNumber in px4_device.cpp (nns779).
export const PX4_VENDOR_ID = 0x0511;

export interface Px4DeviceDefinition {
  productId: number;
  name: string;
  /** Q系は同一筐体に2 USBデバイスがぶら下がる (reference README 技術情報) */
  dualDevice: boolean;
}

export const PX4_DEVICES: Px4DeviceDefinition[] = [
  { productId: 0x083f, name: 'PX-W3U4', dualDevice: false },
  { productId: 0x084a, name: 'PX-Q3U4', dualDevice: true },
  { productId: 0x023f, name: 'PX-W3PE4', dualDevice: false },
  { productId: 0x024a, name: 'PX-Q3PE4', dualDevice: true },
  { productId: 0x073f, name: 'PX-W3PE5', dualDevice: false },
  { productId: 0x074a, name: 'PX-Q3PE5', dualDevice: true },
];

const Q_FAMILY = new Set([0x084a, 0x024a, 0x074a]);

export function px4DeviceName(productId: number): string | undefined {
  return PX4_DEVICES.find((device) => device.productId === productId)?.name;
}

export function px4UsbFilters(): USBDeviceFilter[] {
  return PX4_DEVICES.map((device) => ({ vendorId: PX4_VENDOR_ID, productId: device.productId }));
}

/** PX4系シリアル末尾1桁が筐体内デバイス番号。不明時は null。 */
export function parsePx4DevId(serialNumber: string | undefined): number | null {
  if (!serialNumber || !/^[0-9]+$/.test(serialNumber)) return null;
  return Number(serialNumber.slice(-1));
}

/**
 * Q系は物理カードスロットが主デバイス側の1個だけ。シリアル不明時は
 * 試行を妨げないよう true (B25開始時の明示エラーを優先)。
 */
export function hasPx4CardReader(productId: number, serialNumber: string | undefined): boolean {
  if (!Q_FAMILY.has(productId)) return true;
  const devId = parsePx4DevId(serialNumber);
  if (devId == null) return true;
  return devId === 1;
}
