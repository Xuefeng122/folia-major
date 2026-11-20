// src/services/onlineMusic/lxSource/lxSourceStorage.ts
// Where imported sources live: the metadata (small, read on every start) in the settings storage,
// the script body (up to a couple of megabytes) in the media store beside the caches.

import { getFromCache, removeFromCache, saveToCache } from '../../db';
import type { LxSourceMeta } from './lxSourceTypes';

const META_KEY = 'folia_lx_sources';
const SCRIPT_KEY_PREFIX = 'lx-source-script:';

const scriptKey = (id: string) => `${SCRIPT_KEY_PREFIX}${id}`;

export const readLxSourceMetas = (): LxSourceMeta[] => {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(META_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return (parsed as LxSourceMeta[])
            .filter(item => item && typeof item.id === 'string')
            .map((item, index) => ({
                ...item,
                platforms: Array.isArray(item.platforms) ? item.platforms : [],
                enabled: item.enabled !== false,
                order: typeof item.order === 'number' ? item.order : index,
                addedAt: typeof item.addedAt === 'number' ? item.addedAt : Date.now(),
            }))
            .sort((a, b) => a.order - b.order);
    } catch (error) {
        console.warn('[LxSource] Failed to read the source list', error);
        return [];
    }
};

export const writeLxSourceMetas = (metas: LxSourceMeta[]): void => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(META_KEY, JSON.stringify(metas));
    } catch (error) {
        console.warn('[LxSource] Failed to save the source list', error);
    }
};

export const readLxSourceScript = async (id: string): Promise<string | null> => {
    try {
        const stored = await getFromCache<{ code?: string }>(scriptKey(id));
        const code = stored?.code;
        return typeof code === 'string' && code ? code : null;
    } catch (error) {
        console.warn('[LxSource] Failed to read a script', error);
        return null;
    }
};

export const writeLxSourceScript = async (id: string, code: string): Promise<void> => {
    await saveToCache(scriptKey(id), { code });
};

export const deleteLxSourceScript = async (id: string): Promise<void> => {
    try {
        await removeFromCache(scriptKey(id));
    } catch (error) {
        console.warn('[LxSource] Failed to delete a script', error);
    }
};
