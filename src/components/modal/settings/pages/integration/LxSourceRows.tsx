import React, { useCallback, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Download, ExternalLink, FileUp, Link2, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Row, Status, TextArea, TextField, Toggle } from '../../kit';
import { useLxSourceStore } from '../../../../../services/onlineMusic/lxSource/lxSourceStore';
import { lxSourceGateNotice, lxSourceLoadError, resetLxSourceHosts } from '../../../../../services/onlineMusic/lxSource/lxSourcePlayback';
import {
    applyLxSourceUpdate,
    checkAllLxSourceUpdates,
    checkLxSourceUpdate,
    fetchLxScriptFromAddress,
    lxUpdateManifestAddress,
    replaceLxSourceScript,
    restoreLxSourceBackup,
    writeLxUpdateManifest,
    type LxUpdateCheck,
} from '../../../../../services/onlineMusic/lxSource/lxSourceUpdater';
import type { LxSourceMeta } from '../../../../../services/onlineMusic/lxSource/lxSourceTypes';
import { O } from './options';

// src/components/modal/settings/pages/integration/LxSourceRows.tsx
// The imported LX sources of the 连接与集成 page: where scripts are added from a file or from
// pasted text, then the list itself — each source switchable, ordered, removable — which is the
// order a play is switched through when its own platform hands out no address. Each row also keeps
// its own update address, so a source published somewhere new can be replaced without importing it
// again; a replaced script is kept as a backup the same row can roll back to.

export const LxSourceRows: React.FC = () => {
    const { t } = useTranslation();
    const sources = useLxSourceStore(state => state.sources);
    const importSource = useLxSourceStore(state => state.importSource);
    const removeSource = useLxSourceStore(state => state.removeSource);
    const setEnabled = useLxSourceStore(state => state.setEnabled);
    const move = useLxSourceStore(state => state.move);
    const setUpdateUrl = useLxSourceStore(state => state.setUpdateUrl);
    const [notice, setNotice] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [pasting, setPasting] = useState(false);
    const [checks, setChecks] = useState<Record<string, LxUpdateCheck>>({});
    const [busy, setBusy] = useState<string | null>(null);
    const [addressFor, setAddressFor] = useState<string | null>(null);
    const [addressDraft, setAddressDraft] = useState('');
    const [manifest, setManifest] = useState(() => lxUpdateManifestAddress());
    const [replaceFor, setReplaceFor] = useState<string | null>(null);
    const [replaceDraft, setReplaceDraft] = useState('');
    const [replaceUrl, setReplaceUrl] = useState('');
    const fileRef = useRef<HTMLInputElement | null>(null);

    /** Opens a release page, or leaves its address in the clipboard where the shell has no browser. */
    const openAddress = useCallback(async (address?: string) => {
        if (!address) return;
        const opened = window.open(address, '_blank', 'noopener');
        if (opened) return;
        try {
            await navigator.clipboard.writeText(address);
            setNotice(t('lxSource.addressCopied', { address }));
        } catch {
            setNotice(t('lxSource.addressCopyFailed', { address }));
        }
    }, [t]);

    /**
     * Puts a checked script in place of the one a source runs now. Every road to a new script ends
     * here — the copy an online check read, one pasted from a release page, one fetched from an
     * address — so all of them are validated and all of them leave a backup behind.
     */
    const replaceWith = useCallback(async (source: LxSourceMeta, code: string, address?: string) => {
        setBusy(source.id);
        try {
            const applied = await replaceLxSourceScript(source, code, address);
            resetLxSourceHosts();
            setReplaceFor(null);
            setReplaceDraft('');
            setReplaceUrl('');
            setChecks(current => {
                const next = { ...current };
                delete next[source.id];
                return next;
            });
            setNotice(t('lxSource.updated', {
                name: applied.name,
                version: applied.version || t('lxSource.noVersion'),
            }));
        } catch (error) {
            setNotice(t('lxSource.updateFailed', {
                name: source.name,
                reason: error instanceof Error ? error.message : String(error),
            }));
        } finally {
            setBusy(null);
        }
    }, [t]);

    const runImport = useCallback(async (code: string, fileName?: string) => {
        try {
            const meta = await importSource(code, fileName);
            resetLxSourceHosts();
            setNotice(t('lxSource.imported', { name: meta.name }));
        } catch (error) {
            setNotice(t('lxSource.importFailed', { reason: error instanceof Error ? error.message : String(error) }));
        }
    }, [importSource, t]);

    const readFiles = useCallback(async (files: FileList | null) => {
        if (!files || !files.length) return;
        for (const file of Array.from(files)) {
            const text = await file.text();
            await runImport(text, file.name);
        }
    }, [runImport]);

    const check = useCallback(async (source: LxSourceMeta) => {
        setBusy(source.id);
        try {
            const result = await checkLxSourceUpdate(source);
            setChecks(current => ({ ...current, [source.id]: result }));
        } finally {
            setBusy(null);
        }
    }, []);

    const apply = useCallback(async (source: LxSourceMeta) => {
        setBusy(source.id);
        try {
            const applied = await applyLxSourceUpdate(source, checks[source.id]);
            resetLxSourceHosts();
            setChecks(current => {
                const next = { ...current };
                delete next[source.id];
                return next;
            });
            setNotice(t('lxSource.updated', {
                name: applied.name,
                version: applied.version || t('lxSource.noVersion'),
            }));
        } catch (error) {
            setNotice(t('lxSource.updateFailed', {
                name: source.name,
                reason: error instanceof Error ? error.message : String(error),
            }));
        } finally {
            setBusy(null);
        }
    }, [checks, t]);

    const checkAll = useCallback(async () => {
        setBusy('all');
        try {
            const results = await checkAllLxSourceUpdates();
            const map: Record<string, LxUpdateCheck> = {};
            results.forEach(result => { map[result.id] = result; });
            setChecks(map);
            const found = results.filter(result => result.status === 'update').length;
            const failed = results.filter(result => result.status === 'error').length;
            setNotice(t('lxSource.checkedAll', { found, failed }));
        } finally {
            setBusy(null);
        }
    }, [t]);

    const updateAll = useCallback(async () => {
        setBusy('all');
        try {
            const results = await checkAllLxSourceUpdates();
            const map: Record<string, LxUpdateCheck> = {};
            let applied = 0;
            let failed = 0;
            for (const result of results) {
                map[result.id] = result;
                if (result.status !== 'update') continue;
                const source = useLxSourceStore.getState().sources.find(item => item.id === result.id);
                if (!source) continue;
                try {
                    await applyLxSourceUpdate(source, result);
                    delete map[result.id];
                    applied += 1;
                } catch (error) {
                    failed += 1;
                    console.warn('[LxSource] Update failed', result.name, error);
                }
            }
            resetLxSourceHosts();
            setChecks(map);
            setNotice(t('lxSource.updatedAll', { applied, failed }));
        } finally {
            setBusy(null);
        }
    }, [t]);

    const stateOf = useCallback((source: LxSourceMeta) => {
        const error = lxSourceLoadError(source.id) ?? source.lastError ?? null;
        const hits = source.hits ?? 0;
        const misses = source.misses ?? 0;
        if (error) return { text: t('lxSource.stateError', { reason: error }), tone: 'warn' as const };
        if (hits + misses === 0) return { text: t('lxSource.stateUntried'), tone: undefined };
        return { text: t('lxSource.stateCount', { hits, misses }), tone: hits > 0 ? 'ok' as const : undefined };
    }, [t]);

    const updateStateOf = (source: LxSourceMeta) => {
        const result = checks[source.id];
        if (busy === source.id) return { text: t('lxSource.checking'), tone: 'warn' as const, result: undefined };
        if (!result) return null;
        if (result.status === 'update') {
            return {
                text: t('lxSource.updateAvailable', {
                    from: result.currentVersion || t('lxSource.noVersion'),
                    to: result.remoteVersion || t('lxSource.noVersion'),
                }),
                tone: 'ok' as const,
                result,
            };
        }
        if (result.status === 'latest') return { text: t('lxSource.upToDate', { version: result.remoteVersion || t('lxSource.noVersion') }), tone: undefined, result };
        if (result.status === 'manifest') {
            return {
                text: t('lxSource.updateOnPage', {
                    from: result.currentVersion || t('lxSource.noVersion'),
                    to: result.remoteVersion || t('lxSource.noVersion'),
                }),
                tone: 'warn' as const,
                result,
            };
        }
        if (result.status === 'no-address') return { text: t('lxSource.noAddress'), tone: undefined, result };
        return { text: t('lxSource.checkFailed', { reason: result.reason ?? '' }), tone: 'warn' as const, result };
    };

    return (
        <>
            <Row option={O.lxSourceImport} hint={t('lxSource.importHint')}>
                <input
                    ref={fileRef}
                    type="file"
                    accept=".js,text/javascript,application/javascript"
                    multiple
                    hidden
                    onChange={event => {
                        void readFiles(event.target.files);
                        event.target.value = '';
                    }}
                />
                <Button icon={FileUp} variant="primary" onClick={() => fileRef.current?.click()}>
                    {t('lxSource.chooseFile')}
                </Button>
                <Button variant="quiet" onClick={() => setPasting(value => !value)}>
                    {t('lxSource.paste')}
                </Button>
            </Row>
            {pasting && (
                <Row option={O.lxSourcePaste} sub hint={t('lxSource.pasteHint')}>
                    <TextArea
                        value={draft}
                        onChange={setDraft}
                        placeholder={t('lxSource.pastePlaceholder')}
                    />
                    <Button
                        disabled={!draft.trim()}
                        onClick={() => {
                            const code = draft;
                            setDraft('');
                            setPasting(false);
                            void runImport(code);
                        }}
                    >
                        {t('lxSource.importText')}
                    </Button>
                </Row>
            )}
            {sources.length === 0
                ? (
                    <Row option={O.lxSourceList} hint={t('lxSource.emptyHint')}>
                        <Status>{t('lxSource.empty')}</Status>
                    </Row>
                )
                : sources.map((source, index) => {
                    const state = stateOf(source);
                    const update = updateStateOf(source);
                    // The gate lets a source past its own "a newer release exists" check so it keeps
                    // working; the row still says so, because the script it runs is not the newest.
                    const gate = lxSourceGateNotice(source.id);
                    return (
                        <React.Fragment key={source.id}>
                            <Row
                                option={O.lxSourceList}
                                label={source.name}
                                hint={[source.version ? `v${source.version}` : null, source.author]
                                    .filter(Boolean)
                                    .join(' · ') || undefined}
                            >
                                <Status tone={state.tone}>{state.text}</Status>
                                {gate && (
                                    <Button
                                        variant="quiet"
                                        icon={RefreshCw}
                                        tip={t('lxSource.gateHint', { version: gate === 'unknown' ? '' : gate })}
                                        disabled={busy !== null}
                                        onClick={() => { void check(source); }}
                                    >
                                        {t('lxSource.outdatedGate')}
                                    </Button>
                                )}
                                {update && <Status tone={update.tone}>{update.text}</Status>}
                                {update?.result?.status === 'update' && (
                                    <Button
                                        icon={Download}
                                        variant="primary"
                                        disabled={busy !== null}
                                        onClick={() => { void apply(source); }}
                                    >
                                        {t('lxSource.applyUpdate')}
                                    </Button>
                                )}
                                {update?.result?.status === 'manifest' && (
                                    <Button
                                        icon={ExternalLink}
                                        variant="quiet"
                                        onClick={() => {
                                            void openAddress(update.result?.releaseUrl ?? update.result?.address);
                                        }}
                                    >
                                        {t('lxSource.openRelease')}
                                    </Button>
                                )}
                                <Button
                                    variant="quiet"
                                    icon={RefreshCw}
                                    tip={t('lxSource.checkUpdate')}
                                    disabled={busy !== null}
                                    onClick={() => { void check(source); }}
                                />
                                <Button
                                    variant="quiet"
                                    icon={FileUp}
                                    tip={t('lxSource.replaceOpen')}
                                    onClick={() => {
                                        setReplaceFor(replaceFor === source.id ? null : source.id);
                                        setReplaceDraft('');
                                        setReplaceUrl(source.updateUrl ?? '');
                                    }}
                                />
                                <Button
                                    variant="quiet"
                                    icon={Link2}
                                    tip={source.updateUrl ? t('lxSource.editAddress') : t('lxSource.addAddress')}
                                    onClick={() => {
                                        setAddressFor(addressFor === source.id ? null : source.id);
                                        setAddressDraft(source.updateUrl ?? '');
                                    }}
                                />
                                <Button
                                    variant="quiet"
                                    icon={ArrowUp}
                                    tip={t('lxSource.moveUp')}
                                    disabled={index === 0}
                                    onClick={() => move(source.id, -1)}
                                />
                                <Button
                                    variant="quiet"
                                    icon={ArrowDown}
                                    tip={t('lxSource.moveDown')}
                                    disabled={index === sources.length - 1}
                                    onClick={() => move(source.id, 1)}
                                />
                                <Toggle checked={source.enabled} onChange={checked => setEnabled(source.id, checked)} />
                                <Button
                                    variant="quiet"
                                    icon={Trash2}
                                    tip={t('lxSource.remove')}
                                    onClick={() => {
                                        void removeSource(source.id).then(() => {
                                            resetLxSourceHosts();
                                            setNotice(t('lxSource.removed', { name: source.name }));
                                        });
                                    }}
                                />
                            </Row>
                            {addressFor === source.id && (
                                <Row sub label={t('lxSource.address')} hint={t('lxSource.addressHint')}>
                                    <span className="flex min-w-0 items-center gap-2">
                                        <TextField
                                            type="url"
                                            value={addressDraft}
                                            placeholder={t('lxSource.addressPlaceholder')}
                                            onChange={setAddressDraft}
                                            onCommit={() => {
                                                setUpdateUrl(source.id, addressDraft);
                                                setNotice(t('lxSource.addressSaved', { name: source.name }));
                                                setAddressFor(null);
                                                setChecks(current => {
                                                    const next = { ...current };
                                                    delete next[source.id];
                                                    return next;
                                                });
                                            }}
                                        />
                                    </span>
                                    {source.updatedAt ? (
                                        <Button
                                            variant="quiet"
                                            disabled={busy !== null}
                                            onClick={() => {
                                                setBusy(source.id);
                                                void restoreLxSourceBackup(source)
                                                    .then(restored => {
                                                        resetLxSourceHosts();
                                                        setNotice(restored
                                                            ? t('lxSource.rolledBack', {
                                                                name: restored.name,
                                                                version: restored.version || t('lxSource.noVersion'),
                                                            })
                                                            : t('lxSource.noBackup', { name: source.name }));
                                                    })
                                                    .finally(() => setBusy(null));
                                            }}
                                        >
                                            {t('lxSource.rollback')}
                                        </Button>
                                    ) : null}
                                </Row>
                            )}
                            {replaceFor === source.id && (
                                <Row sub label={t('lxSource.replaceTitle')} hint={t('lxSource.replaceHint')}>
                                    <span className="flex min-w-0 items-center gap-2">
                                        <TextField
                                            type="url"
                                            value={replaceUrl}
                                            placeholder={t('lxSource.replaceUrlPlaceholder')}
                                            onChange={setReplaceUrl}
                                        />
                                        <Button
                                            variant="quiet"
                                            disabled={!replaceUrl.trim() || busy !== null}
                                            onClick={() => {
                                                const address = replaceUrl.trim();
                                                setBusy(source.id);
                                                void fetchLxScriptFromAddress(address)
                                                    .then(code => replaceWith(source, code, address))
                                                    .catch(error => {
                                                        setNotice(t('lxSource.updateFailed', {
                                                            name: source.name,
                                                            reason: error instanceof Error ? error.message : String(error),
                                                        }));
                                                    })
                                                    .finally(() => setBusy(null));
                                            }}
                                        >
                                            {t('lxSource.replaceFromUrl')}
                                        </Button>
                                    </span>
                                    <TextArea
                                        value={replaceDraft}
                                        onChange={setReplaceDraft}
                                        placeholder={t('lxSource.replacePastePlaceholder')}
                                    />
                                    <Button
                                        variant="primary"
                                        disabled={!replaceDraft.trim() || busy !== null}
                                        onClick={() => {
                                            const code = replaceDraft;
                                            void replaceWith(source, code, replaceUrl.trim() || undefined);
                                        }}
                                    >
                                        {t('lxSource.replaceApply')}
                                    </Button>
                                </Row>
                            )}
                        </React.Fragment>
                    );
                })}
            <Row option={O.lxSourceReload} hint={notice ?? t('lxSource.reloadHint')}>
                <Button
                    icon={RefreshCw}
                    variant="quiet"
                    onClick={() => {
                        resetLxSourceHosts();
                        setNotice(t('lxSource.reloaded'));
                    }}
                >
                    {t('lxSource.reload')}
                </Button>
            </Row>
            <Row option={O.lxSourceUpdate} hint={t('lxSource.updateHint')}>
                <Button
                    icon={RefreshCw}
                    variant="quiet"
                    disabled={busy !== null || sources.length === 0}
                    onClick={() => { void checkAll(); }}
                >
                    {t('lxSource.checkAll')}
                </Button>
                <Button
                    icon={Download}
                    variant="primary"
                    disabled={busy !== null || sources.length === 0}
                    onClick={() => { void updateAll(); }}
                >
                    {t('lxSource.updateAll')}
                </Button>
            </Row>
            <Row option={O.lxSourceManifest} hint={t('lxSource.manifestHint')}>
                <span className="flex min-w-0 items-center gap-2">
                    <TextField
                        type="url"
                        value={manifest}
                        placeholder={t('lxSource.manifestPlaceholder')}
                        onChange={setManifest}
                        onCommit={() => {
                            writeLxUpdateManifest(manifest);
                            setNotice(t('lxSource.manifestSaved'));
                        }}
                    />
                </span>
            </Row>
        </>
    );
};

export default LxSourceRows;
