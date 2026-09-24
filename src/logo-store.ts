import { entries, set, type UseStore } from 'idb-keyval';
import { betterLogo, logoKey, type LogoData, type LogoRef } from './logo';
import { logoStore } from './storage';

/** Service id → logo reference, per physical channel. */
export type ChannelLogoRefs = Record<number, LogoRef>;

export interface LogoLibrary {
  /** logoKey → stored logo. */
  logos: Record<string, LogoData>;
  /** channel → service id → logo reference. */
  channels: Record<string, ChannelLogoRefs>;
}

const LOGO_PREFIX = 'logo:';
const CHANNEL_PREFIX = 'channel:';

export async function loadLogos(store: UseStore = logoStore): Promise<LogoLibrary> {
  const library: LogoLibrary = { logos: {}, channels: {} };
  try {
    for (const [key, value] of await entries<string, unknown>(store)) {
      if (typeof key !== 'string' || !value || typeof value !== 'object') continue;
      if (key.startsWith(LOGO_PREFIX)) {
        const logo = value as LogoData;
        if (logo.png instanceof Uint8Array) library.logos[key.slice(LOGO_PREFIX.length)] = logo;
      } else if (key.startsWith(CHANNEL_PREFIX))
        library.channels[key.slice(CHANNEL_PREFIX.length)] = value as ChannelLogoRefs;
    }
  } catch {
    /* Storage may be unavailable. */
  }
  return library;
}

export async function saveLogo(logo: LogoData, store: UseStore = logoStore): Promise<void> {
  try {
    await set(LOGO_PREFIX + logoKey(logo), logo, store);
  } catch {
    /* Storage may be unavailable. */
  }
}

export async function saveChannelLogoRefs(
  channel: string,
  refs: ChannelLogoRefs,
  store: UseStore = logoStore,
): Promise<void> {
  try {
    await set(CHANNEL_PREFIX + channel, refs, store);
  } catch {
    /* Storage may be unavailable. */
  }
}

/**
 * Merge received logos and service references into the library. Returns the new
 * library (same object when nothing changed) and persists only what changed.
 */
export function mergeLogos(
  library: LogoLibrary,
  channel: string,
  refs: ChannelLogoRefs,
  logos: LogoData[],
): LogoLibrary {
  let next = library;
  for (const logo of logos) {
    const key = logoKey(logo);
    if (!betterLogo(logo, next.logos[key])) continue;
    next = { ...next, logos: { ...next.logos, [key]: logo } };
    void saveLogo(logo);
  }
  const known = next.channels[channel] ?? {};
  const merged = { ...known, ...refs };
  if (
    Object.entries(refs).some(([id, ref]) => {
      const old = known[Number(id)];
      return !old || old.networkId !== ref.networkId || old.logoId !== ref.logoId;
    })
  ) {
    next = { ...next, channels: { ...next.channels, [channel]: merged } };
    void saveChannelLogoRefs(channel, merged);
  }
  return next;
}
