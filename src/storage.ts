import { createStore, get, set, type UseStore } from 'idb-keyval';

// idb-keyval's createStore opens the DB without a version bump, so multiple
// stores in one DB never get created (only the first opener wins). Use one
// DB per store so settings/scan each actually persist.
export const settingsStore: UseStore = createStore('px4-settings', 'settings');
export const scanStore: UseStore = createStore('px4-scan', 'scan');
export const epgStore: UseStore = createStore('px4-epg', 'epg');
export const logoStore: UseStore = createStore('px4-logo', 'logo');

export const CHANNEL_KEY = 'px4-channel';
export const CAPTION_KEY = 'px4-caption';
export const VOLUME_KEY = 'px4-volume';

export async function loadValue<T>(key: string, store: UseStore): Promise<T | undefined> {
  try {
    return await get<T>(key, store);
  } catch {
    return undefined;
  }
}

export async function saveValue(key: string, value: unknown, store: UseStore): Promise<void> {
  try {
    await set(key, value, store);
  } catch {
    /* Storage may be unavailable. */
  }
}
