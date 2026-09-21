import { ProgramInformation } from './program-info';
import { Psi } from './psi';

interface PidStats {
  pid: number;
  packets: number;
  tei: number;
  ccErrors: number;
  duplicates: number;
  discontinuities: number;
  scrambled: number;
}
interface Continuity {
  cc: number;
  packet: Uint8Array;
  duplicate: boolean;
}
export class TsAnalyzer {
  readonly psi = new Psi();
  readonly programs = new ProgramInformation();
  readonly pids = new Map<number, PidStats>();
  readonly totals = {
    packets: 0,
    tei: 0,
    ccErrors: 0,
    duplicates: 0,
    discontinuities: 0,
    scrambled: 0,
    malformedPackets: 0,
  };
  private continuity = new Map<number, Continuity>();
  resetContinuity(): void {
    this.continuity.clear();
    this.programs.resetFragments();
    for (const pid of this.pids.keys()) this.psi.resetPid(pid);
  }
  push(packet: Uint8Array): void {
    // SI (SDT/NIT/EIT) is unscrambled; ProgramInformation validates each packet itself
    // (TEI/scrambling/discontinuity/CC) so a damaged SI packet never disturbs PAT/PMT.
    this.programs.pushPacket(packet);
    const pid = ((packet[1] & 31) << 8) | packet[2];
    let stats = this.pids.get(pid);
    if (!stats) {
      stats = {
        pid,
        packets: 0,
        tei: 0,
        ccErrors: 0,
        duplicates: 0,
        discontinuities: 0,
        scrambled: 0,
      };
      this.pids.set(pid, stats);
    }
    const count = (key: keyof Omit<PidStats, 'pid'>) => {
      stats[key]++;
      this.totals[key]++;
    };
    count('packets');
    const tei = !!(packet[1] & 0x80),
      scrambled = !!(packet[3] & 0xc0);
    if (tei) count('tei');
    if (scrambled) count('scrambled');
    const afc = (packet[3] >>> 4) & 3,
      cc = packet[3] & 15;
    const payload = !!(afc & 1),
      adaptation = !!(afc & 2);
    const offset = adaptation ? 5 + packet[4] : 4;
    if (
      !afc ||
      (adaptation && (offset > 188 || (!payload && offset !== 188) || (payload && offset >= 188)))
    ) {
      this.totals.malformedPackets++;
      this.continuity.delete(pid);
      this.psi.resetPid(pid);
      return;
    }
    const discontinuity = adaptation && packet[4] > 0 && !!(packet[5] & 0x80);
    if (discontinuity) {
      count('discontinuities');
      this.continuity.delete(pid);
      this.psi.resetPid(pid);
    }
    if (tei) {
      this.continuity.delete(pid);
      this.psi.resetPid(pid);
      return;
    }
    if (pid !== 0x1fff) {
      const previous = this.continuity.get(pid);
      if (previous) {
        if (
          payload &&
          cc === previous.cc &&
          !previous.duplicate &&
          packet.every((b, i) => b === previous.packet[i])
        ) {
          previous.duplicate = true;
          count('duplicates');
          return;
        }
        if (cc !== ((previous.cc + (payload ? 1 : 0)) & 15)) {
          count('ccErrors');
          this.psi.resetPid(pid);
        }
      }
      this.continuity.set(pid, { cc, packet: packet.slice(), duplicate: false });
    }
    if (scrambled) this.psi.resetPid(pid);
    else if (payload) this.psi.push(pid, packet.subarray(offset), !!(packet[1] & 0x40));
  }
  snapshot() {
    return {
      ...this.totals,
      pids: [...this.pids.values()].map((s) => ({ ...s })),
      services: this.psi.services,
      programs: this.programs.snapshot(),
      transportStreamId: this.psi.transportStreamId,
      patVersion: this.psi.patVersion,
      crcErrors: this.psi.crcErrors,
      malformedSections: this.psi.malformedSections,
    };
  }
}
