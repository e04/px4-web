export function mpegCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  return crc >>> 0;
}

export interface Service {
  serviceId: number;
  pmtPid: number;
  pmtVersion?: number;
  pcrPid?: number;
  streams?: { pid: number; streamType: number; componentTag?: number }[];
}

// ARIB TR-B14 stream_identifier (0x52) component tags: 0x30 caption, 0x38 superimpose.
// aribb24.js uses the same rule to tell caption PES apart from other private streams.
export function captionPid(service: Service | undefined): number | undefined {
  const candidates = service?.streams?.filter((s) => s.streamType === 6) ?? [];
  return candidates.find((s) => s.componentTag === 0x30)?.pid ?? candidates[0]?.pid;
}
export function superimposePid(
  service: Service | undefined,
  caption: number | undefined,
): number | undefined {
  const pid = service?.streams?.find(
    (s) => s.streamType === 6 && s.componentTag === 0x38 && s.pid !== caption,
  )?.pid;
  return pid === caption ? undefined : pid;
}

// Each PID holds at most one 1024-byte PSI section. Pointer bytes may only
// complete the previous section; new sections begin after the pointer boundary.
class SectionAssembler {
  private bytes: number[] = [];
  reset(): void {
    this.bytes = [];
  }
  push(payload: Uint8Array, start: boolean, section: (bytes: Uint8Array) => void): void {
    let offset = 0;
    if (start) {
      const pointer = payload[0];
      if (pointer === undefined || pointer + 1 > payload.length) {
        this.reset();
        return;
      }
      if (this.bytes.length) this.feed(payload.subarray(1, pointer + 1), false, section);
      this.reset();
      offset = pointer + 1;
    } else if (!this.bytes.length) return;
    this.feed(payload.subarray(offset), start, section);
  }
  private feed(payload: Uint8Array, allowNew: boolean, section: (bytes: Uint8Array) => void): void {
    for (const byte of payload) {
      if (!this.bytes.length && (!allowNew || byte === 0xff)) return;
      this.bytes.push(byte);
      if (this.bytes.length < 3) continue;
      const length = 3 + (((this.bytes[1] & 15) << 8) | this.bytes[2]);
      if (length < 12 || length > 1024) {
        this.reset();
        return;
      }
      if (this.bytes.length === length) {
        section(new Uint8Array(this.bytes));
        this.reset();
      }
    }
  }
}

interface Table {
  key: string;
  last: number;
  sections: Map<number, Uint8Array>;
}
export class Psi {
  services: Service[] = [];
  transportStreamId?: number;
  patVersion?: number;
  crcErrors = 0;
  malformedSections = 0;
  private assemblers = new Map<number, SectionAssembler>();
  private tables = new Map<number, Table>();
  private applied = new Map<number, string>();
  resetPid(pid: number): void {
    this.assemblers.get(pid)?.reset();
  }
  push(pid: number, payload: Uint8Array, start: boolean): void {
    if (pid !== 0 && !this.services.some((s) => s.pmtPid === pid)) return;
    let assembler = this.assemblers.get(pid);
    if (!assembler) {
      assembler = new SectionAssembler();
      this.assemblers.set(pid, assembler);
    }
    assembler.push(payload, start, (bytes) => this.section(pid, bytes));
  }
  private section(pid: number, bytes: Uint8Array): void {
    if (!(bytes[1] & 0x80) || bytes[0] !== (pid === 0 ? 0 : 2)) {
      this.malformedSections++;
      return;
    }
    if (mpegCrc32(bytes) !== 0) {
      this.crcErrors++;
      return;
    }
    if (!(bytes[5] & 1)) return;
    const extension = (bytes[3] << 8) | bytes[4];
    const version = (bytes[5] >>> 1) & 31;
    const number = bytes[6],
      last = bytes[7];
    if (
      number > last ||
      (pid !== 0 &&
        (last !== 0 || !this.services.some((s) => s.pmtPid === pid && s.serviceId === extension)))
    ) {
      this.malformedSections++;
      return;
    }
    const key = `${extension}/${version}`;
    if (this.applied.get(pid) === key) return;
    let table = this.tables.get(pid);
    if (!table || table.key !== key || table.last !== last) {
      table = { key, last, sections: new Map() };
      this.tables.set(pid, table);
    }
    table.sections.set(number, bytes);
    if (table.sections.size !== last + 1) return;
    if (pid === 0) {
      const services: Service[] = [];
      for (let n = 0; n <= last; n++) {
        const s = table.sections.get(n)!;
        if ((s.length - 12) % 4) {
          this.malformedSections++;
          return;
        }
        for (let i = 8; i < s.length - 4; i += 4) {
          const serviceId = (s[i] << 8) | s[i + 1],
            pmtPid = ((s[i + 2] & 31) << 8) | s[i + 3];
          if (serviceId) services.push({ serviceId, pmtPid });
        }
      }
      this.services = services;
      this.transportStreamId = extension;
      this.patVersion = version;
      // A new PAT invalidates PMT state, including unchanged PIDs reused by another service.
      for (const p of this.assemblers.keys()) if (p !== 0) this.assemblers.delete(p);
      for (const p of this.tables.keys()) if (p !== 0) this.tables.delete(p);
      this.applied.clear();
    } else {
      if (bytes.length < 16) {
        this.malformedSections++;
        return;
      }
      const end = bytes.length - 4;
      let offset = 12 + (((bytes[10] & 15) << 8) | bytes[11]);
      const streams: NonNullable<Service['streams']> = [];
      while (offset + 5 <= end) {
        const next = offset + 5 + (((bytes[offset + 3] & 15) << 8) | bytes[offset + 4]);
        if (next > end) break;
        let componentTag: number | undefined;
        for (let d = offset + 5; d + 2 <= next;) {
          const len = bytes[d + 1];
          if (d + 2 + len > next) break;
          if (bytes[d] === 0x52 && len >= 1) componentTag = bytes[d + 2];
          d += 2 + len;
        }
        streams.push({
          streamType: bytes[offset],
          pid: ((bytes[offset + 1] & 31) << 8) | bytes[offset + 2],
          ...(componentTag !== undefined ? { componentTag } : {}),
        });
        offset = next;
      }
      if (offset !== end) {
        this.malformedSections++;
        return;
      }
      const service = this.services.find((s) => s.serviceId === extension && s.pmtPid === pid)!;
      Object.assign(service, {
        pmtVersion: version,
        pcrPid: ((bytes[8] & 31) << 8) | bytes[9],
        streams,
      });
    }
    this.applied.set(pid, key);
    this.tables.delete(pid);
  }
}
