// src/mods/web/bundler.ts
// Turns a mod's tree into one module URL the client loader can import().
//
// On the desktop the main process serves a mod as folia-mod://<id>/<digest>/client.mjs, so the
// client's own `./stage.mjs` imports resolve against a real origin. A page that only has the
// bytes has no origin to hang those on, and blob: URLs cannot be imported relatively: a module
// imported from blob: resolves `./stage.mjs` against its own blob, which has no path. So the
// tree is rebuilt here: every file becomes a blob module, deepest dependency first, and each
// import specifier is rewritten to the blob URL of the file it named.
//
// The rewrite touches relative specifiers only (`./x.mjs`, `../dir/y.mjs`). Bare specifiers
// stay as written, which is exactly what a mod must not use anyway - client.mjs comments say
// so ("mod clients cannot resolve bare imports"), and 52Hz vendors pixi inside the mod for it.

const RELATIVE_SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])((?:\.\.?\/)[^'"\n]*)\2/g;

const MODULE_EXTENSIONS = ['', '.mjs', '.js', '/index.mjs', '/index.js'];

const normalizePath = (path: string): string => {
    const out: string[] = [];
    for (const part of path.split('/')) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            out.pop();
            continue;
        }
        out.push(part);
    }
    return out.join('/');
};

const dirname = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);

export interface BundledModClient {
    /** blob: URL of the entry module. */
    url: string;
    /** How many files make it up. */
    moduleCount: number;
}

export interface BundleFailure {
    ok: false;
    error: string;
}

export type BundleResult = { ok: true; bundle: BundledModClient } | BundleFailure;

/**
 * Bundles `entryPath` (relative to the mod folder) out of `files`, creating a blob URL per
 * module. Every URL created is also returned through `created` so the caller can revoke them
 * when the mod is disabled or uninstalled.
 */
export const bundleModClient = (
    files: Record<string, Uint8Array>,
    entryPath: string,
    created: string[] = [],
): BundleResult => {
    if (!files[entryPath]) {
        return { ok: false, error: 'client-entry-missing' };
    }

    const sources = new Map<string, string>();
    const sourcesOf = (path: string): string | null => {
        const cached = sources.get(path);
        if (cached !== undefined) {
            return cached;
        }
        const bytes = files[path];
        if (!bytes) {
            return null;
        }
        const text = decode(bytes);
        sources.set(path, text);
        return text;
    };

    // specifier -> resolved path, per file.
    const edges = new Map<string, Map<string, string>>();
    const collectEdges = (path: string): Map<string, string> => {
        const known = edges.get(path);
        if (known) {
            return known;
        }
        const map = new Map<string, string>();
        edges.set(path, map);
        const source = sourcesOf(path);
        if (source === null) {
            return map;
        }
        RELATIVE_SPEC.lastIndex = 0;
        let match: RegExpExecArray | null = RELATIVE_SPEC.exec(source);
        while (match) {
            const specifier = match[3];
            const target = normalizePath(`${dirname(path)}/${specifier}`);
            const resolved = MODULE_EXTENSIONS
                .map((extension) => `${target}${extension}`)
                .find((candidate) => candidate !== '' && files[candidate] !== undefined);
            if (resolved) {
                map.set(specifier, resolved);
            }
            match = RELATIVE_SPEC.exec(source);
        }
        return map;
    };

    // Depth-first, dependencies first. A ring would need two blobs to know each other's URL
    // before either exists, so it is refused rather than half-bundled: no catalogue mod has one.
    const order: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (path: string): string | null => {
        const mark = state.get(path);
        if (mark === 'done') {
            return null;
        }
        if (mark === 'visiting') {
            return `circular-import:${path}`;
        }
        state.set(path, 'visiting');
        for (const target of collectEdges(path).values()) {
            const failure = visit(target);
            if (failure) {
                return failure;
            }
        }
        state.set(path, 'done');
        order.push(path);
        return null;
    };
    const ring = visit(entryPath);
    if (ring) {
        return { ok: false, error: ring };
    }

    const urls = new Map<string, string>();
    for (const path of order) {
        const source = sourcesOf(path) ?? '';
        const map = collectEdges(path);
        const rewritten = source.replace(RELATIVE_SPEC, (whole, prefix: string, quote: string, specifier: string) => {
            const target = map.get(specifier);
            const url = target ? urls.get(target) : undefined;
            return url ? `${prefix}${quote}${url}${quote}` : whole;
        });
        const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }));
        urls.set(path, url);
        created.push(url);
    }

    const entryUrl = urls.get(entryPath);
    if (!entryUrl) {
        return { ok: false, error: 'client-entry-missing' };
    }
    return { ok: true, bundle: { url: entryUrl, moduleCount: order.length } };
};

/** A still image out of the tree as an object URL (the market and the list show `preview.jpg`). */
export const fileObjectUrl = (bytes: Uint8Array, type: string): string =>
    URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type }));
