// src/mods/market/zip.ts
// Unpacking a mod zip in the page.
//
// The desktop main process unzips with the file system's help and validates the tree against
// path traversal before writing anything. Here nothing is written: the zip comes out of fetch
// as bytes, fflate inflates it (the same library the desktop build already depends on) and the
// entries stay in memory, keyed by path relative to the mod folder. Paths that try to climb out
// of that folder are dropped, not sanitised.

import { unzipSync } from 'fflate';

import type { WebModManifest } from '../web/manifest';

export interface UnpackedMod {
    manifest: WebModManifest;
    /** Path relative to the mod folder ('client.mjs', 'vendor/pixi.min.mjs'). */
    files: Record<string, Uint8Array>;
    /** The folder the manifest sat in, '' when it sat at the zip's root. */
    folder: string;
}

export type UnpackResult = { ok: true; mod: UnpackedMod } | { ok: false; error: string };

const IGNORED = new Set(['.DS_Store', 'Thumbs.db']);

const isUnsafePath = (path: string): boolean => path.split('/').some((part) => part === '..' || part === '');

const parseManifest = (bytes: Uint8Array): WebModManifest | null => {
    try {
        const text = new TextDecoder('utf-8').decode(bytes);
        const manifest = JSON.parse(text) as WebModManifest;
        if (!manifest || typeof manifest !== 'object') {
            return null;
        }
        if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
            return null;
        }
        return manifest;
    } catch {
        return null;
    }
};

/** Reads a mod zip into its manifest and files. Nothing is installed yet. */
export const unpackModZip = (bytes: Uint8Array): UnpackResult => {
    let entries: Record<string, Uint8Array>;
    try {
        entries = unzipSync(bytes);
    } catch (error) {
        return { ok: false, error: `zip-unreadable:${(error as Error)?.message ?? 'unknown'}` };
    }

    const paths = Object.keys(entries).filter((path) => {
        const name = path.split('/').pop() ?? path;
        return !path.endsWith('/') && !IGNORED.has(name) && !path.startsWith('__MACOSX/');
    });

    const manifestPath = paths
        .filter((path) => (path.split('/').pop() ?? '') === 'mod.json')
        .sort((left, right) => left.split('/').length - right.split('/').length)[0];
    if (!manifestPath) {
        return { ok: false, error: 'manifest-missing' };
    }

    const folder = manifestPath.includes('/')
        ? manifestPath.slice(0, manifestPath.lastIndexOf('/'))
        : '';
    const manifest = parseManifest(entries[manifestPath]);
    if (!manifest) {
        return { ok: false, error: 'manifest-unreadable' };
    }
    if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
        return { ok: false, error: 'manifest-version-missing' };
    }

    const prefix = folder ? `${folder}/` : '';
    const files: Record<string, Uint8Array> = {};
    for (const path of paths) {
        const relative = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
        if (!relative || isUnsafePath(relative)) {
            continue;
        }
        files[relative] = entries[path];
    }
    if (!manifest.client || !files[manifest.client]) {
        return { ok: false, error: 'client-entry-missing' };
    }

    return { ok: true, mod: { manifest, files, folder } };
};

/** The catalogue's preview image path, when the zip carries one and the catalogue does not. */
export const previewBytesOf = (files: Record<string, Uint8Array>): Uint8Array | null =>
    files['preview.jpg'] ?? files['preview.png'] ?? files['preview.jpeg'] ?? null;
