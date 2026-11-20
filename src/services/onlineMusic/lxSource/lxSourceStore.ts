// src/services/onlineMusic/lxSource/lxSourceStore.ts
// The imported sources as the app keeps them: which are on, in which order they are tried, and
// what the last play learned about each. The scripts themselves are read on demand
// (lxSourceStorage.ts); nothing here holds their text.

import { create } from 'zustand';
import { clearLxUpdateAlert, lxUpdateAlertOf, probeLxSourceScript, readLxScriptHeader } from './lxSourceSandbox';
import { readLxAddressText } from './nativeScriptFetch';
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


/** Where a source may be imported from: pasted text, a file, or the address its text is served at. */
export interface LxImportOptions {
    /** The address the script was read from, kept so the row can check for a newer copy later. */
    updateUrl?: string;
}

interface LxSourceState {
    sources: LxSourceMeta[];
    /** A script being imported, so the page can show that something is happening. */
    importing: boolean;
    importSource: (code: string, fileName?: string, options?: LxImportOptions) => Promise<LxSourceMeta>;
    /** Reads a script from an address and imports it, keeping the address for later update checks. */
    importSourceFromAddress: (address: string) => Promise<LxSourceMeta>;
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
    /** Whether a play may switch itself to another source's copy of the same song. */
    autoSwitch: boolean;
    setAutoSwitch: (value: boolean) => void;
}

// Whether a play that runs out of addresses anywhere for its own platform may switch itself to
// another platform's source. On by default: an iOS play that dies on a preview clip is the worse
// outcome, and the listener can still turn the chain off.
const AUTO_SWITCH_KEY = 'folia_lx_auto_switch_v1';

const readAutoSwitch = (): boolean => {
    try {
        const stored = globalThis.localStorage?.getItem(AUTO_SWITCH_KEY);
        return stored === null || stored === undefined ? true : stored === '1';
    } catch {
        return true;
    }
};

const writeAutoSwitch = (value: boolean): void => {
    try {
        globalThis.localStorage?.setItem(AUTO_SWITCH_KEY, value ? '1' : '0');
    } catch {
        // A store that cannot be written still keeps the switch for this session.
    }
};

const persist = (sources: LxSourceMeta[]) => {
    writeLxSourceMetas(sources.map((source, index) => ({ ...source, order: index })));
};

export const useLxSourceStore = create<LxSourceState>((set, get) => ({
    sources: readLxSourceMetas(),
    importing: false,

    async importSource(code, fileName, options) {
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
                // The address the row checks for a newer copy: the one it was imported from, then the
                // one its own header declares (念心/长青 both publish an update_url), then a guess from
                // its homepage. Without this a built-in source has nothing to be refreshed against.
                updateUrl: options?.updateUrl?.trim() || header.updateUrl || updateAddressFrom(header.homepage),
                platforms: detectPlatforms(trimmed),
                enabled: true,
                order: get().sources.length,
                addedAt: Date.now(),
            };
            // The script is run once before it is stored: a script that does not compile, or that
            // registers no handler, is reported now rather than failing silently at play time. What it
            // says it speaks for outranks what its text looked like it mentioned.
            let probe;
            try {
                probe = await probeLxSourceScript(meta, trimmed);
            } catch (error) {
                throw new Error(error instanceof Error ? error.message : String(error));
            }
            // A script that found itself out of date registers no handler on purpose: 长青 sends
            // `updateAlert` and returns. Such a script is still worth keeping — the row offers the
            // update it asked for — so the missing handler is only fatal where nothing was announced.
            if (!probe.usable) {
                const alert = lxUpdateAlertOf(meta.id);
                if (!alert) throw new Error('脚本没有注册 request 处理器（可能语法不完整）');
                meta.updateUrl = meta.updateUrl || alert.updateUrl || undefined;
                console.warn(`[LxSource] ${meta.name} 导入时即报告需要更新：${alert.log}`);
            }
            if (probe.platforms.length) meta.platforms = probe.platforms;
            else meta.platforms = meta.platforms.length ? meta.platforms : ALL_PLATFORMS;
            await writeLxSourceScript(meta.id, trimmed);
            const sources = [...get().sources, meta];
            persist(sources);
            set({ sources });
            return meta;
        } finally {
            set({ importing: false });
        }
    },

    async importSourceFromAddress(address) {
        const trimmed = address.trim();
        if (!/^https?:\/\//iu.test(trimmed)) throw new Error('The address must start with http:// or https://');
        const readAddress = updateAddressFrom(trimmed) ?? trimmed;
        // Through the native bridge on the phone: a script on another origin cannot be read by fetch
        // from inside the WebView (no CORS headers on those hosts), so importing by address only works
        // when the request is made outside it.
        const { text } = await readLxAddressText(readAddress);
        const code = text.replace(/^\uFEFF/u, '');
        if (!code.trim()) throw new Error('地址返回了空内容');
        // A release page is not a script: saying so is clearer than storing a page's text.
        if (/^\s*</u.test(code) && /<html/iu.test(code.slice(0, 400))) {
            throw new Error('这个地址返回的是网页，不是脚本；请打开它指向的 .js 原文地址再导入');
        }
        if (/^\s*[[{]/u.test(code) && /"(url|version)"\s*:/u.test(code.slice(0, 600))) {
            throw new Error('这个地址是版本清单（JSON），不是脚本本身');
        }
        const fileName = readAddress.split('/').pop()?.split('?')[0];
        return get().importSource(code, fileName, { updateUrl: readAddress });
    },

    async removeSource(id) {
        const sources = get().sources.filter(source => source.id !== id);
        persist(sources);
        set({ sources });
        clearLxUpdateAlert(id);
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

    autoSwitch: readAutoSwitch(),

    setAutoSwitch(value) {
        writeAutoSwitch(value);
        set({ autoSwitch: value });
    },

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

/** Whether the play may switch itself to another source's copy of the same song. */
export const isLxAutoSwitchEnabled = (): boolean => useLxSourceStore.getState().autoSwitch;
