import { Psi, captionPid, superimposePid } from '../transport/psi';

const WRAP = 2 ** 33;
/** Map a 33-bit timestamp to the epoch nearest a common PCR/PTS reference. */
export function unwrapTimestamp(value: number, reference: number): number {
  return value + Math.round((reference - value) / WRAP) * WRAP;
}
export function readTimestamp(b: Uint8Array, offset: number): number {
  if (offset + 5 > b.length || !(b[offset] & 1) || !(b[offset + 2] & 1) || !(b[offset + 4] & 1))
    throw new Error('Invalid PES timestamp');
  return (
    (b[offset] & 14) * 2 ** 29 +
    b[offset + 1] * 2 ** 22 +
    (b[offset + 2] >>> 1) * 2 ** 15 +
    b[offset + 3] * 128 +
    (b[offset + 4] >>> 1)
  );
}
export interface Pes {
  kind: 'video' | 'audio' | 'caption' | 'super';
  bytes: Uint8Array;
  pts: number;
  dts: number;
}
interface Assembly {
  chunks: Uint8Array[];
  size: number;
  length?: number;
}

export class PlaybackDemux {
  readonly psi = new Psi();
  readonly stats = { packets: 0, ccErrors: 0, scrambled: 0, resets: 0, pcr: 0, pes: 0 };
  private tail = new Uint8Array(0);
  private cc = new Map<number, number>();
  private assemblies = new Map<number, Assembly>();
  private video?: number;
  private audio?: number;
  private caption?: number;
  private superimpose?: number;
  private signature = '';
  private reference?: number;
  private lastPcr?: number;
  constructor(
    readonly serviceId: number,
    private output: (pes: Pes) => void,
    private reset: () => void,
  ) {}
  private clearCaption(pid: number): void {
    // A caption glitch must not tear down the running audio/video decoders.
    this.assemblies.delete(pid);
  }
  private discontinuity(): void {
    this.assemblies.clear();
    this.reference = undefined;
    this.lastPcr = undefined;
    this.stats.resets++;
    this.reset();
  }
  push(bytes: Uint8Array): void {
    const joined = new Uint8Array(this.tail.length + bytes.length);
    joined.set(this.tail);
    joined.set(bytes, this.tail.length);
    let offset = 0;
    for (; offset + 188 <= joined.length; offset += 188) {
      const p = joined.subarray(offset, offset + 188);
      if (p[0] !== 0x47) throw new Error('188-byte plaintext TS required');
      this.packet(p);
    }
    this.tail = joined.slice(offset);
  }
  private packet(p: Uint8Array): void {
    this.stats.packets++;
    const pid = ((p[1] & 31) << 8) | p[2],
      start = !!(p[1] & 64),
      afc = (p[3] >>> 4) & 3;
    const selected = pid === this.video || pid === this.audio;
    const captioned = pid === this.caption || pid === this.superimpose;
    if (!afc || p[1] & 128 || p[3] & 192) {
      if (p[3] & 192) this.stats.scrambled++;
      this.psi.resetPid(pid);
      this.cc.delete(pid);
      if (selected) this.discontinuity();
      else if (captioned) this.clearCaption(pid);
      if (selected && p[3] & 192) throw new Error('Selected service is scrambled; use B25 output');
      return;
    }
    let offset = 4;
    const service = this.psi.services.find((s) => s.serviceId === this.serviceId);
    if (afc & 2) {
      offset = 5 + p[4];
      if (offset > 188) {
        if (selected) this.discontinuity();
        else if (captioned) this.clearCaption(pid);
        return;
      }
      if (p[4] && p[5] & 128) {
        this.cc.delete(pid);
        this.psi.resetPid(pid);
        if (selected || pid === service?.pcrPid) this.discontinuity();
        else if (captioned) this.clearCaption(pid);
      }
      if (p[4] >= 7 && p[5] & 16 && pid === service?.pcrPid) {
        const raw = p[6] * 2 ** 25 + p[7] * 2 ** 17 + p[8] * 512 + p[9] * 2 + (p[10] >>> 7);
        const pcr = unwrapTimestamp(raw, this.reference ?? raw);
        if (
          this.lastPcr !== undefined &&
          (pcr < this.lastPcr - 9000 || pcr - this.lastPcr > 900000)
        )
          this.discontinuity();
        this.lastPcr = this.reference = pcr;
        this.stats.pcr++;
      }
    }
    if (!(afc & 1) || offset >= 188) return;
    const cc = p[3] & 15,
      previous = this.cc.get(pid);
    if (cc === previous) return;
    if (previous !== undefined && cc !== ((previous + 1) & 15)) {
      this.stats.ccErrors++;
      this.psi.resetPid(pid);
      if (selected) this.discontinuity();
      else if (captioned) this.clearCaption(pid);
    }
    this.cc.set(pid, cc);
    const payload = p.subarray(offset);
    this.psi.push(pid, payload, start);
    const updated = this.psi.services.find((s) => s.serviceId === this.serviceId);
    if (updated?.streams) {
      const video = updated.streams.find((s) => s.streamType === 2)?.pid;
      const audio = updated.streams.find((s) => s.streamType === 15)?.pid;
      const caption = captionPid(updated);
      const superimpose = superimposePid(updated, caption);
      const signature = `${updated.pmtVersion}/${updated.pcrPid}/${video}/${audio}/${caption}/${superimpose}`;
      if (signature !== this.signature) {
        if (video === undefined || audio === undefined)
          throw new Error('P4 requires MPEG-2 video (0x02) and ADTS AAC (0x0f)');
        this.signature = signature;
        this.video = video;
        this.audio = audio;
        this.caption = caption;
        this.superimpose = superimpose;
        this.discontinuity();
      }
    } else if (this.signature) {
      this.signature = '';
      this.video = this.audio = this.caption = this.superimpose = undefined;
      this.discontinuity();
    }
    if (
      pid !== this.video &&
      pid !== this.audio &&
      pid !== this.caption &&
      pid !== this.superimpose
    )
      return;
    if (start) {
      this.finish(pid);
      this.assemblies.set(pid, { chunks: [], size: 0 });
    }
    const assembly = this.assemblies.get(pid);
    if (!assembly) return;
    assembly.size += payload.length;
    if (assembly.size > 4 * 1024 * 1024) {
      if (pid === this.caption || pid === this.superimpose) this.clearCaption(pid);
      else this.discontinuity();
      return;
    }
    assembly.chunks.push(payload.slice());
    if (assembly.length === undefined && assembly.size >= 6) {
      const header = new Uint8Array(6);
      let copied = 0;
      for (const chunk of assembly.chunks) {
        const part = chunk.subarray(0, 6 - copied);
        header.set(part, copied);
        copied += part.length;
        if (copied === 6) break;
      }
      assembly.length = (header[4] << 8) | header[5];
    }
    // Sparse subtitle streams must not wait for the next PES to release a cue.
    if (assembly.length && assembly.size >= 6 + assembly.length) this.finish(pid);
  }
  private finish(pid: number): void {
    const a = this.assemblies.get(pid);
    this.assemblies.delete(pid);
    if (!a) return;
    const b = new Uint8Array(a.size);
    let offset = 0;
    for (const chunk of a.chunks) {
      b.set(chunk, offset);
      offset += chunk.length;
    }
    if (b.length < 9 || b[0] || b[1] || b[2] !== 1 || (b[6] & 192) !== 128) return;
    const length = (b[4] << 8) | b[5],
      end = length ? 6 + length : b.length,
      header = 9 + b[8];
    if (end > b.length || header > end) return;
    const flags = b[7] >>> 6;
    if (flags === 1 || (flags === 2 && b[8] < 5) || (flags === 3 && b[8] < 10)) return;
    let pts = -1,
      dts = -1;
    const captionTarget = pid === this.caption || pid === this.superimpose;
    if (flags & 2) {
      const raw = readTimestamp(b, 9);
      pts = unwrapTimestamp(raw, this.reference ?? raw);
      if (!captionTarget) {
        if (this.reference !== undefined && Math.abs(pts - this.reference) > 900000)
          this.discontinuity();
        this.reference = pts;
      }
      dts = flags === 3 ? unwrapTimestamp(readTimestamp(b, 14), pts) : pts;
    }
    if (captionTarget && pts < 0) pts = dts = this.reference ?? 0;
    this.stats.pes++;
    this.output({
      kind:
        pid === this.video
          ? 'video'
          : pid === this.audio
            ? 'audio'
            : pid === this.caption
              ? 'caption'
              : 'super',
      bytes: b.subarray(header, end),
      pts,
      dts,
    });
  }
  flush(): void {
    if (this.tail.length) throw new Error('Truncated TS packet');
    for (const pid of [...this.assemblies.keys()]) this.finish(pid);
    if (!this.signature) throw new Error('Selected service PAT/PMT not found');
  }
}
