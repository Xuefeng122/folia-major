// src/services/onlineMusic/lxSource/builtinSources.ts
// The scripts the app ships with. A phone has no file picker worth the name, so the sources a
// listener is likely to want are already in the build: on first start each is imported exactly as
// if it had been picked by hand, and after that the list belongs to the listener alone (removing one
// keeps it removed — the seed runs once).
//
// The bodies are kept out of the main bundle: every script is its own chunk, read when the seed
// actually runs. `luoxue_v4.js` ships switched off — it is the one that cannot register a request
// handler any more, and is kept only so it can be read and turned back on by hand.

import { useLxSourceStore } from './lxSourceStore';

const SEED_KEY = 'folia_lx_builtin_seed_v1';

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
    if (readSeeded()) return;
    const store = useLxSourceStore.getState();
    // A listener who imported scripts of their own before the seed existed is not handed a second
    // copy of the same sources on the next start.
    if (store.sources.length > 0) {
        markSeeded();
        return;
    }
    const paths = Object.keys(loaders).sort();
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
};
