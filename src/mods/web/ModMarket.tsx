// src/mods/web/ModMarket.tsx
// The mod market a Capacitor build shows in place of the desktop-only notice.
//
// The desktop manager lists what the main process has installed and opens the official catalogue
// in a browser. Inside an app there is no browser to hand it to, so the catalogue is the panel: it
// lists every official entry, says which ones this build can run (client-only mods; anything that
// needs the Node main process is marked unsupported and cannot be installed), installs the zip into
// IndexedDB, and toggles the installed ones on and off. Toggling goes through the shared mods store,
// which re-runs the client reconciliation, so a mod shows up in the player the moment it is enabled.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, ExternalLink, Loader2, RefreshCw, Search, Smartphone, Store, Trash2, TriangleAlert, Upload } from 'lucide-react';
import type { ModRuntimeInfo } from '../types';
import { useModsStore } from '../useModsStore';
import { catalogAbsoluteUrl, CATALOG_ORIGIN, loadCatalog, type CatalogMod } from '../market/catalog';
import { webModCompat, type WebModCompat } from './manifest';
import { webModsHost } from './host';
import type { ModManagerClasses } from '../manager/modManagerClasses';

const APP_VERSION: string = typeof __APP_VERSION__ === 'undefined' ? '0.0.0' : __APP_VERSION__;

/** The mods this build was checked against; they are listed first, with a badge. */
const FEATURED = [
    'stardrift',
    'miside-drop',
    'wave-light',
    'cinerama',
    'lyric-split-translation',
    'visualizer52hz',
];

type Origin = 'all' | 'official' | 'community';

type MarketProps = {
    classes: ModManagerClasses;
    isDaylight: boolean;
    themeAccent?: string | null;
};

const compatOf = (entry: CatalogMod): WebModCompat => webModCompat({
    // The catalogue says what the zip holds; the manifest inside is checked again at install.
    client: entry.hasClient === false ? undefined : (entry.path ? `${entry.path}/client.mjs` : 'client.mjs'),
    main: entry.hasMain ? 'main.mjs' : undefined,
    permissions: entry.permissions ?? [],
    folia: entry.folia ?? undefined,
}, APP_VERSION);

const compatLabel = (compat: WebModCompat): string => {
    if (compat.iosReady) {
        return 'iOS 可用';
    }
    switch (compat.reason) {
        case 'main-entry':
            return 'iOS 不支持 · 需要主进程';
        case 'permission':
            return `iOS 不支持 · 权限 ${compat.permission ?? ''}`.trim();
        case 'no-client':
            return 'iOS 不支持 · 无渲染端';
        case 'folia-version':
            return `iOS 不支持 · 版本 ${compat.folia ?? ''}`.trim();
        default:
            return 'iOS 不支持';
    }
};

const formatSize = (bytes?: number): string => {
    if (!bytes || bytes <= 0) {
        return '';
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(0)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export const ModMarket: React.FC<MarketProps> = ({ classes, isDaylight, themeAccent }) => {
    const host = webModsHost();
    const mods = useModsStore((state) => state.mods);
    const refreshMods = useModsStore((state) => state.refresh);
    const toggleMod = useModsStore((state) => state.toggleMod);

    const [entries, setEntries] = useState<CatalogMod[]>([]);
    const [loading, setLoading] = useState(true);
    const [stale, setStale] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [origin, setOrigin] = useState<Origin>('all');
    const [onlyCompatible, setOnlyCompatible] = useState(true);
    const [tab, setTab] = useState<'market' | 'installed'>('market');
    const [busy, setBusy] = useState<Record<string, string>>({});
    const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
    const zipInputRef = useRef<HTMLInputElement | null>(null);

    const load = useCallback(async (force = false) => {
        setLoading(true);
        setLoadError(null);
        try {
            const { catalog, stale: isStale } = await loadCatalog({ force });
            setEntries(catalog.mods);
            setStale(isStale);
        } catch (error) {
            setLoadError((error as Error)?.message ?? 'catalog-failed');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load(false);
        if (host) {
            void refreshMods();
        }
    }, [host, load, refreshMods]);

    const installedIds = useMemo(() => new Set(mods.map((mod) => mod.id)), [mods]);
    const enabledIds = useMemo(
        () => new Set(mods.filter((mod) => mod.enabled).map((mod) => mod.id)),
        [mods],
    );

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const filtered = entries.filter((entry) => {
            if (origin !== 'all' && (entry.origin ?? 'community') !== origin) {
                return false;
            }
            const compat = compatOf(entry);
            if (onlyCompatible && !compat.iosReady) {
                return false;
            }
            if (!needle) {
                return true;
            }
            const haystack = `${entry.id} ${entry.name ?? ''} ${entry.author ?? ''} ${entry.description ?? ''}`.toLowerCase();
            return haystack.includes(needle);
        });
        return filtered.sort((left, right) => {
            const leftFeatured = FEATURED.indexOf(left.id);
            const rightFeatured = FEATURED.indexOf(right.id);
            if (leftFeatured !== rightFeatured) {
                if (leftFeatured === -1) {
                    return 1;
                }
                if (rightFeatured === -1) {
                    return -1;
                }
                return leftFeatured - rightFeatured;
            }
            return (left.name ?? left.id).localeCompare(right.name ?? right.id);
        });
    }, [entries, onlyCompatible, origin, query]);

    const setBusyFor = (id: string, state: string | null) => {
        setBusy((current) => {
            const next = { ...current };
            if (state) {
                next[id] = state;
            } else {
                delete next[id];
            }
            return next;
        });
    };

    const handleInstall = async (entry: CatalogMod) => {
        if (!host) {
            return;
        }
        setBusyFor(entry.id, 'installing');
        setNotice(null);
        try {
            const result = await host.installFromCatalog(entry);
            if (result.ok) {
                await refreshMods();
                setNotice({ kind: 'ok', text: `已安装 ${entry.name ?? entry.id}` });
            } else {
                setNotice({ kind: 'error', text: `安装失败：${result.error ?? 'unknown'}` });
            }
        } finally {
            setBusyFor(entry.id, null);
        }
    };

    const handleZip = async (file: File) => {
        if (!host) {
            return;
        }
        setBusyFor('__zip', 'installing');
        setNotice(null);
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const result = await host.installFromZip(bytes, file.name);
            if (result.ok) {
                await refreshMods();
                setNotice({ kind: 'ok', text: `已安装 ${result.id ?? file.name}` });
            } else {
                setNotice({ kind: 'error', text: `安装失败：${result.error ?? 'unknown'}` });
            }
        } finally {
            setBusyFor('__zip', null);
            if (zipInputRef.current) {
                zipInputRef.current.value = '';
            }
        }
    };

    const handleToggle = async (mod: ModRuntimeInfo, enabled: boolean) => {
        setBusyFor(mod.id, enabled ? 'enabling' : 'disabling');
        setNotice(null);
        try {
            const result = await toggleMod(mod.id, enabled);
            if (!result.ok) {
                setNotice({ kind: 'error', text: `操作失败：${result.error ?? 'unknown'}` });
            }
        } finally {
            setBusyFor(mod.id, null);
        }
    };

    const handleUninstall = async (modId: string) => {
        if (!host) {
            return;
        }
        setBusyFor(modId, 'removing');
        setNotice(null);
        try {
            const result = await host.uninstall(modId);
            if (result.ok) {
                await refreshMods();
                setNotice({ kind: 'ok', text: `已卸载 ${modId}` });
            } else {
                setNotice({ kind: 'error', text: `卸载失败：${result.error ?? 'unknown'}` });
            }
        } finally {
            setBusyFor(modId, null);
        }
    };

    const accent = themeAccent ?? (isDaylight ? '#52525b' : 'rgba(255,255,255,0.45)');
    const chipClass = `rounded-full px-2 py-0.5 text-[10px] font-medium ${classes.chip}`;
    const actionClass = `inline-flex items-center justify-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${classes.ghostButton}`;

    if (!host) {
        return (
            <div className={`rounded-xl border px-4 py-8 text-center text-sm ${classes.card}`} style={{ color: 'var(--text-secondary)' }}>
                模组市场尚未就绪，请重启应用后重试。
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className={`inline-flex rounded-full border p-0.5 ${classes.ghostButton}`}>
                    <button
                        type="button"
                        onClick={() => setTab('market')}
                        className={`rounded-full px-3 py-1 text-xs font-medium ${tab === 'market' ? classes.activeButton : ''}`}
                        style={{ color: 'var(--text-primary)' }}
                    >
                        市场
                    </button>
                    <button
                        type="button"
                        onClick={() => setTab('installed')}
                        className={`rounded-full px-3 py-1 text-xs font-medium ${tab === 'installed' ? classes.activeButton : ''}`}
                        style={{ color: 'var(--text-primary)' }}
                    >
                        已安装 {mods.length > 0 ? `(${mods.length})` : ''}
                    </button>
                </div>
                <span className="ml-auto inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    <Smartphone size={11} />
                    iOS 运行时 · Folia v{APP_VERSION}
                </span>
            </div>

            {notice ? (
                <div className={`rounded-lg border px-3 py-2 text-xs ${notice.kind === 'ok' ? classes.success : classes.danger}`}>
                    {notice.text}
                </div>
            ) : null}

            {tab === 'market' ? (
                <>
                    <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${classes.card}`}>
                        <Search size={13} style={{ color: 'var(--text-secondary)' }} />
                        <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="搜索模组名 / 作者 / 关键词"
                            className="w-full bg-transparent text-xs outline-none"
                            style={{ color: 'var(--text-primary)' }}
                        />
                        {query ? (
                            <button type="button" onClick={() => setQuery('')} className="text-[11px] opacity-60" style={{ color: 'var(--text-secondary)' }}>
                                清除
                            </button>
                        ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                        {([
                            ['all', '全部'],
                            ['official', '官方'],
                            ['community', '社区'],
                        ] as const).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setOrigin(value)}
                                className={`${actionClass} ${origin === value ? classes.activeButton : ''}`}
                                style={{ color: 'var(--text-primary)' }}
                            >
                                {label}
                            </button>
                        ))}
                        <button
                            type="button"
                            onClick={() => setOnlyCompatible((current) => !current)}
                            className={`${actionClass} ${onlyCompatible ? classes.activeButton : ''}`}
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {onlyCompatible ? <Check size={12} /> : null}
                            只看 iOS 可用
                        </button>
                        <button
                            type="button"
                            onClick={() => { void load(true); }}
                            disabled={loading}
                            className={actionClass}
                            style={{ color: 'var(--text-primary)' }}
                        >
                            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
                            刷新
                        </button>
                        <button
                            type="button"
                            onClick={() => zipInputRef.current?.click()}
                            disabled={busy.__zip === 'installing'}
                            className={actionClass}
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {busy.__zip === 'installing' ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                            本地 zip
                        </button>
                        <input
                            ref={zipInputRef}
                            type="file"
                            accept=".zip,application/zip"
                            className="hidden"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) {
                                    void handleZip(file);
                                }
                            }}
                        />
                        <a
                            href={`${CATALOG_ORIGIN}/`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={actionClass}
                            style={{ color: 'var(--text-primary)' }}
                        >
                            <Store size={12} />
                            官网
                            <ExternalLink size={11} className="opacity-50" />
                        </a>
                    </div>

                    {stale ? (
                        <div className={`rounded-lg border px-3 py-2 text-[11px] ${classes.warning}`}>
                            目录来自本地缓存，网络不可用时可能不是最新。
                        </div>
                    ) : null}

                    {loadError ? (
                        <div className={`rounded-lg border px-3 py-2 text-xs ${classes.danger}`}>
                            <div className="flex items-center gap-1.5">
                                <TriangleAlert size={13} />
                                目录加载失败：{loadError}
                            </div>
                            <button type="button" onClick={() => { void load(true); }} className="mt-2 underline">
                                重试
                            </button>
                        </div>
                    ) : null}

                    {loading && entries.length === 0 ? (
                        <div className="flex items-center justify-center gap-2 py-10 text-xs" style={{ color: 'var(--text-secondary)' }}>
                            <Loader2 size={14} className="animate-spin" />
                            正在读取官方目录…
                        </div>
                    ) : null}

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {visible.map((entry) => {
                            const compat = compatOf(entry);
                            const isInstalled = installedIds.has(entry.id);
                            const isBusy = busy[entry.id] !== undefined;
                            const featured = FEATURED.includes(entry.id);
                            const preview = entry.preview?.url ? catalogAbsoluteUrl(entry.preview.url) : null;
                            return (
                                <div key={entry.id} className={`flex gap-2 rounded-xl border p-2 ${classes.card}`}>
                                    <div
                                        className="h-16 w-24 shrink-0 overflow-hidden rounded-lg"
                                        style={{ backgroundColor: isDaylight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.06)' }}
                                    >
                                        {preview ? (
                                            <img src={preview} alt={entry.name ?? entry.id} loading="lazy" className="h-full w-full object-cover" />
                                        ) : null}
                                    </div>
                                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                                        <div className="flex items-start gap-1.5">
                                            <span className="truncate text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                                                {entry.name ?? entry.id}
                                            </span>
                                            {featured ? <span className={chipClass}>推荐</span> : null}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-1 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                                            <span className={chipClass}>{entry.origin === 'official' ? '官方' : '社区'}</span>
                                            {entry.author ? <span>{entry.author}</span> : null}
                                            <span>v{entry.version}</span>
                                            {entry.download?.size ? <span>{formatSize(entry.download.size)}</span> : null}
                                        </div>
                                        <div className="line-clamp-2 text-[11px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                                            {entry.description ?? ''}
                                        </div>
                                        <div className="mt-auto flex items-center gap-1.5">
                                            <span
                                                className={`rounded-full px-1.5 py-0.5 text-[10px] ${compat.iosReady ? classes.success : classes.danger}`}
                                            >
                                                {compatLabel(compat)}
                                            </span>
                                            {isInstalled ? (
                                                <span className="text-[10px] opacity-70" style={{ color: 'var(--text-secondary)' }}>
                                                    {enabledIds.has(entry.id) ? '运行中' : '已安装'}
                                                </span>
                                            ) : null}
                                            <button
                                                type="button"
                                                disabled={!compat.iosReady || isInstalled || isBusy}
                                                onClick={() => { void handleInstall(entry); }}
                                                className={`ml-auto ${actionClass}`}
                                                style={{ color: 'var(--text-primary)', borderColor: compat.iosReady ? accent : undefined }}
                                            >
                                                {isBusy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                                                {isBusy ? '安装中' : isInstalled ? '已安装' : '安装'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {!loading && visible.length === 0 && !loadError ? (
                        <div className="py-8 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>
                            没有符合条件的模组
                        </div>
                    ) : null}
                </>
            ) : (
                <div className="flex flex-col gap-2">
                    {mods.length === 0 ? (
                        <div className="py-8 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>
                            还没有安装任何模组，去「市场」挑几个。
                        </div>
                    ) : null}
                    {mods.map((mod) => {
                        const isBusy = busy[mod.id] !== undefined;
                        return (
                            <div key={mod.id} className={`flex flex-col gap-1.5 rounded-xl border p-3 ${classes.card}`}>
                                <div className="flex items-center gap-2">
                                    <span className="truncate text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                                        {mod.name}
                                    </span>
                                    <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                                        v{mod.version ?? '—'}
                                    </span>
                                    {mod.error ? (
                                        <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${classes.danger}`}>{mod.error}</span>
                                    ) : null}
                                    <div className="ml-auto flex items-center gap-1.5">
                                        <button
                                            type="button"
                                            disabled={isBusy || (Boolean(mod.error) && !mod.enabled)}
                                            onClick={() => { void handleToggle(mod, !mod.enabled); }}
                                            className={`${actionClass} ${mod.enabled ? classes.activeButton : ''}`}
                                            style={{ color: 'var(--text-primary)' }}
                                        >
                                            {isBusy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                                            {mod.enabled ? '已启用' : '启用'}
                                        </button>
                                        <button
                                            type="button"
                                            disabled={isBusy}
                                            onClick={() => { void handleUninstall(mod.id); }}
                                            className={`${actionClass} ${classes.danger}`}
                                        >
                                            {busy[mod.id] === 'removing' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                                            卸载
                                        </button>
                                    </div>
                                </div>
                                {mod.description ? (
                                    <div className="text-[11px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                                        {mod.description}
                                    </div>
                                ) : null}
                                <div className="flex flex-wrap items-center gap-1 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                                    {mod.author ? <span>{mod.author}</span> : null}
                                    <span>{mod.hasMain ? '含主进程' : 'client-only'}</span>
                                    {mod.permissions.length > 0 ? <span>权限 {mod.permissions.join(' / ')}</span> : null}
                                    <span>状态 {mod.status}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
