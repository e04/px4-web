import { afterEach, expect, it, vi } from 'vitest';
import { Receiver } from '../src/driver/receiver';
import type { It930xBridge } from '../src/driver/bridge';
import type { DeviceFamily } from '../src/usb/px4-devices';

afterEach(() => vi.useRealTimers());

function streamingReceiver() {
  const bridge = { family: 'px4', power: vi.fn(async () => {}) } as unknown as It930xBridge;
  const receiver = new Receiver(bridge, 512, () => {});
  receiver.state = 'streaming';
  (receiver as unknown as { tuner: unknown }).tuner = { ioError: undefined, ccall: async () => 1 };
  return receiver;
}

it('tunes from streaming without reinitialization', async () => {
  const receiver = streamingReceiver();
  const result = await receiver.tune(26);
  expect(result.demodLocked).toBe(true);
  expect(result.channel).toBe(26);
  expect(receiver.state).toBe('locked');
});

it('still rejects tune before initialization', async () => {
  const receiver = streamingReceiver();
  receiver.state = 'stopped';
  await expect(receiver.tune(26)).rejects.toThrow('Initialize first');
});

function satelliteReceiver(family: DeviceFamily = 'px4', tsid = 0x4010) {
  const ccall = vi.fn(async (name: string) => {
    if (name === 'receiver_tsid' || name === 'receiver_current_tsid') return tsid;
    return name === 'receiver_pll' || name === 'receiver_lock' ? 1 : 0;
  });
  const bridge = { family, power: vi.fn(async () => {}) } as unknown as It930xBridge;
  const receiver = new Receiver(bridge, 512);
  receiver.state = 'ready';
  (receiver as unknown as { tuner: unknown }).tuner = { ccall };
  return { receiver, ccall, bridge };
}

it('selects and verifies a BS TSID before reporting lock and switches back to terrestrial', async () => {
  vi.useFakeTimers();
  const { receiver, ccall } = satelliteReceiver();
  const satellite = receiver.tune('BS1_2');
  await vi.runAllTimersAsync();
  expect(await satellite).toMatchObject({
    demodLocked: true,
    receiverIndex: 0,
    frequencyKHz: 1049480,
    transportStreamId: 0x4010,
  });
  expect(ccall).toHaveBeenCalledWith('receiver_tsid', 'number', ['number'], [2], { async: true });
  expect(ccall.mock.calls.map(([name]) => name)).toContain('receiver_select_tsid');
  const terrestrial = receiver.tune(13);
  await vi.runAllTimersAsync();
  expect(await terrestrial).toMatchObject({ demodLocked: true, receiverIndex: 2 });
});

it('treats an empty TMCC slot as a recoverable lock failure', async () => {
  vi.useFakeTimers();
  const { receiver, ccall, bridge } = satelliteReceiver('px4', 0);
  const pending = receiver.tune('CS2_1');
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({ demodLocked: false, timeout: 'tsid' });
  expect(receiver.state).toBe('ready');
  expect(ccall.mock.calls.map(([name]) => name)).not.toContain('receiver_select_tsid');
  expect(ccall.mock.calls.at(-1)?.[0]).toBe('receiver_pause');
  expect(bridge.power).not.toHaveBeenCalled();
});

it('uses pre-tune slot selection on MLT and rejects unsupported slots without losing the session', async () => {
  vi.useFakeTimers();
  const { receiver, ccall } = satelliteReceiver('mlt');
  const pending = receiver.tune('CS24_7');
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({ demodLocked: true, receiverIndex: 0 });
  expect(ccall).toHaveBeenCalledWith(
    'receiver_frequency',
    'number',
    ['number', 'number'],
    [2053000, 7],
    { async: true },
  );
  expect(ccall.mock.calls.map(([name]) => name)).not.toContain('receiver_tsid');
  expect(await receiver.tune('CS24_8')).toMatchObject({ demodLocked: false, timeout: 'tsid' });
  expect(receiver.state).toBe('ready');
});

it('does not report lock when the demodulator outputs a different TSID', async () => {
  vi.useFakeTimers();
  const { receiver, ccall } = satelliteReceiver();
  ccall.mockImplementation(async (name) => {
    if (name === 'receiver_tsid') return 0x4010;
    if (name === 'receiver_current_tsid') return 0x4011;
    return 1;
  });
  const pending = receiver.tune('BS1_0');
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({ demodLocked: false, timeout: 'tsid' });
  expect(receiver.state).toBe('ready');
  expect(ccall.mock.calls.at(-1)?.[0]).toBe('receiver_pause');
  await expect(receiver.startCapture()).rejects.toThrow('Demod lock required');
});

it('stops waiting for lock when the demodulator reports no signal', async () => {
  vi.useFakeTimers();
  const { receiver, ccall } = satelliteReceiver('mlt');
  ccall.mockImplementation(async (name) => (name === 'receiver_lock' ? 2 : 1));
  const pending = receiver.tune(13);
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({ demodLocked: false, timeout: 'demod' });
  expect(ccall.mock.calls.filter(([name]) => name === 'receiver_lock')).toHaveLength(1);
  expect(receiver.state).toBe('ready');
});
