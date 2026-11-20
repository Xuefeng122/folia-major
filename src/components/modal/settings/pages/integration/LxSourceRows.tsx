import React, { useCallback, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, FileUp, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Row, Status, TextArea, Toggle } from '../../kit';
import { useLxSourceStore } from '../../../../../services/onlineMusic/lxSource/lxSourceStore';
import { lxSourceLoadError, resetLxSourceHosts } from '../../../../../services/onlineMusic/lxSource/lxSourcePlayback';
import { O } from './options';

// src/components/modal/settings/pages/integration/LxSourceRows.tsx
// The imported LX sources of the 连接与集成 page: where scripts are added from a file or from
// pasted text, then the list itself — each source switchable, ordered, removable — which is the
// order a play is switched through when its own platform hands out no address.

export const LxSourceRows: React.FC = () => {
    const { t } = useTranslation();
    const sources = useLxSourceStore(state => state.sources);
    const importSource = useLxSourceStore(state => state.importSource);
    const removeSource = useLxSourceStore(state => state.removeSource);
    const setEnabled = useLxSourceStore(state => state.setEnabled);
    const move = useLxSourceStore(state => state.move);
    const [notice, setNotice] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [pasting, setPasting] = useState(false);
    const fileRef = useRef<HTMLInputElement | null>(null);

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
                    const error = lxSourceLoadError(source.id) ?? source.lastError ?? null;
                    const hits = source.hits ?? 0;
                    const misses = source.misses ?? 0;
                    const state = error
                        ? t('lxSource.stateError', { reason: error })
                        : hits + misses === 0
                            ? t('lxSource.stateUntried')
                            : t('lxSource.stateCount', { hits, misses });
                    return (
                        <Row
                            key={source.id}
                            option={O.lxSourceList}
                            label={source.name}
                            hint={[source.version ? `v${source.version}` : null, source.author]
                                .filter(Boolean)
                                .join(' · ') || undefined}
                        >
                            <Status tone={error ? 'warn' : hits > 0 ? 'ok' : undefined}>{state}</Status>
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
        </>
    );
};

export default LxSourceRows;
