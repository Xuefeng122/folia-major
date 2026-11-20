// src/services/onlineMusic/lxSource/builtinSources.ts
// The scripts the app ships with. A phone has no file picker worth the name, so the sources a
// listener is likely to want are already in the build: on first start each is imported exactly as
// if it had been picked by hand, and after that the list belongs to the listener alone (removing one
// keeps it removed — the seed runs once).
//
// The bodies are kept out of the main bundle: every script is its own chunk, read when the seed
// actually runs. `luoxue_v4.js` ships switched off — it is the one that cannot register a request
// handler any more, and is kept only so it can be read and turned back on by hand.

import { readLxScriptHeader } from './lxSourceSandbox';
import { useLxSourceStore } from './lxSourceStore';

const SEED_KEY = 'folia_lx_builtin_seed_v1';
/** Which shipped version of each built-in script this install has already taken on. */
const SYNC_KEY = 'folia_lx_builtin_sync_v1';

/** The scripts that ship disabled: they load, but nothing is asked of them until switched on. */
const DISABLED_SCRIPTS = new Set(['./builtin/luoxue_v4.js']);

type RawLoader = () => Promise<string>;

const loaders = import.meta.glob('./builtin/*.js', {
    query: '?raw',
    import: 'default',
}) as Record<string, RawLoader>;

const readSeeded = (): string | null => {
    if (typeof window === 'undefined') return null;
    try {
        return window.localStorage.getItem(SEED_KEY);
    } catch {
        return null;
    }
};

const markSeeded = (): void => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(SEED_KEY, String(Date.now()));
    } catch (error) {
        console.warn('[LxSource] Failed to record that the built-in sources were imported', error);
    }
};

/**
 * Imports every built-in script once. Safe to call on every start: it returns at once once the seed
 * has run, and a source that is already there under the same name is left alone.
 */
export const ensureBuiltinLxSources = async (): Promise<void> => {
    const paths = Object.keys(loaders).sort();
    // A build that ships a newer 念心/长青 still lands on top of an install that seeded the old one:
    // the seed is once-only, the version pass is not.
    if (readSeeded()) {
        await syncBuiltinVersions(paths);
        return;
    }
    const store = useLxSourceStore.getState();
    // A listener who imported scripts of their own before the seed existed is not handed a second
    // copy of the same sources on the next start.
    if (store.sources.length > 0) {
        markSeeded();
        return;
    }
    for (const path of paths) {
        try {
            const code = await loaders[path]();
            const meta = await useLxSourceStore.getState().importSource(code, path.split('/').pop());
            if (DISABLED_SCRIPTS.has(path)) {
                useLxSourceStore.getState().setEnabled(meta.id, false);
            }
        } catch (error) {
            console.warn(`[LxSource] Failed to import the built-in script ${path}`, error);
        }
    }
    markSeeded();
    await syncBuiltinVersions(paths);
};

const readSynced = (): Record<string, string> => {
    if (typeof window === 'undefined') return {};
    try {
        const raw = window.localStorage.getItem(SYNC_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
    } catch {
        return {};
    }
};

const writeSynced = (map: Record<string, string>): void => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(SYNC_KEY, JSON.stringify(map));
    } catch (error) {
        console.warn('[LxSource] Failed to record the built-in script versions', error);
    }
};

/** Numeric-aware version compare; >0 means `a` is newer than `b`. */
const compareVersions = (a: string, b: string): number => {
    const left = a.split(/[.\-_+]/u).map(part => Number.parseInt(part, 10) || 0);
    const right = b.split(/[.\-_+]/u).map(part => Number.parseInt(part, 10) || 0);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
};

/**
 * Takes on a newer copy of a shipped script. A build that bumps 念心 or 长青 ships the new body under
 * its own file name, but an install that already seeded the old one keeps the old one forever: the
 * seed runs once. This pass upgrades a built-in source in place — only where the name matches and the
 * shipped version is genuinely newer — and records what it applied so it costs nothing on later starts.
 * A source the listener edited by hand is overwritten by the newer release, which is the point: the
 * shipped copy is the one that is known to work.
 */
const syncBuiltinVersions = async (paths: string[]): Promise<void> => {
    const synced = readSynced();
    let changed = false;
    for (const path of paths) {
        try {
            const code = await loaders[path]();
            const header = readLxScriptHeader(code);
            const version = header.version ?? '';
            if (!header.name || !version) continue;
            const key = `${header.name}@${version}`;
            if (synced[path] === version) continue;
            const store = useLxSourceStore.getState();
            const installed = store.sources.find(source => source.name === header.name);
            if (!installed) {
                synced[path] = version;
                changed = true;
                continue;
            }
            if (compareVersions(version, installed.version ?? '0') <= 0) {
                synced[path] = version;
                changed = true;
                continue;
            }
            const { replaceLxSourceScript } = await import('./lxSourceUpdater');
            await replaceLxSourceScript(installed, code, installed.updateUrl);
            console.log(`[LxSource] 内置脚本 ${header.name} 已升级到 ${version}（原 ${installed.version ?? '未知'}，${key}）`);
            synced[path] = version;
            changed = true;
        } catch (error) {
            console.warn(`[LxSource] 内置脚本 ${path} 升级失败`, error);
        }
    }
    if (changed) writeSynced(synced);
};
