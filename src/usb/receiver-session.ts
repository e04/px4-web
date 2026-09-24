import { It930xBridge } from '../driver/bridge';
import { Receiver, type ReceiverEvent, type TuneResult } from '../driver/receiver';
import { UsbControl, type ControlTrace } from './control';
import { claimPx4Interface } from './px4';
import { hasPx4CardReader, parsePx4DevId, px4DeviceName, px4UsbFilters } from './px4-devices';
import { UsbTsStream } from './stream';
import { TransportWorker } from '../transport/worker-client';
import type { TransportSnapshot } from '../transport/pipeline';
import { CardUart } from '../card/uart';
import { T1Card } from '../card/t1';
import { B25Worker } from '../media/b25-client';
import type { Channel } from '../channels';

export class ReceiverSession {
  private closing?: Promise<void>;
  private worker?: TransportWorker;
  // Auxiliary tuner demux; rebuilt per EPG channel so no PSI crosses multiplexes.
  private epgWorker?: TransportWorker;
  epgTransport?: TransportSnapshot;
  private stream?: UsbTsStream;
  card?: T1Card;
  b25?: B25Worker;
  b25ServiceId?: number;
  private b25Starting = false;
  private fileDecoding = false;
  private cardPoll = 0;
  private epoch = 0;
  b25Error?: string;
  savedClearTs?: Blob;
  transport?: TransportSnapshot;
  savedTs?: Blob;
  streamError?: string;
  get receiving(): boolean {
    return !!this.stream?.running && !this.closing;
  }
  private constructor(
    readonly device: USBDevice,
    readonly receiver: Receiver,
    readonly control: UsbControl,
    readonly descriptor: Awaited<ReturnType<typeof claimPx4Interface>>,
    readonly deviceInfo: {
      productId: number;
      productName: string;
      serialNumber: string;
      devId: number | null;
      hasCardReader: boolean;
    },
    private readonly removed: (event: USBConnectionEvent) => void,
  ) {}

  static async connect(
    onEvent: (event: ReceiverEvent) => void,
    onTrace: (entry: ControlTrace) => void,
  ): Promise<ReceiverSession> {
    if (!window.isSecureContext || !navigator.usb)
      throw new Error('Chrome over HTTPS or localhost is required');
    const usb = navigator.usb;
    const device = await usb.requestDevice({ filters: px4UsbFilters() });
    try {
      await device.open();
      const descriptor = await claimPx4Interface(device);
      const stream = descriptor.endpoints.find(
        (e) => e.endpointNumber === 4 && e.direction === 'in',
      )!;
      const control = new UsbControl(device, onTrace);
      const receiver = new Receiver(
        new It930xBridge(control, device.productId),
        stream.packetSize,
        onEvent,
      );
      let session: ReceiverSession;
      const removed = (event: USBConnectionEvent) => {
        if (event.device !== device) return;
        control.invalidate('USB device removed');
        receiver.disconnect();
        session.stream?.stop();
        void session.close().catch(() => {});
        usb.removeEventListener('disconnect', removed);
      };
      usb.addEventListener('disconnect', removed);
      const serialNumber = device.serialNumber ?? '';
      const deviceInfo = {
        productId: device.productId,
        productName: device.productName || px4DeviceName(device.productId) || 'PLEX PX4',
        serialNumber,
        devId: parsePx4DevId(serialNumber || undefined),
        hasCardReader: hasPx4CardReader(device.productId, serialNumber || undefined),
      };
      session = new ReceiverSession(device, receiver, control, descriptor, deviceInfo, removed);
      return session;
    } catch (error) {
      if (device.opened) await device.close().catch(() => {});
      throw error;
    }
  }

  async startCapture(): Promise<void> {
    if (this.closing || this.stream || this.receiver.state !== 'locked')
      throw new Error('Start TS capture after demod lock');
    const epoch = ++this.epoch;
    const { stream, worker } = this.wireStream(epoch);
    try {
      await this.receiver.startCapture();
      if (this.closing || epoch !== this.epoch) return;
      this.serveStream(epoch, stream, worker);
    } catch (error) {
      this.streamError = String(error);
      await this.close().catch(() => {});
      throw error;
    }
  }

  // Channel switch without USB reconnection: the device stays open/claimed,
  // only the TS delivery chain and B25 filter are rebuilt for the new multiplex.
  // A lock failure leaves the receiver in `ready` with no stream; retune stays
  // allowed from ready/locked/streaming so the user can pick another channel.
  async retune(channel: Channel): Promise<TuneResult> {
    if (this.closing || !['ready', 'locked', 'streaming'].includes(this.receiver.state))
      throw new Error('Switch channels while receiving TS');
    const epoch = ++this.epoch;
    const previous = this.stream;
    previous?.stop();
    try {
      await previous?.drain();
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
    if (this.closing || epoch !== this.epoch)
      throw new Error('Channel switch was superseded by a newer operation');
    this.stream = undefined;
    // The card session is reused; only the multiplex-bound B25 filter is rebuilt by startB25.
    this.b25?.close();
    this.b25 = undefined;
    this.worker?.close();
    this.worker = undefined;
    this.transport = undefined;
    this.streamError = undefined;
    const result = await this.receiver.tune(channel);
    if (this.closing || epoch !== this.epoch)
      throw new Error('Channel switch was superseded by a newer operation');
    if (!result.demodLocked) throw new Error('The channel could not be locked.');
    await this.receiver.startCapture();
    if (this.closing || epoch !== this.epoch)
      throw new Error('Channel switch was superseded by a newer operation');
    const { stream, worker } = this.wireStream(epoch);
    this.serveStream(epoch, stream, worker);
    return result;
  }

  private wireStream(epoch: number): { stream: UsbTsStream; worker: TransportWorker } {
    const stream = (this.stream = new UsbTsStream(this.device));
    const worker = (this.worker = new TransportWorker(
      (bytes) => {
        const b25 = this.closing || epoch !== this.epoch ? undefined : this.b25;
        if (b25 && !this.fileDecoding && !this.b25Error)
          return b25.push(bytes).catch((error) => {
            if (this.b25 === b25) this.failB25(error);
          });
      },
      this.receiver.receiverIndex,
      this.receiver.bridge.family.startsWith('isdb2056'),
    ));
    return { stream, worker };
  }

  private serveStream(epoch: number, stream: UsbTsStream, worker: TransportWorker): void {
    void stream
      .run((bytes) => {
        if (this.closing || epoch !== this.epoch || this.worker !== worker)
          return Promise.resolve();
        // Best effort: an overloaded EPG demux drops chunks instead of stalling playback.
        this.epgWorker?.request('chunk', bytes.slice(0)).catch(() => {});
        return worker.request('chunk', bytes);
      })
      .catch((error) => {
        if (epoch !== this.epoch) return;
        this.streamError = String(error);
        // WebUSB has no abortable transferIn; drain() requires the physical
        // request to settle before another tune, or closes the session.
        stream.stop();
        if (this.worker === worker) {
          worker.close();
          this.worker = undefined;
        }
      });
  }

  async refreshTransport(): Promise<void> {
    const worker = this.worker;
    if (worker && !this.closing) {
      const reply = await worker.request('snapshot');
      if (this.worker !== worker || this.closing) return;
      this.transport = reply.snapshot;
    }
    const b25 = this.b25;
    if (b25 && !this.closing && !this.b25Error && !this.b25Starting) {
      try {
        if (performance.now() - this.cardPoll >= 1000) {
          this.cardPoll = performance.now();
          await this.card?.checkPresence();
        }
        if (this.b25 !== b25) return;
        await b25.request('snapshot');
      } catch (error) {
        if (this.b25 === b25) this.failB25(error);
      }
    }
  }
  /** A free tuner beside the main one exists (PX4/PX5 second tuner pair). */
  get hasEpgTuner(): boolean {
    return this.receiver.hasAuxiliary;
  }

  /**
   * Tune the auxiliary tuner for EPG collection. Its packets share the main
   * USB stream, so data only arrives while the main tuner is receiving.
   */
  async epgTune(channel: Channel): Promise<boolean> {
    this.epgWorker?.close();
    this.epgWorker = undefined;
    this.epgTransport = undefined;
    if (this.closing) throw new Error('Session closed');
    if (!(await this.receiver.auxiliaryTune(channel)) || this.closing) return false;
    this.epgWorker = new TransportWorker(undefined, Receiver.auxiliaryIndex(channel));
    return true;
  }

  async refreshEpgTransport(): Promise<void> {
    const worker = this.epgWorker;
    if (!worker || this.closing) return;
    const reply = await worker.request('snapshot');
    if (this.epgWorker === worker) this.epgTransport = reply.snapshot;
  }

  async stopEpgTuner(): Promise<void> {
    this.epgWorker?.close();
    this.epgWorker = undefined;
    this.epgTransport = undefined;
    if (!this.closing) await this.receiver.auxiliaryStop();
  }

  private failB25(error: unknown): void {
    if (this.closing) return;
    this.b25Error ??= String(error);
    this.card?.invalidate();
    this.b25?.close(this.b25Error);
  }
  async startB25(serviceId: number, emm: boolean, file?: File): Promise<void> {
    if (!this.deviceInfo.hasCardReader)
      throw new Error(
        'No card reader on this device side. For Q-series use the primary side; for PX-MLT8PE use the 5-tuner side',
      );
    if (
      this.closing ||
      this.b25Starting ||
      !['ready', 'locked', 'streaming'].includes(this.receiver.state)
    )
      throw new Error('Start B25 after initialization. Reconnect before retrying');
    if (!Number.isInteger(serviceId) || serviceId < 1 || serviceId > 65535)
      throw new Error('Service ID must be an integer from 1 to 65535');
    if (!file && (!this.worker || !this.receiving)) throw new Error('Start TS reception');
    if (
      file &&
      (this.b25 || this.receiving || file.size < 188 * 16 || file.size > 64 * 1024 * 1024)
    )
      throw new Error('For saved TS, select a 16-packet to 64 MiB file while reception is stopped');
    if (file && file.size % 188) throw new Error('Saved TS must be a 188-byte packet file');
    const epoch = this.epoch;
    const check = () => {
      if (this.closing || epoch !== this.epoch) throw new Error('B25 session superseded');
    };
    this.b25Starting = true;
    // Service/channel switches replace only the multiplex-bound filter; a healthy card session is reused.
    this.b25?.close();
    this.b25 = undefined;
    this.b25Error = undefined;
    const bridge = new It930xBridge({
      command: (command, payload, length) => {
        if (this.closing) return Promise.reject(new Error('Card session closed'));
        return this.control.command(command, payload, length);
      },
    });
    const card = (this.card ??= new T1Card(new CardUart(bridge)));
    this.fileDecoding = !!file;
    try {
      if (!card.atr) await card.open();
      check();
      const b25 = (this.b25 = new B25Worker((bytes) => card.transmit(bytes)));
      await b25.request('open', { serviceId, emm, file: !!file });
      check();
      this.b25ServiceId = serviceId;
      if (file) {
        for (let offset = 0; offset < file.size; offset += 188 * 816) {
          check();
          await b25.push(await file.slice(offset, offset + 188 * 816).arrayBuffer());
        }
        await b25.request('flush');
        check();
        const reply = await b25.request('download');
        check();
        this.savedClearTs = reply.blob;
      } else await this.worker!.request('forward');
      check();
    } catch (error) {
      if (epoch === this.epoch) this.failB25(error);
      throw error;
    } finally {
      this.b25Starting = false;
    }
  }
  async recordClearTs(): Promise<void> {
    if (!this.b25 || this.b25Error || this.fileDecoding) throw new Error('Start live B25');
    await this.b25.request('record');
  }
  async downloadClearTs(): Promise<Blob | undefined> {
    if (this.b25 && !this.closing && !this.b25Error)
      this.savedClearTs = (await this.b25.request('download')).blob;
    return this.savedClearTs;
  }
  async recordTs(): Promise<void> {
    if (!this.worker || !this.receiving) throw new Error('Start TS reception');
    this.transport = (await this.worker.request('capture')).snapshot;
  }
  async downloadTs(): Promise<Blob | undefined> {
    if (this.worker && !this.closing) await this.stopAndDownloadWorker();
    return this.savedTs;
  }
  private async stopAndDownloadWorker(): Promise<void> {
    await this.worker!.request('stop');
    const reply = await this.worker!.request('download');
    this.transport = reply.snapshot;
    this.savedTs = reply.blob;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.epoch++;
    this.stream?.stop();
    this.card?.invalidate();
    this.b25?.close();
    this.epgWorker?.close();
    this.epgWorker = undefined;
    this.closing = (async () => {
      let first: unknown;
      try {
        await this.receiver.stop();
      } catch (error) {
        first = error;
      }
      this.control.invalidate();
      this.receiver.disconnect();
      navigator.usb?.removeEventListener('disconnect', this.removed);
      if (this.device.opened) {
        // close cancels outstanding Bulk IN requests. Releasing an interface first
        // may wait for an IN request that can no longer complete after TS pins stop.
        try {
          await this.device.close();
        } catch (error) {
          first ??= error;
        }
      }
      if (this.worker) {
        try {
          await this.stopAndDownloadWorker();
        } catch (error) {
          first ??= error;
        }
        this.worker.close();
        this.worker = undefined;
      }
      if (first) throw first;
    })();
    return this.closing;
  }
}
