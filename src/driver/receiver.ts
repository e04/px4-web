import createTuner, { type TunerModule } from './generated/tuner';
import { It930xBridge, sleep } from './bridge';
import type { FirmwareImage } from './firmware';

export function channelFrequency(channel: number): number {
  if (!Number.isInteger(channel) || channel < 13 || channel > 62)
    throw new Error('Specify a physical channel as an integer from 13 to 62');
  return 473143 + (channel - 13) * 6000;
}

export type ReceiverState =
  | 'connected'
  | 'initializing'
  | 'ready'
  | 'tuning'
  | 'locked'
  | 'streaming'
  | 'stopping'
  | 'stopped'
  | 'error'
  | 'disconnected';
export interface TuneResult {
  generation: number;
  timestamp: string;
  channel: number;
  frequencyKHz: number;
  receiverIndex: 2;
  pllLocked: boolean;
  demodLocked: boolean;
  elapsedMs: number;
  timeout?: 'pll' | 'demod';
}
export interface ReceiverEvent {
  timestamp: string;
  state: ReceiverState;
  message: string;
}

export class Receiver {
  state: ReceiverState = 'connected';
  generation = 0;
  boot?: { mode: 'cold' | 'warm'; version: string };
  private tuner?: TunerModule;
  private pending?: Promise<unknown>;
  private activeGeneration = 0;
  private stopPending?: Promise<void>;
  private bridgeInitialized = false;
  constructor(
    readonly bridge: It930xBridge,
    private readonly maxPacketSize: number,
    private readonly notify: (event: ReceiverEvent) => void = () => {},
  ) {}

  private update(state: ReceiverState, message: string): void {
    this.state = state;
    this.notify({ timestamp: new Date().toISOString(), state, message });
  }
  private check(): void {
    if (this.activeGeneration !== this.generation || this.state === 'disconnected')
      throw new Error('Operation was stopped');
  }
  private async call(name: string, ...args: number[]): Promise<number> {
    this.check();
    if (!this.tuner) throw new Error('Tuner is not initialized');
    this.tuner.ioError = undefined;
    const result = await this.tuner.ccall(
      name,
      'number',
      args.map(() => 'number'),
      args,
      { async: true },
    );
    this.check();
    if (result < 0) throw this.tuner.ioError ?? new Error(`${name} failed (${result})`);
    return result;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending || this.stopPending)
      return Promise.reject(new Error('Another operation is in progress'));
    if (this.state === 'error' || this.state === 'disconnected')
      return Promise.reject(new Error('Reconnection required'));
    this.activeGeneration = ++this.generation;
    const promise = operation()
      .catch(async (error: unknown) => {
        if (this.activeGeneration === this.generation && this.state !== 'disconnected') {
          this.update('error', error instanceof Error ? error.message : String(error));
          try {
            await this.bridge.power(false);
          } catch {
            /* First failure is reported above. */
          }
        }
        throw error;
      })
      .finally(() => {
        this.pending = undefined;
      });
    this.pending = promise;
    return promise;
  }

  initialize(firmware: FirmwareImage): Promise<void> {
    if (!['connected', 'stopped'].includes(this.state))
      return Promise.reject(new Error('Stop before initializing'));
    return this.run(async () => {
      this.update('initializing', 'Querying firmware / shared init');
      // New module on every power cycle discards tuner register/calibration caches.
      this.tuner = await createTuner({
        i2cRead: async (address, length) => {
          this.check();
          const bytes = await this.bridge.i2cRead(address, length);
          this.check();
          return bytes;
        },
        i2cWrite: async (address, bytes) => {
          this.check();
          await this.bridge.i2cWrite(address, bytes);
          this.check();
        },
        printErr: (message) =>
          this.notify({ timestamp: new Date().toISOString(), state: this.state, message }),
      });
      this.check();
      this.boot = await this.bridge.boot(firmware);
      this.check();
      if (!this.bridgeInitialized) {
        await this.bridge.initialize(this.maxPacketSize);
        this.bridgeInitialized = true;
      }
      this.check();
      await this.bridge.power(true);
      this.check();
      await this.call('receiver_init');
      this.update(
        'ready',
        `${this.boot.mode} / FW ${this.boot.version} / Terrestrial index 2 initialized`,
      );
    });
  }

  tune(channel: number, demodTimeoutMs = 3000): Promise<TuneResult> {
    const frequencyKHz = channelFrequency(channel);
    if (!Number.isFinite(demodTimeoutMs) || demodTimeoutMs < 20 || demodTimeoutMs > 30000)
      return Promise.reject(new Error('Invalid demodulator timeout'));
    if (!['ready', 'locked', 'streaming'].includes(this.state))
      return Promise.reject(new Error('Initialize first'));
    return this.run(async () => {
      this.update('tuning', `CH ${channel} / ${frequencyKHz} kHz`);
      const start = performance.now();
      const result: TuneResult = {
        generation: this.generation,
        timestamp: new Date().toISOString(),
        channel,
        frequencyKHz,
        receiverIndex: 2,
        pllLocked: false,
        demodLocked: false,
        elapsedMs: 0,
      };
      await this.call('receiver_frequency', frequencyKHz);
      const pllDeadline = performance.now() + 500;
      for (let attempt = 0; attempt < 25; attempt++) {
        result.pllLocked = !!(await this.call('receiver_pll'));
        if (result.pllLocked || performance.now() >= pllDeadline) break;
        await sleep(20);
      }
      if (!result.pllLocked) result.timeout = 'pll';
      else {
        await this.call('receiver_acquire');
        const deadline = performance.now() + demodTimeoutMs;
        let polls = 0;
        while (true) {
          result.demodLocked = !!(await this.call('receiver_lock'));
          if (result.demodLocked || performance.now() >= deadline) break;
          await sleep(20);
          polls++;
        }
        if (!result.demodLocked) result.timeout = 'demod';
        else if (polls < 35) await sleep((35 - polls) * 10);
      }
      this.check();
      result.elapsedMs = Math.round(performance.now() - start);
      this.update(
        result.demodLocked ? 'locked' : 'ready',
        result.timeout ? `${result.timeout} lock timeout` : 'PLL / demod lock check',
      );
      return result;
    });
  }

  startCapture(): Promise<void> {
    if (this.state !== 'locked')
      return Promise.reject(new Error('Demod lock required for TS capture'));
    return this.run(async () => {
      // Reset the stream output before enabling TS pins. A Bulk IN here can
      // wait forever when a previous page completed its shutdown on reload.
      await this.bridge.mask(0xda1d, 1, 1);
      await this.bridge.mask(0xda1d, 0, 1);
      this.check();
      // tc90522_enable_ts_pins_t, terrestrial receiver index 2 (address 0x10).
      await this.bridge.i2cWrite(0x10, new Uint8Array([0x1d, 0x00]));
      this.check();
      this.update('streaming', 'Receiving terrestrial index 2 TS');
    });
  }

  stop(): Promise<void> {
    if (this.stopPending) return this.stopPending;
    if (this.state === 'disconnected' || this.state === 'stopped') return Promise.resolve();
    const failed = this.state === 'error';
    ++this.generation;
    this.update('stopping', 'Stopping');
    const pending = this.pending;
    this.stopPending = (async () => {
      await pending?.catch(() => {});
      if (this.state === 'disconnected') return;
      this.activeGeneration = this.generation;
      let first: unknown;
      try {
        if (this.tuner) await this.call('receiver_stop');
      } catch (error) {
        first = error;
      }
      try {
        await this.bridge.power(false);
      } catch (error) {
        first ??= error;
      }
      this.tuner = undefined;
      if ((this.state as ReceiverState) === 'disconnected') return;
      this.update(
        first || failed ? 'error' : 'stopped',
        first
          ? String(first)
          : failed
            ? 'Stopped; reconnection required'
            : 'Board power off; can reinitialize',
      );
      if (first) throw first;
    })().finally(() => {
      this.stopPending = undefined;
    });
    return this.stopPending;
  }

  disconnect(): void {
    ++this.generation;
    this.update('disconnected', 'USB disconnected');
  }
}
