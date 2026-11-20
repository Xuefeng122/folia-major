// src/mods/web/manifest.ts
// What a mod is once it lives in the page, and what the Web host will and will not run.
//
// The desktop loader runs a mod's Node entry in the main process, and grants it whatever its
// permissions ask for. Neither exists here: there is no Node, and nothing outside the page to
// ask. So the Web host takes client-only mods - no `main` entry, and no permission beyond
// `ui.stage`, which is the one thing a pure render client is allowed to reach (a stage layer
// in the player). Everything else stays installable-in-name-only and is refused with a reason
// the market shows, instead of installing a mod that would half work.

import type { ModSignatureInfo } from '../types';

/** The manifest fields the Web host reads. `mod.json`, as the catalogue's zips ship it. */
export interface WebModManifest {
    folium?: number;
    id: string;
    name?: string;
    version: string;
    author?: string;
    description?: string;
    client?: string;
    main?: string;
    preview?: string;
    permissions?: string[];
    experimental?: string[];
    embedOrigins?: string[];
    /** The Folia versions the mod asks for, e.g. ">=0.7.21 <0.8.0". */
    folia?: string;
}

/** A mod as stored: the manifest plus its tree, keyed by path relative to the mod folder. */
export interface StoredWebMod {
    id: string;
    version: string;
    manifest: WebModManifest;
    files: Record<string, Uint8Array>;
    installedAt: number;
    /** 'market': installed from the official catalogue; 'zip': a local zip the user picked. */
    source: 'market' | 'zip';
    /** The catalogue entry's download url, so an update can be offered later. */
    downloadUrl?: string | null;
    catalogOrigin?: string | null;
    /** What the catalogue said about the signature; a label only, it never gates anything here. */
    signature?: ModSignatureInfo;
}

export type WebModBlockReason = 'no-client' | 'main-entry' | 'permission' | 'folia-version';

export interface WebModCompat {
    /** Installable and runnable here. */
    iosReady: boolean;
    reason: WebModBlockReason | null;
    /** The permission that blocked it, for the market's label. */
    permission?: string;
    /** The version range that blocked it, for the market's label. */
    folia?: string;
}

/** The only permission a client-only mod may hold here: a layer of the player's stage. */
const ALLOWED_PERMISSIONS = new Set(['ui.stage']);

const parseVersion = (version: string): number[] => version
    .trim()
    .replace(/^[v=]+/, '')
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));

export const compareVersions = (left: string, right: string): number => {
    const a = parseVersion(left);
    const b = parseVersion(right);
    const length = Math.max(a.length, b.length, 3);
    for (let index = 0; index < length; index += 1) {
        const diff = (a[index] ?? 0) - (b[index] ?? 0);
        if (diff !== 0) {
            return diff > 0 ? 1 : -1;
        }
    }
    return 0;
};

const satisfiesComparator = (version: string, comparator: string): boolean => {
    const match = /^(>=|<=|>|<|=|\^|~)?\s*([0-9][0-9.\-+a-zA-Z]*)$/.exec(comparator.trim());
    if (!match) {
        // An unreadable comparator must not silently forbid a mod: the market says "needs Folia x",
        // the user can still install it and see for themselves.
        return true;
    }
    const operator = match[1] ?? '=';
    const target = match[2];
    const order = compareVersions(version, target);
    switch (operator) {
        case '>=':
            return order >= 0;
        case '<=':
            return order <= 0;
        case '>':
            return order > 0;
        case '<':
            return order < 0;
        case '^': {
            if (order < 0) {
                return false;
            }
            const [major] = parseVersion(target);
            return (parseVersion(version)[0] ?? 0) === major;
        }
        case '~': {
            if (order < 0) {
                return false;
            }
            const [major, minor] = parseVersion(target);
            const current = parseVersion(version);
            return (current[0] ?? 0) === major && (current[1] ?? 0) === minor;
        }
        default:
            return order === 0;
    }
};

/** `folia: ">=0.7.21 <0.8.0"` against the host version; a manifest without it asks for nothing. */
export const satisfiesFoliaRange = (range: string | null | undefined, hostVersion: string): boolean => {
    if (!range || !range.trim()) {
        return true;
    }
    return range
        .split(/\s+/)
        .filter(Boolean)
        .every((comparator) => satisfiesComparator(hostVersion, comparator));
};

/** The decision the market labels each catalogue entry with. */
export const webModCompat = (manifest: Pick<WebModManifest, 'client' | 'main' | 'permissions' | 'folia'>, hostVersion: string): WebModCompat => {
    if (!manifest.client) {
        return { iosReady: false, reason: 'no-client' };
    }
    if (manifest.main) {
        return { iosReady: false, reason: 'main-entry' };
    }
    const blocking = (manifest.permissions ?? []).find((permission) => !ALLOWED_PERMISSIONS.has(permission));
    if (blocking) {
        return { iosReady: false, reason: 'permission', permission: blocking };
    }
    if (!satisfiesFoliaRange(manifest.folia, hostVersion)) {
        return { iosReady: false, reason: 'folia-version', folia: manifest.folia };
    }
    return { iosReady: true, reason: null };
};

/** Human-readable reason, for the market's badge and the install toast. */
export const webModBlockText = (compat: WebModCompat): string => {
    switch (compat.reason) {
        case 'no-client':
            return 'iOS 不支持：该模组没有渲染端入口';
        case 'main-entry':
            return 'iOS 不支持：需要 Node 主进程能力';
        case 'permission':
            return `iOS 不支持：需要权限 ${compat.permission ?? ''}`.trim();
        case 'folia-version':
            return `需要 Folia ${compat.folia ?? ''}，当前版本不匹配`.trim();
        default:
            return '';
    }
};

/** The FNV-1a of a mod's tree, so a matching clientUrl means matching bytes. */
export const treeDigest = (mod: Pick<StoredWebMod, 'version' | 'files'>): string => {
    let hash = 0x811c9dc5;
    const names = Object.keys(mod.files).sort();
    for (const name of names) {
        const bytes = mod.files[name];
        const header = `${name}:${bytes.byteLength};`;
        for (let index = 0; index < header.length; index += 1) {
            hash ^= header.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        for (let index = 0; index < bytes.byteLength; index += 1) {
            hash ^= bytes[index];
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
    }
    return hash.toString(16);
};
