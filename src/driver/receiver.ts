import createTuner, { type TunerModule } from './generated/tuner';
import { It930xBridge, sleep } from './bridge';
import type { FirmwareImage } from './firmware';
import { parseChannel, type Channel } from '../channels';

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
  channel: Channel;
  frequencyKHz: number;
  receiverIndex: number;
  transportStreamId?: number;
  pllLocked: boolean;
  demodLocked: boolean;
  elapsedMs: number;
  timeout?: 'pll' | 'demod' | 'tsid';
}
export interface ReceiverEvent {
  timestamp: string;
  state: ReceiverState;
  message: string;
}

export class Receiver {
  state: ReceiverState = 'connected';
  generation = 0;
  receiverIndex = 2;
  boot?: { mode: 'cold' | 'warm'; version: string };
  private tuner?: TunerModule;
  private pending?: Promise<unknown>;
  private activeGeneration = 0;
  private stopPending?: Promise<void>;
  private bridgeInitialized = false;
  private callQueue: Promise<unknown> = Promise.resolve();
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
  // ASYNCIFY allows one in-flight export per module; the main and auxiliary
  // receivers share it, so every call is queued.
  private call(name: string, ...args: number[]): Promise<number> {
    const operation = this.callQueue.then(async () => {
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
    });
    this.callQueue = operation.catch(() => {});
    return operation;
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
      const model = { px4: 0, isdb2056: 1, isdb2056n: 2, mlt: 3 }[this.bridge.family];
      await this.call('receiver_init', model);
      this.update(
        'ready',
        `${this.boot.mode} / FW ${this.boot.version} / ${this.bridge.family} initialized`,
      );
    });
  }

  tune(channel: Channel, demodTimeoutMs = 3000): Promise<TuneResult> {
    const { frequencyKHz, band, slot } = parseChannel(channel);
    if (!Number.isFinite(demodTimeoutMs) || demodTimeoutMs < 20 || demodTimeoutMs > 30000)
      return Promise.reject(new Error('Invalid demodulator timeout'));
    if (!['ready', 'locked', 'streaming'].includes(this.state))
      return Promise.reject(new Error('Initialize first'));
    return this.run(async () => {
      this.update('tuning', `CH ${channel} / ${frequencyKHz} kHz`);
      const start = performance.now();
      const family = this.bridge.family;
      this.receiverIndex = family === 'px4' && band === 'T' ? 2 : 0;
      const result: TuneResult = {
        generation: this.generation,
        timestamp: new Date().toISOString(),
        channel,
        frequencyKHz,
        receiverIndex: this.receiverIndex,
        pllLocked: false,
        demodLocked: false,
        elapsedMs: 0,
      };
      // CXD2856ER accepts slot indices 0–7, selected before tuning.
      if (family === 'mlt' && band !== 'T' && slot >= 8) {
        await this.call('receiver_pause');
        result.timeout = 'tsid';
        result.elapsedMs = Math.round(performance.now() - start);
        this.update('ready', 'Unsupported satellite slot');
        return result;
      }
      await this.call('receiver_frequency', frequencyKHz, slot);
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
          // 2 = no signal reported by the demod; stop waiting like px4_drv's -ECANCELED.
          const lock = await this.call('receiver_lock');
          result.demodLocked = lock === 1;
          if (lock !== 0 || performance.now() >= deadline) break;
          await sleep(20);
          polls++;
        }
        if (!result.demodLocked) result.timeout = 'demod';
        // PTX_CHRDEV_WAIT_AFTER_LOCK_TC_T: settle only after an early ISDB-T lock.
        else if (band === 'T' && polls < 35) await sleep((35 - polls) * 10);
      }
      if (result.demodLocked && band !== 'T' && family !== 'mlt') {
        const deadline = performance.now() + 1000;
        let tsid = 0;
        do {
          tsid = await this.call('receiver_tsid', slot);
          if (tsid && tsid !== 0xffff) break;
          await sleep(10);
        } while (performance.now() < deadline);
        let selected = false;
        if (tsid && tsid !== 0xffff) {
          await this.call('receiver_select_tsid', tsid);
          const selectDeadline = performance.now() + 1000;
          do {
            selected = (await this.call('receiver_current_tsid')) === tsid;
            if (selected) break;
            await sleep(10);
          } while (performance.now() < selectDeadline);
        }
        if (selected) result.transportStreamId = tsid;
        else {
          result.demodLocked = false;
          result.timeout = 'tsid';
        }
      }
      if (!result.demodLocked) await this.call('receiver_pause');
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
      await this.call('receiver_capture');
      this.check();
      this.update('streaming', `Receiving index ${this.receiverIndex} TS`);
    });
  }

  /** PX4/PX5 boards carry a second tuner pair (S1/T1) usable beside the main one. */
  get hasAuxiliary(): boolean {
    return this.bridge.family === 'px4';
  }

  /** TS tag of the auxiliary tuner for a channel: S1 = 1, T1 = 3. */
  static auxiliaryIndex(channel: Channel): number {
    return parseChannel(channel).band === 'T' ? 3 : 1;
  }

  /**
   * Tune the auxiliary tuner and enable its TS output. Failures never touch the
   * main receiver state; a lock failure resolves false.
   */
  async auxiliaryTune(channel: Channel, demodTimeoutMs = 3000): Promise<boolean> {
    const { frequencyKHz, band, slot } = parseChannel(channel);
    if (!this.hasAuxiliary) throw new Error('No auxiliary tuner on this device');
    // A main-tuner operation in flight is fine: module calls are queued.
    if (!['ready', 'tuning', 'locked', 'streaming'].includes(this.state))
      throw new Error('Initialize first');
    await this.call('aux_frequency', frequencyKHz);
    const pllDeadline = performance.now() + 500;
    let pllLocked = false;
    while (!(pllLocked = !!(await this.call('aux_pll'))) && performance.now() < pllDeadline)
      await sleep(20);
    if (!pllLocked) return false;
    await this.call('aux_acquire');
    const deadline = performance.now() + demodTimeoutMs;
    while (!(await this.call('aux_lock'))) {
      if (performance.now() >= deadline) return false;
      await sleep(20);
    }
    if (band !== 'T') {
      const tsidDeadline = performance.now() + 1000;
      let tsid = 0;
      do {
        tsid = await this.call('aux_tsid', slot);
        if (tsid && tsid !== 0xffff) break;
        await sleep(10);
      } while (performance.now() < tsidDeadline);
      if (!tsid || tsid === 0xffff) return false;
      await this.call('aux_select_tsid', tsid);
      const selectDeadline = performance.now() + 1000;
      while ((await this.call('aux_current_tsid')) !== tsid) {
        if (performance.now() >= selectDeadline) return false;
        await sleep(10);
      }
    }
    await this.call('aux_capture');
    return true;
  }

  /** Put the auxiliary tuner back to sleep. */
  async auxiliaryStop(): Promise<void> {
    if (this.tuner && ['ready', 'tuning', 'locked', 'streaming'].includes(this.state))
      await this.call('aux_stop');
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
