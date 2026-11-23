import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { LibraryAccountController } from '../../library/core/account/account.contract';
import { setStatusMessage } from '../../stores/useStatusMessageStore';
import type { OnlineProviderId } from '../../types/onlineMusic';
import { canUseWebLogin, isIosNativePlatform, loginBridgeDiagnostics, probeLoginBridge } from '../../services/onlineMusic/webLogin/nativeLoginBridge';
import { platformWebLogin } from '../../services/onlineMusic/webLogin/platformWebLogin';
import { runPastedCookieLogin, runWebLogin } from '../../services/onlineMusic/webLogin/webLoginSession';
import { syncAccountData } from './syncAccountData';

// src/components/login/useWebLoginAction.ts
// 登录窗口里「网页登录」那一颗按钮：开平台官方网页 → 登录完把 cookie 收回来 → 立刻读一次账号 → 用一句提示说实话。
//
// 只在有原生桥的环境里给这一颗（iOS 壳）。网页版 / 桌面版没有它，按钮不出现，不是按了才说不行。

export type WebLoginAction = {
    /** 这个环境有没有网页登录（没有就不画按钮）。 */
    available: boolean;
    /** 正在登录页上：按钮转圈、不可按。 */
    busy: boolean;
    /** 选中的平台有没有网页登录这一条路（酷狗之类的看平台的表）。 */
    supported: (providerId: OnlineProviderId | null) => boolean;
    /** 这一家的网页登录要做什么（画在按钮旁边的那句话）；没有就是 null。 */
    note: (providerId: OnlineProviderId | null) => string | null;
    run: (providerId: OnlineProviderId) => void;
    /** iOS 壳里总有这一条退路：原生登录页建不起来时，用系统浏览器登录再把 Cookie 粘回来。 */
    pasteAvailable: boolean;
    /** 把粘进来的 Cookie 落盘并问平台一次（结局的说法和网页登录收尾时一致）。 */
    runPasted: (providerId: OnlineProviderId, cookie: string) => void;
};

export const useWebLoginAction = (
    account: LibraryAccountController,
    t: TFunction,
): WebLoginAction => {
    // 有桥就给这一颗，而且它是默认入口（选平台直接开官方网页登录页，见 LoginHost 的 startLogin）。
    // 首次渲染时桥可能还差一步（原生注入晚一轮）：探一次，探到了再把入口画出来，不让时序把入口吞掉。
    const [available, setAvailable] = useState(() => canUseWebLogin());
    useEffect(() => {
        if (available) return;
        let live = true;
        void probeLoginBridge().then(ready => {
            if (!live || !ready) return;
            setAvailable(true);
        });
        return () => { live = false; };
    }, [available]);
    // 真机排查用：入口在不在、桥探到什么，都打一条（平台、原生、原生插件头、registerPlugin、方法可见性各说一句）。
    // 上一版真机上入口没出现，日志里什么也没有，只能靠猜；这一句是给下一次排查留的现场。
    useEffect(() => {
        console.info(`[webLogin] entry ${available ? 'shown' : 'hidden'}`, loginBridgeDiagnostics());
    }, [available]);
    const [busy, setBusy] = useState(false);
    // 登录页开着的时候再按一次不该叠第二层网页。
    const running = useRef(false);

    const supported = useCallback((providerId: OnlineProviderId | null) => Boolean(providerId && platformWebLogin(providerId)), []);
    const note = useCallback((providerId: OnlineProviderId | null) => {
        const spec = platformWebLogin(providerId);
        return spec ? t(spec.hintKey) : null;
    }, [t]);

    const run = useCallback((providerId: OnlineProviderId) => {
        const spec = platformWebLogin(providerId);
        if (!spec || running.current) return;
        running.current = true;
        setBusy(true);
        setStatusMessage({ type: 'info', text: t('login.webLoginOpening'), providerId });
        void runWebLogin(spec, {
            // 网页里已经能看到登录凭据了：说一句，让用的人知道可以点「完成登录」了。
            onCookieFound: () => setStatusMessage({ type: 'info', text: t('login.webLoginCookieFound'), providerId }),
        }).then(async result => {
            if (result.status === 'cancelled') {
                setStatusMessage({ type: 'info', text: t('login.webLoginCancelled'), providerId });
                return;
            }
            if (result.status === 'unsupported') {
                setStatusMessage({ type: 'error', text: t('login.webLoginUnavailable'), providerId });
                return;
            }
            if (result.status === 'no-cookie') {
                setStatusMessage({
                    type: 'error',
                    text: t('login.webLoginNoCookie'),
                    note: t('login.webLoginNoCookieNote'),
                    providerId,
                });
                return;
            }
            // cookie 落盘了：平台认不认是另一件事，读一次账号再说。
            if (result.outcome === 'read') {
                // 顺带把歌单与红心取回来；同步自己的提示说完，再用登录成功的一句盖上去。
                await syncAccountData(account, providerId, t);
                setStatusMessage({ type: 'success', text: t('login.webLoginSignedIn'), providerId });
                return;
            }
            setStatusMessage({
                type: 'error',
                text: t('login.webLoginNotRecognised'),
                note: t('login.webLoginNotRecognisedNote'),
                providerId,
            });
        }).catch(() => {
            setStatusMessage({ type: 'error', text: t('login.webLoginFailed'), providerId });
        }).finally(() => {
            running.current = false;
            setBusy(false);
        });
    }, [account, t]);

    // 退路：原生登录页这一次没建起来（真机上 `[webLogin] open` 之后没有页面），也不该让登录窗口
    // 只剩扫码一条。iOS 壳里一直给这一条，粘进来的 Cookie 走的是和网页登录收尾同一个落盘函数。
    const pasteAvailable = isIosNativePlatform();
    const runPasted = useCallback((providerId: OnlineProviderId, cookie: string) => {
        const spec = platformWebLogin(providerId);
        if (!spec || running.current) return;
        if (!cookie.trim()) {
            setStatusMessage({ type: 'error', text: t('login.webLoginPasteEmpty'), providerId });
            return;
        }
        running.current = true;
        setBusy(true);
        console.log(`[webLogin] paste submit provider=${providerId} length=${cookie.trim().length}`);
        void runPastedCookieLogin(spec, cookie)
            .then(async result => {
                if (result.status !== 'written') {
                    setStatusMessage({ type: 'error', text: t('login.webLoginNoCookie'), note: t('login.webLoginNoCookieNote'), providerId });
                    return;
                }
                if (result.outcome === 'read') {
                    await syncAccountData(account, providerId, t);
                    setStatusMessage({ type: 'success', text: t('login.webLoginSignedIn'), providerId });
                    return;
                }
                setStatusMessage({
                    type: 'error',
                    text: t('login.webLoginNotRecognised'),
                    note: t('login.webLoginNotRecognisedNote'),
                    providerId,
                });
            })
            .catch(() => setStatusMessage({ type: 'error', text: t('login.webLoginFailed'), providerId }))
            .finally(() => {
                running.current = false;
                setBusy(false);
            });
    }, [account, t]);

    return { available, busy, supported, note, run, pasteAvailable, runPasted };
};
