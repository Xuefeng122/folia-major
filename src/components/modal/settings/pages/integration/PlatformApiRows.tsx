import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Row, TextField } from '../../kit';
import {
    readKugouApiBase,
    readNeteaseApiBase,
    readQqApiBase,
    writeKugouApiBase,
    writeNeteaseApiBase,
    writeQqApiBase,
} from '../../../../../services/onlineMusic/platformApiBase';
import { resetNeteaseApiBaseCache } from '../../../../../services/onlineMusic/netease/netease';
import { resetQqTransportRuntimeCache } from '../../../../../services/onlineMusic/qq/qqTransport';
import { O } from './options';

// src/components/modal/settings/pages/integration/PlatformApiRows.tsx
// The three addresses the iOS app has to be told: it starts no backend of its own, so NetEase, QQ
// Music and KuGou are signed in to against an API the user runs elsewhere. The desktop app runs them
// itself and hides these.

export const PlatformApiRows: React.FC = () => {
    const { t } = useTranslation();
    const [netease, setNetease] = useState(readNeteaseApiBase);
    const [qq, setQq] = useState(readQqApiBase);
    const [kugou, setKugou] = useState(readKugouApiBase);
    const [saved, setSaved] = useState(false);

    const save = () => {
        writeNeteaseApiBase(netease);
        writeQqApiBase(qq);
        writeKugouApiBase(kugou);
        resetNeteaseApiBaseCache();
        resetQqTransportRuntimeCache();
        setSaved(true);
    };

    return (
        <>
            <Row option={O.apiBaseNetease} hint={t('options.apiBaseNeteaseDesc')}>
                <TextField
                    value={netease}
                    onChange={value => {
                        setNetease(value);
                        setSaved(false);
                    }}
                    onCommit={save}
                    type="url"
                    placeholder="http://127.0.0.1:3000"
                />
            </Row>
            <Row option={O.apiBaseQq} hint={t('options.apiBaseQqDesc')}>
                <TextField
                    value={qq}
                    onChange={value => {
                        setQq(value);
                        setSaved(false);
                    }}
                    onCommit={save}
                    type="url"
                    placeholder="http://127.0.0.1:3300"
                />
            </Row>
            <Row option={O.apiBaseKugou} hint={t('options.apiBaseKugouDesc')}>
                <TextField
                    value={kugou}
                    onChange={value => {
                        setKugou(value);
                        setSaved(false);
                    }}
                    onCommit={save}
                    type="url"
                    placeholder="http://127.0.0.1:3100"
                />
            </Row>
            <Row option={O.apiBaseSave} hint={saved ? t('options.apiBaseSaved') : t('options.apiBaseSaveDesc')}>
                <Button variant="primary" onClick={save}>
                    {t('options.apiBaseSave')}
                </Button>
            </Row>
        </>
    );
};

export default PlatformApiRows;
