import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReceiverSession } from '../src/usb/receiver-session';
import { B25Worker } from '../src/media/b25-client';
import { T1Card } from '../src/card/t1';

const mocks = vi.hoisted(() => ({
  mask: vi.fn(async () => {}),
  power: vi.fn(async () => {}),
  i2cWrite: vi.fn(async () => {}),
  workerRequest: vi.fn(async (_type: string, _bytes?: ArrayBuffer) => ({
    blob: new Blob(),
    snapshot: undefined,
  })),
  workerClose: vi.fn(),
  b25Request: vi.fn(async () => ({ snapshot: undefined })),
}));
vi.mock('../src/driver/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/driver/bridge')>();
  return {
    ...actual,
    It930xBridge: class {
      mask = mocks.mask;
      power = mocks.power;
      i2cWrite = mocks.i2cWrite;
    },
    sleep: async () => {},
  };
});
vi.mock('../src/transport/worker-client', () => ({
  TransportWorker: class {
    request = mocks.workerRequest;
    close = mocks.workerClose;
  },
}));
vi.mock('../src/media/b25-client', () => ({
  B25Worker: class {
    request = mocks.b25Request;
    close = vi.fn();
  },
}));

function usb() {
  const endpoints = [
    { endpointNumber: 2, direction: 'out' },
    { endpointNumber: 1, direction: 'in' },
    { endpointNumber: 4, direction: 'in' },
  ].map((e) => ({ ...e, type: 'bulk', packetSize: 512 }));
  const alternate = { alternateSetting: 0, endpoints };
  const configuration = {
    configurationValue: 1,
    interfaces: [{ interfaceNumber: 0, alternate, alternates: [alternate] }],
  };
  const pending: ((r: USBInTransferResult) => void)[] = [];
  const device = {
    opened: false,
    vendorId: 0x0511,
    productId: 0x023f,
    productName: 'PXW3PE4',
    serialNumber: '123456781',
    configuration,
    configurations: [configuration],
    open: vi.fn(async () => {
      device.opened = true;
    }),
    close: vi.fn(async () => {
      device.opened = false;
      for (const resolve of pending) resolve({ status: 'stall' });
    }),
    claimInterface: vi.fn(async () => {}),
    releaseInterface: vi.fn(async () => {}),
    transferIn: vi.fn(
      async (): Promise<USBInTransferResult> => new Promise((resolve) => pending.push(resolve)),
    ),
  };
  let disconnect: (e: USBConnectionEvent) => void = () => {};
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', {
    usb: {
      requestDevice: vi.fn(async () => device),
      addEventListener: (_type: string, handler: typeof disconnect) => {
        disconnect = handler;
      },
      removeEventListener: vi.fn(),
    },
  });
  return {
    device,
    pending,
    settle: () => {
      const count = pending.length;
      for (let i = 0; i < count; i++)
        pending[i]({ status: 'ok', data: new DataView(new ArrayBuffer(0)) });
    },
    unplug: () => disconnect({ device } as unknown as USBConnectionEvent),
  };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('requests any of the six PX4 family PIDs and records the device info', async () => {
  const { device } = usb();
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  const requestDevice = vi.mocked(
    (navigator as unknown as { usb: { requestDevice: (...args: unknown[]) => Promise<unknown> } })
      .usb.requestDevice,
  );
  const filters = (
    requestDevice.mock.calls[0][0] as {
      filters: { vendorId: number; productId: number }[];
    }
  ).filters;
  expect(device.productId).toBe(0x023f);
  expect(filters).toHaveLength(6);
  expect(filters.map((filter) => filter.productId).sort((a: number, b: number) => a - b)).toEqual([
    0x023f, 0x024a, 0x073f, 0x074a, 0x083f, 0x084a,
  ]);
  expect(session.deviceInfo).toMatchObject({
    productId: 0x023f,
    productName: 'PXW3PE4',
    hasCardReader: true,
  });
  await session.close();
});

it('rejects B25 on the card-less side of a Q model', async () => {
  const { device } = usb();
  (device as unknown as { productId: number }).productId = 0x024a;
  (device as unknown as { serialNumber: string }).serialNumber = '123456780';
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  expect(session.deviceInfo.hasCardReader).toBe(false);
  await expect(session.startB25(1032, true)).rejects.toThrow('No card reader');
  await session.close();
});

it('retunes on the same USB session without reconnecting, and rejects reuse after close', async () => {
  const { device, pending, settle } = usb();
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  session.receiver.state = 'locked';
  await session.startCapture();
  expect(mocks.mask.mock.calls).toEqual([
    [0xda1d, 1, 1],
    [0xda1d, 0, 1],
  ]);
  expect(mocks.i2cWrite).toHaveBeenCalledWith(0x10, new Uint8Array([0x1d, 0]));
  expect(mocks.i2cWrite.mock.invocationCallOrder[0]).toBeLessThan(
    device.transferIn.mock.invocationCallOrder[0],
  );
  expect(device.transferIn.mock.calls[0]).toEqual([4, 188 * 816]);
  expect(pending).toHaveLength(4);
  expect(session.receiver.state).toBe('streaming');
  vi.spyOn(session.receiver, 'tune').mockImplementation(async () => {
    session.receiver.state = 'locked';
    return { demodLocked: true } as never;
  });
  const retune = session.retune(26);
  expect(session.receiver.tune).not.toHaveBeenCalled();
  settle();
  await retune;
  expect(session.receiver.tune).toHaveBeenCalledWith(26);
  expect(device.close).not.toHaveBeenCalled();
  expect(mocks.workerClose).toHaveBeenCalledTimes(1);
  expect(pending).toHaveLength(8);
  expect(mocks.mask).toHaveBeenCalledTimes(4);
  expect(session.receiver.state).toBe('streaming');
  await session.close();
  await session.close();
  expect(device.close).toHaveBeenCalledTimes(1);
  expect(mocks.workerClose).toHaveBeenCalledTimes(2);
  expect(mocks.workerRequest.mock.calls.some(([type]) => type === 'chunk')).toBe(false);
  expect(session.receiver.state).toBe('disconnected');
  await expect(session.startCapture()).rejects.toThrow();
  await expect(session.retune(26)).rejects.toThrow();
});

it('retune propagates a lock failure without reconnecting the device', async () => {
  const { device, settle } = usb();
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  session.receiver.state = 'locked';
  await session.startCapture();
  vi.spyOn(session.receiver, 'tune').mockResolvedValue({
    demodLocked: false,
    timeout: 'demod',
  } as never);
  const retune = session.retune(27);
  settle();
  await expect(retune).rejects.toThrow('could not be locked');
  expect(device.close).not.toHaveBeenCalled();
  await session.close();
});

it('enables TS pins when retuning from ready before any capture', async () => {
  const { device } = usb();
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  session.receiver.state = 'ready';
  vi.spyOn(session.receiver, 'tune').mockImplementation(async () => {
    session.receiver.state = 'locked';
    return { demodLocked: true } as never;
  });
  await session.retune(26);
  expect(mocks.i2cWrite).toHaveBeenCalledWith(0x10, new Uint8Array([0x1d, 0]));
  expect(mocks.i2cWrite.mock.invocationCallOrder[0]).toBeLessThan(
    device.transferIn.mock.invocationCallOrder[0],
  );
  expect(session.receiver.state).toBe('streaming');
  await session.close();
});

it('ignores an old B25 snapshot failure after retuning and allows playback to restart', async () => {
  const { settle } = usb();
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  session.receiver.state = 'locked';
  await session.startCapture();
  const card = new T1Card({} as never);
  card.atr = new Uint8Array([1]);
  vi.spyOn(card, 'checkPresence').mockResolvedValue();
  const invalidate = vi.spyOn(card, 'invalidate');
  session.card = card;
  session.b25 = new B25Worker(async (bytes) => bytes);
  let rejectSnapshot!: (error: Error) => void;
  mocks.b25Request.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectSnapshot = reject;
      }),
  );
  const refresh = session.refreshTransport();
  await vi.waitFor(() => expect(rejectSnapshot).toBeTypeOf('function'));
  vi.spyOn(session.receiver, 'tune').mockImplementation(async () => {
    session.receiver.state = 'locked';
    return { demodLocked: true } as never;
  });
  const retune = session.retune(26);
  settle();
  await retune;
  await session.startB25(1032, true);
  const current = session.b25;
  rejectSnapshot(new Error('B25 session closed'));
  await refresh;
  expect(session.b25Error).toBeUndefined();
  expect(invalidate).not.toHaveBeenCalled();
  expect(current!.close).not.toHaveBeenCalled();
  await session.close();
});

it('reopens the card on playback retry after a current B25 failure', async () => {
  usb();
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  session.receiver.state = 'locked';
  await session.startCapture();
  const card = new T1Card({} as never);
  card.atr = new Uint8Array([1]);
  vi.spyOn(card, 'checkPresence').mockResolvedValue();
  const open = vi.spyOn(card, 'open').mockImplementation(async () => {
    card.atr = new Uint8Array([1]);
  });
  session.card = card;
  session.b25 = new B25Worker(async (bytes) => bytes);
  mocks.b25Request.mockRejectedValueOnce(new Error('B25 failed'));
  await session.refreshTransport();
  expect(session.b25Error).toContain('B25 failed');
  expect(card.atr).toBeUndefined();
  await session.startB25(1032, true);
  expect(open).toHaveBeenCalledOnce();
  expect(session.b25Error).toBeUndefined();
  expect(session.b25ServiceId).toBe(1032);
  await session.close();
});

it('does not attach an old B25 open to a new channel or invalidate its card', async () => {
  const { settle } = usb();
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  session.receiver.state = 'locked';
  await session.startCapture();
  const card = new T1Card({} as never);
  card.atr = new Uint8Array([1]);
  const invalidate = vi.spyOn(card, 'invalidate');
  session.card = card;
  let finishOpen!: () => void;
  mocks.b25Request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOpen = () => resolve({ snapshot: undefined });
      }),
  );
  const opening = session.startB25(1032, true);
  await vi.waitFor(() => expect(finishOpen).toBeTypeOf('function'));
  vi.spyOn(session.receiver, 'tune').mockImplementation(async () => {
    session.receiver.state = 'locked';
    return { demodLocked: true } as never;
  });
  const retune = session.retune(26);
  settle();
  await retune;
  finishOpen();
  await expect(opening).rejects.toThrow('superseded');
  expect(invalidate).not.toHaveBeenCalled();
  expect(session.b25).toBeUndefined();
  await session.startB25(1032, true);
  await session.close();
});

it('requires reconnection if a timed-out Bulk IN is still pending', async () => {
  vi.useFakeTimers();
  const { device, pending } = usb();
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  session.receiver.state = 'locked';
  await session.startCapture();
  await vi.advanceTimersByTimeAsync(5000);
  expect(device.close).not.toHaveBeenCalled();
  expect(session.streamError).toContain('timeout');
  expect(session.receiver.state).toBe('streaming');
  expect(device.opened).toBe(true);
  expect(session.receiving).toBe(false);
  await expect(session.startB25(1032, true)).rejects.toThrow('Start TS reception');
  await expect(session.recordTs()).rejects.toThrow('Start TS reception');
  // A WebUSB timeout does not cancel the physical transfer.
  vi.spyOn(session.receiver, 'tune').mockResolvedValue({ demodLocked: true } as never);
  const retune = session.retune(26);
  const assertion = expect(retune).rejects.toThrow('reconnect required');
  await vi.advanceTimersByTimeAsync(5000);
  await assertion;
  expect(session.receiver.tune).not.toHaveBeenCalled();
  expect(device.close).toHaveBeenCalledOnce();
  expect(pending.length).toBeGreaterThan(0);
  await session.close();
});

it('retune can be retried after a lock failure without reconnecting', async () => {
  const { device, settle } = usb();
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  session.receiver.state = 'locked';
  await session.startCapture();
  const tune = vi
    .spyOn(session.receiver, 'tune')
    .mockImplementationOnce(async () => {
      session.receiver.state = 'ready';
      return { demodLocked: false, timeout: 'demod' } as never;
    })
    .mockImplementation(async () => {
      session.receiver.state = 'locked';
      return { demodLocked: true } as never;
    });
  const first = session.retune(27);
  settle();
  await expect(first).rejects.toThrow('could not be locked');
  expect(device.close).not.toHaveBeenCalled();
  await session.retune(28);
  expect(tune).toHaveBeenCalledTimes(2);
  expect(device.close).not.toHaveBeenCalled();
  await session.close();
});

it('cleans up on unplug and does not forward stale pending transfers', async () => {
  const { unplug } = usb();
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  session.receiver.state = 'locked';
  await session.startCapture();
  unplug();
  await session.close();
  expect(session.receiver.state).toBe('disconnected');
  expect(mocks.workerRequest.mock.calls.some(([type]) => type === 'chunk')).toBe(false);
  expect(mocks.workerClose).toHaveBeenCalledTimes(1);
});

it('closes after stream reset failure without enabling TS', async () => {
  const { device } = usb();
  mocks.mask.mockRejectedValueOnce(new Error('reset failed'));
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  session.receiver.state = 'locked';
  await expect(session.startCapture()).rejects.toThrow('reset failed');
  expect(mocks.i2cWrite).not.toHaveBeenCalled();
  expect(device.close).toHaveBeenCalledTimes(1);
});

it('stopping during stream reset invalidates start before TS pins can be enabled', async () => {
  const { device } = usb();
  let resolveReset!: () => void;
  mocks.mask.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveReset = resolve;
      }),
  );
  const session = await ReceiverSession.connect(
    () => {},
    () => {},
  );
  session.receiver.state = 'locked';
  const start = session.startCapture();
  const assertion = expect(start).rejects.toThrow('stopped');
  await vi.waitFor(() => expect(mocks.mask).toHaveBeenCalled());
  const close = session.close();
  resolveReset();
  await close;
  await assertion;
  expect(mocks.i2cWrite).not.toHaveBeenCalled();
  expect(device.close).toHaveBeenCalledTimes(1);
  expect(session.receiver.state).toBe('disconnected');
});
