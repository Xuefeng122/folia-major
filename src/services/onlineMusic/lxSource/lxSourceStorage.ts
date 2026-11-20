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

// The copy an online update replaced: kept beside the script so a bad update can be undone after
// the fact instead of costing the listener a source. One copy per source, the newest one.
const backupKey = (id: string) => `lx-source-backup:${id}`;

export interface LxSourceBackup {
    code: string;
    version?: string;
    at: number;
}

export const readLxSourceBackup = async (id: string): Promise<LxSourceBackup | null> => {
    try {
        const stored = await getFromCache<LxSourceBackup>(backupKey(id));
        return typeof stored?.code === 'string' && stored.code ? { ...stored, at: stored.at ?? 0 } : null;
    } catch (error) {
        console.warn('[LxSource] Failed to read a script backup', error);
        return null;
    }
};

export const writeLxSourceBackup = async (id: string, backup: LxSourceBackup): Promise<void> => {
    try {
        await saveToCache(backupKey(id), backup);
    } catch (error) {
        console.warn('[LxSource] Failed to save a script backup', error);
    }
};

export const deleteLxSourceScript = async (id: string): Promise<void> => {
    try {
        await removeFromCache(scriptKey(id));
        await removeFromCache(backupKey(id));
    } catch (error) {
        console.warn('[LxSource] Failed to delete a script', error);
    }
};
