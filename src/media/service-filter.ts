import { TsAnalyzer } from '../transport/analyzer';
import { mpegCrc32 } from '../transport/psi';

// B25 retains the multiplex; this output boundary publishes only the chosen service.
export class ServiceFilter {
  readonly analyzer = new TsAnalyzer();
  readonly stats = { packets: 0, scrambled: 0, tei: 0, ccErrors: 0 };
  private tail = new Uint8Array();
  private patCc = 0;
  private announced?: string;
  private pmtPackets: Uint8Array[] = [];
  private pmtPid?: number;
  constructor(readonly serviceId: number) {
    if (!Number.isInteger(serviceId) || serviceId < 1 || serviceId > 65535)
      throw new Error('Invalid service ID');
  }
  get found(): boolean {
    return !!this.analyzer.psi.services.find((s) => s.serviceId === this.serviceId)?.streams;
  }
  push(bytes: Uint8Array): Uint8Array {
    const input = new Uint8Array(this.tail.length + bytes.length);
    input.set(this.tail);
    input.set(bytes, this.tail.length);
    const packets: Uint8Array[] = [];
    let offset = 0;
    for (; offset + 188 <= input.length; offset += 188) {
      const p = input.subarray(offset, offset + 188);
      if (p[0] !== 0x47) throw new Error('B25 output TS sync');
      const pid = ((p[1] & 31) << 8) | p[2];
      const expectedPmt = this.analyzer.psi.services.find(
        (s) => s.serviceId === this.serviceId,
      )?.pmtPid;
      if (expectedPmt !== this.pmtPid) {
        this.pmtPid = expectedPmt;
        this.pmtPackets = [];
      }
      if (pid === expectedPmt) {
        if (p[1] & 0x40) this.pmtPackets = [];
        this.pmtPackets.push(p.slice());
        if (this.pmtPackets.length > 16) this.pmtPackets = [];
      }
      const previousCcErrors = this.analyzer.totals.ccErrors;
      this.analyzer.push(p);
      const psi = this.analyzer.psi;
      const service = psi.services.find((s) => s.serviceId === this.serviceId);
      if (!service?.streams) continue;
      const key = `${psi.transportStreamId}/${psi.patVersion}/${service.pmtPid}/${service.pmtVersion}`;
      const changed = this.announced !== key;
      if (pid === 0 || this.announced !== key) {
        this.announced = key;
        const s = new Uint8Array([
          0,
          0xb0,
          13,
          psi.transportStreamId! >> 8,
          psi.transportStreamId! & 255,
          0xc1 | (psi.patVersion! << 1),
          0,
          0,
          this.serviceId >> 8,
          this.serviceId & 255,
          0xe0 | (service.pmtPid >> 8),
          service.pmtPid & 255,
        ]);
        const crc = mpegCrc32(s);
        const pat = new Uint8Array(188).fill(255);
        pat.set([
          0x47,
          0x40,
          0,
          0x10 | (this.patCc++ & 15),
          0,
          ...s,
          crc >>> 24,
          (crc >>> 16) & 255,
          (crc >>> 8) & 255,
          crc & 255,
        ]);
        packets.push(pat);
      }
      if (changed) packets.push(...this.pmtPackets);
      if (
        pid === service.pmtPid ||
        pid === service.pcrPid ||
        service.streams.some((s) => s.pid === pid)
      ) {
        if (!(changed && pid === service.pmtPid)) packets.push(p);
        this.stats.packets++;
        if (p[3] & 0xc0) this.stats.scrambled++;
        if (p[1] & 0x80) this.stats.tei++;
        this.stats.ccErrors += this.analyzer.totals.ccErrors - previousCcErrors;
      }
    }
    this.tail = input.slice(offset);
    const output = new Uint8Array(packets.length * 188);
    packets.forEach((p, i) => output.set(p, i * 188));
    return output;
  }
  finish(): void {
    if (this.tail.length) throw new Error('Truncated B25 output');
    if (!this.found) throw new Error('Selected service PMT not found');
  }
}
