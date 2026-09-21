import { expect, it, vi } from 'vitest';
import { Receiver } from '../src/driver/receiver';
import type { It930xBridge } from '../src/driver/bridge';

function streamingReceiver() {
  const bridge = { power: vi.fn(async () => {}) } as unknown as It930xBridge;
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
