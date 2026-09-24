// Design adapted from reference/web-isdb-t-viewer/src/receiver/program-information.js
// (SI section reassembly for SDT/NIT/EIT p/f + ARIB text/time decoding).
import { readSection } from 'arib-mmt-tlv-ts/ts/si.js';
import { decodeSIText } from 'arib-mmt-tlv-ts/ts/si-text-decoder.js';
import type { EventInformation } from 'arib-mmt-tlv-ts/ts/si.js';
import { betterLogo, completeLogoPng, logoKey, type LogoData, type LogoRef } from '../logo';

export interface ProgramEvent {
  id: number;
  title: string;
  description: string;
  /** EIT content_descriptor nibbles (ARIB STD-B10 genre table). */
  genres: { level1: number; level2: number }[];
  start: number | null;
  end: number | null;
}

export interface ProgramInfo {
  serviceId: number;
  stationName: string;
  current: ProgramEvent | null;
  next: ProgramEvent | null;
  future: ProgramEvent[];
  /** SDT service_descriptor service_type (0x01 = digital TV). */
  serviceType?: number;
  /** NIT ts_information_descriptor remote_control_key_id (terrestrial). */
  remoteKey?: number;
  /** SDT logo_transmission_descriptor; the image itself arrives in CDT. */
  logo?: LogoRef;
}

interface ServiceState {
  serviceId: number;
  stationName: string;
  tsName?: string;
  serviceType?: number;
  remoteKey?: number;
  logo?: LogoRef;
  current: ProgramEvent | null;
  next: ProgramEvent | null;
  future: Map<number, ProgramEvent>;
}

interface FragmentState {
  cc: number;
  bytes: number[];
}

// 0x29 carries CDT (station logos).
const PIDS = new Set([0x10, 0x11, 0x12, 0x26, 0x27, 0x29]);
// CDT data_type for logo data.
const CDT_LOGO = 0x01;
const JAPANESE = 0x6a706e;
const DAY_MS = 86400000;
// ARIB MJD epoch (1858-11-17) to Unix epoch days.
const MJD_UNIX_EPOCH_DAYS = 40587;

const text = (bytes: Uint8Array): string => decodeSIText(bytes).trim();

function bcdDuration(value: number | undefined): number | null {
  if (value == null) return null;
  const parts = [value >>> 16, (value >>> 8) & 255, value & 255];
  if (parts.some((part) => (part & 15) > 9 || part >>> 4 > 9)) return null;
  const [hours, minutes, seconds] = parts.map((part) => (part >>> 4) * 10 + (part & 15));
  return minutes < 60 && seconds < 60 ? (hours * 3600 + minutes * 60 + seconds) * 1000 : null;
}

function eventInfo(event: EventInformation | undefined): ProgramEvent | null {
  if (!event) return null;
  const short =
    event.descriptors.find((d) => d.tag === 'shortEvent' && d.iso639LanguageCode === JAPANESE) ??
    event.descriptors.find((d) => d.tag === 'shortEvent');
  const content = event.descriptors.find((d) => d.tag === 'content');
  const time = event.startTime;
  const clock = time == null ? null : bcdDuration(time % 0x1000000);
  // ARIB MJD + BCD carries Japan local time, independent of the browser timezone.
  const start =
    clock == null || clock >= DAY_MS
      ? null
      : (Math.floor(time! / 0x1000000) - MJD_UNIX_EPOCH_DAYS) * DAY_MS + clock - 9 * 3600000;
  const length = bcdDuration(event.duration);
  return {
    id: event.eventId,
    title: short && short.tag === 'shortEvent' ? text(short.eventName) : '',
    description: short && short.tag === 'shortEvent' ? text(short.text) : '',
    genres:
      content?.tag === 'content'
        ? content.items.map((item) => ({ level1: item.contentNibbleLevel1, level2: item.contentNibbleLevel2 }))
        : [],
    start,
    end: start != null && length != null ? start + length : null,
  };
}

// Keeps SI across decode windows. Callers select the entry for the tuned service.
export class ProgramInformation {
  private readonly fragments = new Map<number, FragmentState>();
  private readonly services = new Map<number, ServiceState>();
  private readonly logoData = new Map<string, LogoData>();

  resetFragments(): void {
    this.fragments.clear();
  }

  reset(): void {
    this.fragments.clear();
    this.services.clear();
    this.logoData.clear();
  }

  private service(id: number): ServiceState {
    let service = this.services.get(id);
    if (!service) {
      service = { serviceId: id, stationName: '', current: null, next: null, future: new Map() };
      this.services.set(id, service);
    }
    return service;
  }

  private read(bytes: Uint8Array, pid: number): void {
    try {
      // The library validates MPEG CRC before parsing descriptors.
      const section = readSection(bytes);
      if (!section || !('currentNextIndicator' in section) || !section.currentNextIndicator) return;
      if (pid === 0x11 && section.tableId === 'SDT[actual]') {
        for (const service of section.services) {
          const descriptor = service.descriptors.find((d) => d.tag === 'service');
          if (descriptor?.tag === 'service') {
            this.service(service.serviceId).stationName = text(descriptor.serviceName);
            this.service(service.serviceId).serviceType = descriptor.serviceType;
          }
          const logo = service.descriptors.find((d) => d.tag === 'logoTransmission');
          // Type 3 (simple logo) is a character string, not a CDT image.
          if (logo?.tag === 'logoTransmission' && logo.logoTransmissionType !== 3)
            this.service(service.serviceId).logo = {
              networkId: section.originalNetworkId,
              logoId: logo.logoId,
            };
        }
      } else if (pid === 0x29 && section.tableId === 'CDT') {
        const module = section.dataModule;
        // Each section carries one complete logo_type of the logo.
        if (section.dataType !== CDT_LOGO || module.logoType > 5) return;
        const png = completeLogoPng(module.data);
        if (!png) return;
        const logo: LogoData = {
          networkId: section.originalNetworkId,
          logoId: module.logoId,
          type: module.logoType,
          version: module.logoVersion,
          png,
        };
        const key = logoKey(logo);
        if (betterLogo(logo, this.logoData.get(key))) this.logoData.set(key, logo);
      } else if (pid === 0x10 && section.tableId === 'NIT[actual]') {
        // One-seg may omit SDT; the TS name is a useful broadcast-provided fallback.
        for (const stream of section.transportStreams) {
          const info = stream.transportDescriptors.find((d) => d.tag === 'tsInformation');
          if (info?.tag !== 'tsInformation') continue;
          for (const transmission of info.transmissionTypes)
            for (const id of transmission.serviceIdList) {
              this.service(id).tsName = text(info.tsName);
              this.service(id).remoteKey = info.remoteControlKeyId;
            }
        }
      } else if (
        (pid === 0x12 || pid === 0x26 || pid === 0x27) &&
        (section.tableId === 'EIT[p/f]' ||
          section.tableId === 'EIT[schedule basic]' ||
          section.tableId === 'EIT[schedule extended]') &&
        !section.other
      ) {
        const service = this.service(section.serviceId);
        if (section.tableId === 'EIT[p/f]') {
          if (section.sectionNumber <= 1)
            service[section.sectionNumber === 0 ? 'current' : 'next'] = eventInfo(
              section.events[0],
            );
        } else {
          for (const raw of section.events) {
            const event = eventInfo(raw);
            if (event?.start != null && event.end != null && event.end > Date.now())
              service.future.set(event.id, event);
          }
        }
      }
    } catch {
      // Damaged descriptors must not interrupt TS reception.
    }
  }

  private append(pid: number, state: FragmentState, bytes: Uint8Array, multiple: boolean): void {
    for (const byte of bytes) state.bytes.push(byte);
    while (state.bytes.length >= 3) {
      if (state.bytes[0] === 0xff) {
        state.bytes = [];
        return;
      }
      const length = 3 + ((state.bytes[1]! & 15) << 8) + state.bytes[2]!;
      if (length < 12 || length > 4096) {
        this.fragments.delete(pid);
        return;
      }
      if (state.bytes.length < length) return;
      this.read(Uint8Array.from(state.bytes.splice(0, length)), pid);
      if (!multiple) {
        state.bytes = [];
        return;
      }
    }
  }

  pushPacket(packet: Uint8Array): void {
    if (packet.length < 188) return;
    const pid = ((packet[1]! & 31) << 8) | packet[2]!;
    if (!PIDS.has(pid)) return;
    if (packet[0] !== 0x47 || packet[1]! & 128 || packet[3]! & 192) {
      this.fragments.delete(pid);
      return;
    }
    const adaptation = !!(packet[3]! & 32);
    if (adaptation && packet[4]! > 0 && packet[5]! & 128) this.fragments.delete(pid);
    if (!(packet[3]! & 16)) return;
    let offset = 4 + (adaptation ? 1 + packet[4]! : 0);
    if (offset >= 188) {
      this.fragments.delete(pid);
      return;
    }
    const cc = packet[3]! & 15;
    let state = this.fragments.get(pid);
    if (state?.cc === cc) return;
    if (state && ((state.cc + 1) & 15) !== cc) {
      this.fragments.delete(pid);
      state = undefined;
    }
    if (packet[1]! & 64) {
      const pointer = packet[offset]!;
      offset += 1;
      if (offset + pointer > 188) {
        this.fragments.delete(pid);
        return;
      }
      if (state?.bytes.length)
        this.append(pid, state, packet.subarray(offset, offset + pointer), false);
      offset += pointer;
      state = { cc, bytes: [] };
      this.fragments.set(pid, state);
    } else if (!state?.bytes.length) return;
    state!.cc = cc;
    this.append(pid, state!, packet.subarray(offset), true);
  }

  snapshot(): Record<number, ProgramInfo> {
    const result: Record<number, ProgramInfo> = {};
    for (const service of this.services.values()) {
      const now = Date.now();
      for (const [id, event] of service.future)
        if (event.end != null && event.end <= now) service.future.delete(id);
      result[service.serviceId] = {
        serviceId: service.serviceId,
        stationName: service.stationName || service.tsName || '',
        current: service.current,
        next: service.next,
        future: [...service.future.values()].sort((a, b) => (a.start ?? 0) - (b.start ?? 0)),
        ...(service.serviceType != null ? { serviceType: service.serviceType } : {}),
        ...(service.remoteKey != null ? { remoteKey: service.remoteKey } : {}),
        ...(service.logo ? { logo: service.logo } : {}),
      };
    }
    return result;
  }

  logos(): LogoData[] {
    return [...this.logoData.values()];
  }
}
