// src/mods/market/catalog.ts
// The official Folium mod catalogue, as the built-in market reads it.
//
// The catalogue is the same document the desktop build opens in a browser
// (https://folium-compound.cielaniska.top/catalog.json): one entry per mod with its manifest
// summary, its download zip and a preview image. Here it is fetched by the page itself, cached
// for a day so the market opens instantly and works on a bad connection, and the zips are
// pulled from the same origin.

export interface CatalogDownload {
    url: string;
    fileName?: string;
    size?: number;
    sha256?: string;
}

export interface CatalogPreview {
    url: string;
    width?: number;
    height?: number;
}

export interface CatalogMod {
    id: string;
    name: string;
    version: string;
    author?: string | null;
    description?: string | null;
    origin?: string;
    channel?: string;
    path?: string;
    digest?: string;
    keyId?: string | null;
    keyLabel?: string | null;
    signedAt?: string | null;
    permissions?: string[];
    experimental?: string[];
    embedOrigins?: string[];
    depends?: string[];
    folia?: string | null;
    hasMain?: boolean;
    hasClient?: boolean;
    download?: CatalogDownload | null;
    preview?: CatalogPreview | null;
}

export interface Catalog {
    format?: number;
    version?: string;
    repository?: string;
    commit?: string;
    mods: CatalogMod[];
}

export const CATALOG_ORIGIN = 'https://folium-compound.cielaniska.top';
export const CATALOG_URL = `${CATALOG_ORIGIN}/catalog.json`;

const CACHE_KEY = 'web-mods:catalog';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** A catalogue path ('/downloads/x.zip') against the origin the document came from. */
export const catalogAbsoluteUrl = (path: string): string => {
    try {
        return new URL(path, CATALOG_ORIGIN).toString();
    } catch {
        return path;
    }
};

export interface CachedCatalog {
    fetchedAt: number;
    catalog: Catalog;
}

const readCache = async (): Promise<CachedCatalog | null> => {
    const { kvGet } = await import('../web/idb');
    try {
        const cached = await kvGet<CachedCatalog>(CACHE_KEY);
        return cached && Array.isArray(cached.catalog?.mods) ? cached : null;
    } catch {
        return null;
    }
};

const writeCache = async (catalog: Catalog): Promise<void> => {
    const { kvSet } = await import('../web/idb');
    try {
        await kvSet<CachedCatalog>(CACHE_KEY, { fetchedAt: Date.now(), catalog });
    } catch {
        // The market still works from the response in hand; only the next open is slower.
    }
};

/**
 * The catalogue: from cache when it is fresh, from the network otherwise. `force` refetches.
 * On a network failure the stale cache is better than an empty market, so it is returned when
 * there is one, with `stale` set.
 */
export const loadCatalog = async (options: { force?: boolean } = {}): Promise<{ catalog: Catalog; stale: boolean }> => {
    const cached = await readCache();
    const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
    if (cached && fresh && !options.force) {
        return { catalog: cached.catalog, stale: false };
    }
    try {
        const response = await fetch(`${CATALOG_URL}?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`catalog-http-${response.status}`);
        }
        const catalog = await response.json() as Catalog;
        if (!Array.isArray(catalog?.mods)) {
            throw new Error('catalog-malformed');
        }
        await writeCache(catalog);
        return { catalog, stale: false };
    } catch (error) {
        if (cached) {
            return { catalog: cached.catalog, stale: true };
        }
        throw error;
    }
};

/** FNV-1a over the bytes, in the shape the catalogue's sha256 is not: a cheap integrity check. */
export const digestHex = (bytes: Uint8Array): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < bytes.byteLength; index += 1) {
        hash ^= bytes[index];
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16);
};

/** The catalogue's download.sha256, when the platform lets a page hash bytes at all. */
export const sha256Hex = async (bytes: Uint8Array): Promise<string | null> => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        return null;
    }
    try {
        const buffer = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
        return Array.from(new Uint8Array(buffer))
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
    } catch {
        return null;
    }
};
