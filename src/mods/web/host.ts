// src/mods/web/host.ts
// The mods bridge a Capacitor build fills in itself.
//
// The panel, the loader and every mod-facing call go through window.electron.mods (src/mods/ipc.ts).
// Desktop has a preload script and a main process behind it; an iOS build has neither, which is why
// the mods panel used to say "desktop only". This module implements that same bridge inside the page:
//
//   - mods live in IndexedDB (see idb.ts), unpacked from the official catalogue's zip, so they
//     survive leaving the app and an app update;
//   - each mod's client is bundled into blob: module URLs (see bundler.ts) and handed to the
//     unmodified client loader through `clientUrl`, so mounting, previews and the player are the
//     same code path as on the desktop;
//   - enabling, disabling, uninstalling, and the runtime snapshot the mods read all work here;
//   - what the page cannot offer - a Node main entry, permission-gated host services, ffmpeg,
//     the OS file picker - answers with a clear failure, and such mods are refused at install time
//     instead of half-running (see webModCompat).
//
// It installs only when there is no desktop bridge and the page is inside the native container, so
// Electron behaviour cannot change.

import type {
    ModClearCacheResult,
    ModFfmpegStatus,
    ModLogEntry,
    ModMainCallStats,
    ModRuntimeInfo,
    ModRuntimeSnapshot,
    ModSecretsState,
    ModSetEnabledResult,
    ModStorageUsageResult,
    ModsListPayload,
} from '../types';
import type { CatalogMod } from '../market/catalog';
import { catalogAbsoluteUrl, sha256Hex } from '../market/catalog';
import { previewBytesOf, unpackModZip } from '../market/zip';
import { bundleModClient, fileObjectUrl } from './bundler';
import { kvDelete, kvGet, kvSet, STORE_MODS, idbDelete, idbGetAll, idbPut } from './idb';
import { treeDigest, webModCompat, type StoredWebMod, type WebModBlockReason, type WebModCompat, type WebModManifest } from './manifest';
import { hasDesktopModsBridge, isNativeShell } from './platform';
import { fetchBytes } from './http';

const ENABLED_KEY = 'web-mods:enabled';
const STORAGE_KEY = (modId: string) => `web-mods:storage:${modId}`;
const SECRETS_KEY = (modId: string) => `web-mods:secrets:${modId}`;
const CACHE_KEY = (modId: string) => `web-mods:cache:${modId}`;

const APP_VERSION: string = typeof __APP_VERSION__ === 'undefined' ? '0.0.0' : __APP_VERSION__;

const NO_FFMPEG: ModFfmpegStatus = { available: false, path: null, version: null, candidates: [] };

type Listener<T> = (value: T) => void;

export interface InstallResult {
    ok: boolean;
    id?: string;
    error?: string;
}

export interface WebModsHost {
    /** The object installed at window.electron.mods. */
    readonly bridge: unknown;
    /** The mods as the panel sees them. */
    list(): Promise<ModRuntimeInfo[]>;
    /** Installs a catalogue entry: downloads its zip, checks it and reloads the loader. */
    installFromCatalog(entry: CatalogMod): Promise<InstallResult>;
    /** Installs a zip the user picked in the file input. */
    installFromZip(bytes: Uint8Array, label?: string): Promise<InstallResult>;
    uninstall(modId: string): Promise<InstallResult>;
    /** Whether this mod can run here, and why not when it cannot. */
    compat(manifest: Pick<WebModManifest, 'client' | 'main' | 'permissions' | 'folia'>): WebModCompat;
    /** preview.jpg of an installed mod, as an object URL; null when it ships none. */
    previewUrl(modId: string): Promise<string | null>;
    /** Bytes a mod keeps (its tree plus data), for the panel's usage line. */
    storageUsage(modId: string): Promise<number>;
    isEnabled(modId: string): Promise<boolean>;
    refresh(): Promise<ModRuntimeInfo[]>;
}

let host: WebModsHost | null = null;

const decodeName = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

const toInfo = (
    mod: StoredWebMod,
    options: { enabled: boolean; clientUrl: string | null; error: string | null; block: WebModBlockReason | null },
): ModRuntimeInfo => {
    const { manifest } = mod;
    const blocked = options.block !== null;
    const status: ModRuntimeInfo['status'] = blocked || options.error
        ? 'error'
        : options.enabled && options.clientUrl
            ? 'loaded'
            : 'disabled';
    return {
        id: mod.id,
        name: decodeName(manifest.name) ?? mod.id,
        version: decodeName(manifest.version),
        author: decodeName(manifest.author),
        description: decodeName(manifest.description),
        permissions: Array.isArray(manifest.permissions) ? [...manifest.permissions] : [],
        status,
        error: options.error ?? (blocked ? blockReasonText(options.block!) : null),
        enabled: options.enabled,
        trustStale: false,
        signature: mod.signature ?? { status: 'unsigned', reason: null, keyId: null, keyLabel: null, signedAt: null },
        devSource: false,
        experimental: Array.isArray(manifest.experimental) ? [...manifest.experimental] : [],
        embedOrigins: Array.isArray(manifest.embedOrigins) ? [...manifest.embedOrigins] : [],
        folia: manifest.folia ?? null,
        hasMain: Boolean(manifest.main),
        clientUrl: blocked ? null : options.clientUrl,
    };
};

const blockReasonText = (reason: WebModBlockReason): string => {
    switch (reason) {
        case 'no-client':
            return '这个模组没有渲染端入口，iOS 无法加载';
        case 'main-entry':
            return '这个模组需要 Node 主进程能力，iOS 不支持';
        case 'permission':
            return '这个模组申请的权限在 iOS 端无法提供';
        case 'folia-version':
            return '这个模组要求的 Folia 版本与当前版本不符';
        default:
            return 'iOS 不支持';
    }
};

const createHost = (): WebModsHost => {
    /** modId -> blob URLs created for its current tree; revoked when the mod is disabled or removed. */
    const bundles = new Map<string, { key: string; urls: string[] }>();
    const previews = new Map<string, string>();
    const stateListeners = new Set<Listener<ModRuntimeInfo[]>>();
    const logListeners = new Set<Listener<ModLogEntry>>();
    let lastSnapshot: ModRuntimeInfo[] = [];

    const readMods = async (): Promise<StoredWebMod[]> => {
        try {
            const rows = await idbGetAll<StoredWebMod>(STORE_MODS);
            return rows.filter((row) => row && typeof row.id === 'string' && row.files);
        } catch {
            return [];
        }
    };

    const readEnabled = async (): Promise<string[]> => {
        try {
            const value = await kvGet<string[]>(ENABLED_KEY);
            return Array.isArray(value) ? value : [];
        } catch {
            return [];
        }
    };

    const writeEnabled = async (ids: string[]): Promise<void> => {
        try {
            await kvSet(ENABLED_KEY, ids);
        } catch {
            // Nothing to do: the panel shows the toggle back on the next list.
        }
    };

    /** Bundles the mod once per digest; a changed tree gets fresh URLs and the old ones go. */
    const clientUrlOf = (mod: StoredWebMod): { url: string | null; error: string | null } => {
        const key = `${mod.version}@${treeDigest(mod)}@${mod.manifest.client ?? ''}`;
        const cached = bundles.get(mod.id);
        if (cached && cached.key === key) {
            return { url: cached.urls[cached.urls.length - 1] ?? null, error: null };
        }
        if (cached) {
            for (const url of cached.urls) {
                URL.revokeObjectURL(url);
            }
            bundles.delete(mod.id);
        }
        const entry = mod.manifest.client;
        if (!entry) {
            return { url: null, error: 'client-entry-missing' };
        }
        const urls: string[] = [];
        const bundled = bundleModClient(mod.files, entry, urls);
        if (!bundled.ok) {
            for (const url of urls) {
                URL.revokeObjectURL(url);
            }
            return { url: null, error: bundled.error };
        }
        bundles.set(mod.id, { key, urls });
        return { url: bundled.bundle.url, error: null };
    };

    const buildList = async (): Promise<ModRuntimeInfo[]> => {
        const [mods, enabled] = await Promise.all([readMods(), readEnabled()]);
        const infos: ModRuntimeInfo[] = [];
        for (const mod of mods.sort((left, right) => left.id.localeCompare(right.id))) {
            const compat = webModCompat(mod.manifest, APP_VERSION);
            const isEnabled = enabled.includes(mod.id);
            if (!compat.iosReady) {
                infos.push(toInfo(mod, { enabled: false, clientUrl: null, error: null, block: compat.reason }));
                continue;
            }
            if (!isEnabled) {
                infos.push(toInfo(mod, { enabled: false, clientUrl: null, error: null, block: null }));
                continue;
            }
            const { url, error } = clientUrlOf(mod);
            infos.push(toInfo(mod, { enabled: true, clientUrl: url, error, block: null }));
        }
        return infos;
    };

    const publish = (infos: ModRuntimeInfo[]): ModRuntimeInfo[] => {
        lastSnapshot = infos;
        for (const listener of stateListeners) {
            try {
                listener(infos);
            } catch {
                // A panel that is gone must not stop the host.
            }
        }
        return infos;
    };

    const log = (entry: ModLogEntry): void => {
        for (const listener of logListeners) {
            try {
                listener(entry);
            } catch {
                // As above.
            }
        }
    };

    const refresh = async (): Promise<ModRuntimeInfo[]> => publish(await buildList());

    /**
     * Checks a downloaded zip against the catalogue before it is stored: the manifest has to name
     * the same mod, and the bytes have to hash to the catalogue's sha256 when the platform can hash.
     */
    const checkAgainstCatalog = async (bytes: Uint8Array, entry: CatalogMod): Promise<string | null> => {
        const expected = entry.download?.sha256;
        if (!expected) {
            return null;
        }
        const actual = await sha256Hex(bytes);
        if (actual && actual.toLowerCase() !== expected.toLowerCase()) {
            return `download-damaged:sha256-mismatch`;
        }
        return null;
    };

    const store = async (
        mod: Omit<StoredWebMod, 'installedAt'>,
        options: { enable: boolean; catalog?: CatalogMod },
    ): Promise<InstallResult> => {
        const compat = webModCompat(mod.manifest, APP_VERSION);
        if (!compat.iosReady) {
            return { ok: false, error: `unsupported:${compat.reason ?? 'unknown'}` };
        }
        const previous = (await readMods()).find((row) => row.id === mod.id);
        const stored: StoredWebMod = { ...mod, installedAt: Date.now() };
        if (options.catalog) {
            stored.source = 'market';
            stored.downloadUrl = options.catalog.download?.url ? catalogAbsoluteUrl(options.catalog.download.url) : null;
            stored.catalogOrigin = options.catalog.origin ?? null;
            stored.signature = {
                status: options.catalog.keyId ? 'verified' : 'unsigned',
                reason: null,
                keyId: options.catalog.keyId ?? null,
                keyLabel: options.catalog.keyLabel ?? null,
                signedAt: options.catalog.signedAt ?? null,
            };
        } else {
            stored.source = 'zip';
            stored.signature = { status: 'unsigned', reason: null, keyId: null, keyLabel: null, signedAt: null };
        }
        try {
            await idbPut(STORE_MODS, stored);
        } catch (error) {
            return { ok: false, error: `store-failed:${(error as Error)?.message ?? 'unknown'}` };
        }
        // The old tree's blobs are dead weight once the row is replaced.
        const cached = bundles.get(mod.id);
        if (cached) {
            for (const url of cached.urls) {
                URL.revokeObjectURL(url);
            }
            bundles.delete(mod.id);
        }
        if (previous && previous.version !== mod.version) {
            // A mod's data outlives its version; its cached preview does not.
            const preview = previews.get(mod.id);
            if (preview) {
                URL.revokeObjectURL(preview);
                previews.delete(mod.id);
            }
        }
        if (options.enable) {
            const enabled = await readEnabled();
            if (!enabled.includes(mod.id)) {
                await writeEnabled([...enabled, mod.id]);
            }
        }
        await refresh();
        return { ok: true, id: mod.id };
    };

    const installFromCatalog = async (entry: CatalogMod): Promise<InstallResult> => {
        const url = entry.download?.url ? catalogAbsoluteUrl(entry.download.url) : '';
        if (!url) {
            return { ok: false, error: 'catalog-entry-has-no-download' };
        }
        let bytes: Uint8Array;
        try {
            // /downloads has no Access-Control-Allow-Origin, so this has to leave the WebView (http.ts).
            const response = await fetchBytes(url);
            if (!response.ok) {
                return { ok: false, error: `download-http-${response.status}` };
            }
            bytes = response.bytes;
        } catch (error) {
            return { ok: false, error: `download-failed:${(error as Error)?.message ?? 'network'}` };
        }
        const damage = await checkAgainstCatalog(bytes, entry);
        if (damage) {
            return { ok: false, error: damage };
        }
        const unpacked = unpackModZip(bytes);
        if (!unpacked.ok) {
            return { ok: false, error: unpacked.error };
        }
        if (unpacked.mod.manifest.id !== entry.id) {
            return { ok: false, error: 'manifest-id-mismatch' };
        }
        return store(
            {
                id: unpacked.mod.manifest.id,
                version: unpacked.mod.manifest.version,
                manifest: unpacked.mod.manifest,
                files: unpacked.mod.files,
                source: 'market',
            },
            { enable: true, catalog: entry },
        );
    };

    const installFromZip = async (bytes: Uint8Array, label?: string): Promise<InstallResult> => {
        const unpacked = unpackModZip(bytes);
        if (!unpacked.ok) {
            log({ modId: label ?? 'zip', level: 'error', message: `解压失败：${unpacked.error}` });
            return { ok: false, error: unpacked.error };
        }
        return store(
            {
                id: unpacked.mod.manifest.id,
                version: unpacked.mod.manifest.version,
                manifest: unpacked.mod.manifest,
                files: unpacked.mod.files,
                source: 'zip',
            },
            { enable: true },
        );
    };

    const uninstall = async (modId: string): Promise<InstallResult> => {
        try {
            await idbDelete(STORE_MODS, modId);
        } catch (error) {
            return { ok: false, error: `delete-failed:${(error as Error)?.message ?? 'unknown'}` };
        }
        const cached = bundles.get(modId);
        if (cached) {
            for (const url of cached.urls) {
                URL.revokeObjectURL(url);
            }
            bundles.delete(modId);
        }
        const preview = previews.get(modId);
        if (preview) {
            URL.revokeObjectURL(preview);
            previews.delete(modId);
        }
        const enabled = await readEnabled();
        if (enabled.includes(modId)) {
            await writeEnabled(enabled.filter((id) => id !== modId));
        }
        await kvDelete(STORAGE_KEY(modId));
        await kvDelete(SECRETS_KEY(modId));
        await kvDelete(CACHE_KEY(modId));
        await refresh();
        return { ok: true, id: modId };
    };

    const setEnabled = async (modId: string, enabled: boolean): Promise<ModSetEnabledResult> => {
        const mods = await readMods();
        const mod = mods.find((row) => row.id === modId);
        if (!mod) {
            return { ok: false, error: 'mod-not-found', mods: lastSnapshot };
        }
        if (enabled) {
            const compat = webModCompat(mod.manifest, APP_VERSION);
            if (!compat.iosReady) {
                return { ok: false, error: `unsupported:${compat.reason ?? 'unknown'}`, mods: lastSnapshot };
            }
        }
        const current = await readEnabled();
        const next = enabled
            ? Array.from(new Set([...current, modId]))
            : current.filter((id) => id !== modId);
        await writeEnabled(next);
        const infos = await refresh();
        return { ok: true, mods: infos };
    };

    const previewUrl = async (modId: string): Promise<string | null> => {
        const cached = previews.get(modId);
        if (cached) {
            return cached;
        }
        const mod = (await readMods()).find((row) => row.id === modId);
        if (!mod) {
            return null;
        }
        const bytes = previewBytesOf(mod.files);
        if (!bytes) {
            return null;
        }
        const url = fileObjectUrl(bytes, 'image/jpeg');
        previews.set(modId, url);
        return url;
    };

    const storageUsage = async (modId: string): Promise<number> => {
        const mod = (await readMods()).find((row) => row.id === modId);
        let total = 0;
        if (mod) {
            for (const bytes of Object.values(mod.files)) {
                total += bytes.byteLength;
            }
        }
        try {
            const data = await kvGet<Record<string, unknown>>(STORAGE_KEY(modId));
            if (data) {
                total += JSON.stringify(data).length;
            }
        } catch {
            // Usage is a hint, not a guarantee.
        }
        return total;
    };

    const readStore = async <T>(key: string): Promise<T | undefined> => {
        try {
            return await kvGet<T>(key);
        } catch {
            return undefined;
        }
    };

    const writeStore = async <T>(key: string, value: T): Promise<void> => {
        try {
            await kvSet(key, value);
        } catch {
            // A mod writing to a full disk is not worth a crash.
        }
    };

    /** folium.storage over the kv store: one JSON object per mod, keyed by the mod's own keys. */
    const storage = async (
        modId: string,
        operation: 'get' | 'set' | 'has' | 'delete' | 'keys',
        key?: string,
        value?: unknown,
    ): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
        const data = (await readStore<Record<string, unknown>>(STORAGE_KEY(modId))) ?? {};
        switch (operation) {
            case 'get':
                return { ok: true, result: typeof key === 'string' ? data[key] ?? null : null };
            case 'has':
                return { ok: true, result: typeof key === 'string' && Object.prototype.hasOwnProperty.call(data, key) };
            case 'keys':
                return { ok: true, result: Object.keys(data) };
            case 'set': {
                if (typeof key !== 'string') {
                    return { ok: false, error: 'storage-key-required' };
                }
                data[key] = value ?? null;
                await writeStore(STORAGE_KEY(modId), data);
                return { ok: true };
            }
            case 'delete': {
                if (typeof key === 'string') {
                    delete data[key];
                    await writeStore(STORAGE_KEY(modId), data);
                }
                return { ok: true };
            }
            default:
                return { ok: false, error: 'storage-operation-unknown' };
        }
    };

    /**
     * folium.secrets: there is no keychain-backed store behind a page, so values are kept with the
     * mod's data and `persistent` is false - the settings form says so itself instead of pretending
     * they are encrypted.
     */
    const secrets = async (
        modId: string,
        operation: 'get' | 'has' | 'set' | 'declare' | 'state',
        key?: string | readonly string[],
        value?: string | null,
    ): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
        const data = (await readStore<Record<string, string>>(SECRETS_KEY(modId))) ?? {};
        switch (operation) {
            case 'get':
                return { ok: true, result: typeof key === 'string' ? data[key] ?? null : null };
            case 'has':
                return { ok: true, result: typeof key === 'string' && Object.prototype.hasOwnProperty.call(data, key) };
            case 'set': {
                if (typeof key !== 'string') {
                    return { ok: false, error: 'secret-key-required' };
                }
                if (value === null || value === undefined || value === '') {
                    delete data[key];
                } else {
                    data[key] = String(value);
                }
                await writeStore(SECRETS_KEY(modId), data);
                return { ok: true };
            }
            case 'state': {
                const state: ModSecretsState = { persistent: false, stored: Object.keys(data) };
                return { ok: true, result: state };
            }
            case 'declare':
                return { ok: true };
            default:
                return { ok: false, error: 'secret-operation-unknown' };
        }
    };

    const bridge = {
        listMods: async (): Promise<ModsListPayload> => ({
            mods: await refresh(),
            ffmpeg: NO_FFMPEG,
            directories: [],
            startSkipped: false,
        }),
        getModCallStats: async (): Promise<{ stats: Record<string, ModMainCallStats> }> => ({ stats: {} }),
        reportModsStartSettled: async (): Promise<void> => {},
        reportModsStartAlive: async (): Promise<void> => {},
        setModEnabled: setEnabled,
        reloadMods: async (): Promise<ModRuntimeInfo[]> => refresh(),
        cancelExport: async (): Promise<void> => {},
        invokeModRpc: async (): Promise<{ ok: boolean; error?: string }> => ({
            ok: false,
            error: 'no-main-process',
        }),
        invokeModStorage: storage,
        invokeModSecrets: secrets,
        invokeModNetFetch: async (): Promise<{ ok: boolean; error?: string }> => ({
            ok: false,
            error: 'no-main-process',
        }),
        invokeModPickFile: async (): Promise<{ ok: boolean; result?: unknown; error?: string }> => ({
            ok: false,
            error: 'no-native-file-picker',
        }),
        invokeModRestoreFile: async (): Promise<{ ok: boolean; result?: unknown; error?: string }> => ({
            ok: false,
            error: 'no-native-file-picker',
        }),
        invokeModReleaseFile: async (): Promise<{ ok: boolean; result?: unknown; error?: string }> => ({
            ok: false,
            error: 'no-native-file-picker',
        }),
        pushRuntimeSnapshot: async (snapshot: ModRuntimeSnapshot): Promise<void> => {
            // The page is the only host here: the mods read playback through the renderer's own
            // registries, so the snapshot only has to be accepted, not forwarded.
            void snapshot;
        },
        getFfmpegStatus: async (): Promise<{ ffmpeg: ModFfmpegStatus }> => ({ ffmpeg: NO_FFMPEG }),
        openModsDirectory: async (): Promise<{ ok: boolean; error?: string }> => ({
            ok: false,
            error: 'no-file-manager',
        }),
        installModFromZip: async (): Promise<{ ok: boolean; error?: string }> => ({
            ok: false,
            error: 'use-market',
        }),
        getModStorageUsage: async (modId: string): Promise<ModStorageUsageResult> => ({
            ok: true,
            data: await storageUsage(modId),
            cache: 0,
        }),
        clearModCache: async (modId: string): Promise<ModClearCacheResult> => {
            await kvDelete(CACHE_KEY(modId));
            return { ok: true, cleared: 0 };
        },
        onModsStateChanged: (callback: Listener<ModRuntimeInfo[]>): (() => void) => {
            stateListeners.add(callback);
            return () => stateListeners.delete(callback);
        },
        onExportProgress: (): (() => void) => () => {},
        onModLog: (callback: Listener<ModLogEntry>): (() => void) => {
            logListeners.add(callback);
            return () => logListeners.delete(callback);
        },
        onModRpcMessage: (): (() => void) => () => {},
        onModSecretChanged: (): (() => void) => () => {},
    };

    return {
        bridge,
        list: () => refresh(),
        installFromCatalog,
        installFromZip,
        uninstall,
        compat: (manifest) => webModCompat(manifest, APP_VERSION),
        previewUrl,
        storageUsage,
        isEnabled: async (modId) => (await readEnabled()).includes(modId),
        refresh,
    };
};

/**
 * Installs the bridge at window.electron.mods, and turns the mod system on by default: on iOS this
 * host is the only mod system there is, so asking the user to switch on a feature they cannot reach
 * on the desktop would only hide the market.
 */
export const installWebModsHost = (): WebModsHost | null => {
    if (!isNativeShell() || hasDesktopModsBridge()) {
        return null;
    }
    if (host) {
        return host;
    }
    const created = createHost();
    const electron = ((window as { electron?: Record<string, unknown> }).electron ??= {});
    electron.mods = created.bridge;
    host = created;
    try {
        if (localStorage.getItem('mod_system_enabled') === null) {
            localStorage.setItem('mod_system_enabled', 'true');
        }
    } catch {
        // Storage disabled: the panel's own default applies.
    }
    return created;
};

/** The host when it was installed this run; null on the desktop and in a plain browser. */
export const webModsHost = (): WebModsHost | null => host;
