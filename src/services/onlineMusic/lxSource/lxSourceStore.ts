// src/services/onlineMusic/lxSource/lxSourceStore.ts
// The imported sources as the app keeps them: which are on, in which order they are tried, and
// what the last play learned about each. The scripts themselves are read on demand
// (lxSourceStorage.ts); nothing here holds their text.

import { create } from 'zustand';
import { readLxScriptHeader } from './lxSourceSandbox';
import {
    deleteLxSourceScript,
    readLxSourceMetas,
    readLxSourceScript,
    writeLxSourceMetas,
    writeLxSourceScript,
} from './lxSourceStorage';
import type { LxPlatformId, LxSourceMeta } from './lxSourceTypes';

const ALL_PLATFORMS: LxPlatformId[] = ['wy', 'tx', 'kg', 'kw', 'mg'];

const newId = (): string => {
    const uuid = globalThis.crypto?.randomUUID?.();
    return uuid ? `lx_${uuid.replace(/-/g, '').slice(0, 16)}` : `lx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
};

/** The platforms a script mentions, so a source that only speaks for one is not asked for another. */
const detectPlatforms = (code: string): LxPlatformId[] => {
    const found = ALL_PLATFORMS.filter(platform => new RegExp(`['"\`]${platform}['"\`]`).test(code));
    return found.length ? found : [...ALL_PLATFORMS];
};

/**
 * A script imported from a release page keeps the address it came from, so the settings page can
 * ask for a newer copy without the listener pasting the address again. A GitHub blob link is turned
 * into the raw address its text is served at; anything else is kept as it was written.
 */
const updateAddressFrom = (homepage?: string): string | undefined => {
    const trimmed = homepage?.trim();
    if (!trimmed || !/^https?:\/\//iu.test(trimmed)) return undefined;
    const github = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/u.exec(trimmed);
    if (github) {
        const [, owner, repo, branch, path] = github;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
    }
    const gist = /^https?:\/\/gist\.github\.com\/([^/]+)\/([^/]+)$/u.exec(trimmed);
    if (gist) return `https://gist.githubusercontent.com/${gist[1]}/${gist[2]}/raw`;
    return /\.jsx?(\?|$)/iu.test(trimmed) ? trimmed : undefined;
};


interface LxSourceState {
    sources: LxSourceMeta[];
    /** A script being imported, so the page can show that something is happening. */
    importing: boolean;
    importSource: (code: string, fileName?: string) => Promise<LxSourceMeta>;
    removeSource: (id: string) => Promise<void>;
    setEnabled: (id: string, enabled: boolean) => void;
    move: (id: string, direction: -1 | 1) => void;
    noteResult: (id: string, outcome: { ok: boolean; error?: string }) => void;
    /** The address a newer copy of this source is fetched from; empty clears the guess. */
    setUpdateUrl: (id: string, address: string) => void;
    /** Takes on a script that came from somewhere else (an online update, a rollback). */
    adoptScript: (id: string, patch: Partial<LxSourceMeta>) => void;
    /** The script of one source, read from the store on first use. */
    readScript: (id: string) => Promise<string | null>;
}

const persist = (sources: LxSourceMeta[]) => {
    writeLxSourceMetas(sources.map((source, index) => ({ ...source, order: index })));
};

export const useLxSourceStore = create<LxSourceState>((set, get) => ({
    sources: readLxSourceMetas(),
    importing: false,

    async importSource(code, fileName) {
        const trimmed = code.replace(/^\uFEFF/, '').trim();
        if (!trimmed) throw new Error('The script is empty');
        set({ importing: true });
        try {
            const header = readLxScriptHeader(trimmed);
            const name = header.name || (fileName ? fileName.replace(/\.js$/i, '') : '') || `Source ${get().sources.length + 1}`;
            const meta: LxSourceMeta = {
                id: newId(),
                name,
                description: header.description,
                version: header.version,
                author: header.author,
                homepage: header.homepage,
                updateUrl: updateAddressFrom(header.homepage),
                platforms: detectPlatforms(trimmed),
                enabled: true,
                order: get().sources.length,
                addedAt: Date.now(),
            };
            await writeLxSourceScript(meta.id, trimmed);
            const sources = [...get().sources, meta];
            persist(sources);
            set({ sources });
            return meta;
        } finally {
            set({ importing: false });
        }
    },

    async removeSource(id) {
        const sources = get().sources.filter(source => source.id !== id);
        persist(sources);
        set({ sources });
        await deleteLxSourceScript(id);
    },

    setEnabled(id, enabled) {
        const sources = get().sources.map(source => (source.id === id ? { ...source, enabled } : source));
        persist(sources);
        set({ sources });
    },

    move(id, direction) {
        const sources = [...get().sources];
        const index = sources.findIndex(source => source.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= sources.length) return;
        const [moved] = sources.splice(index, 1);
        sources.splice(target, 0, moved);
        persist(sources);
        set({ sources });
    },

    noteResult(id, outcome) {
        const sources = get().sources.map(source => (
            source.id === id
                ? {
                    ...source,
                    hits: (source.hits ?? 0) + (outcome.ok ? 1 : 0),
                    misses: (source.misses ?? 0) + (outcome.ok ? 0 : 1),
                    lastError: outcome.ok ? undefined : outcome.error,
                }
                : source
        ));
        persist(sources);
        set({ sources });
    },

    readScript: id => readLxSourceScript(id),

    setUpdateUrl(id, address) {
        const trimmed = address.trim();
        const sources = get().sources.map(source => (
            source.id === id ? { ...source, updateUrl: trimmed || undefined } : source
        ));
        persist(sources);
        set({ sources });
    },

    adoptScript(id, patch) {
        const sources = get().sources.map(source => (
            source.id === id
                ? {
                    ...source,
                    ...patch,
                    updatedAt: patch.updatedAt ?? Date.now(),
                    // What the last play learned about the old script says nothing about the new one.
                    hits: 0,
                    misses: 0,
                    lastError: undefined,
                }
                : source
        ));
        persist(sources);
        set({ sources });
    },
}));

/** The sources a play may be switched through, in the order the listener put them. */
export const enabledLxSources = (): LxSourceMeta[] => useLxSourceStore
    .getState()
    .sources
    .filter(source => source.enabled);
