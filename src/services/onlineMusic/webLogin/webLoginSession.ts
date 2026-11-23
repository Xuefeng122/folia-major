import type { AccountReadOutcome } from '../account/accountRead';
import { mergeCookieString } from '../netease/inapp/cookieJar';
import { omni } from '../omni';
import { writeProviderSessionValue } from '../providerStorage';
import {
    closeNativeLoginPage,
    onNativeLoginEvent,
    openNativeLoginPage,
    peekNativeLoginCookie,
    readNativeCookies,
} from './nativeLoginBridge';
import type { PlatformWebLoginSpec } from './platformWebLogin';

// src/services/onlineMusic/webLogin/webLoginSession.ts
// 一次网页登录从开到收的整段：开官方登录页 → 等页面收起 → 读回这个域的 cookie → 落盘 →
// 立刻读一次账号看平台认不认。
//
// 认不认这一步是不能省的：cookie 写进去不等于登录成功（QQ 音乐、酷狗的网页凭据还要跟 App 的
// 请求方式对得上）。读回来的结局原样交给界面说实话，而不是写进去就报「已登录」。

/** 页面是怎么收起的：点了「完成登录」、点了「取消」，或者被别处（换平台、窗口关了）收起。 */
type CloseReason = 'done' | 'cancel' | 'other';

export type WebLoginResult =
    /** 这个环境没有原生桥（网页版 / 桌面版 / 安卓壳还没做）。 */
    | { status: 'unsupported' }
    /** 用的人没点「完成登录」就收起了页面。 */
    | { status: 'cancelled' }
    /** 收起了，但这个域下没有该平台的登录 cookie。 */
    | { status: 'no-cookie'; cookieNames: string[] }
    /** cookie 已落盘，`outcome` 是平台随后对「有没有人登录」的回答。 */
    | {
        status: 'written';
        cookieCount: number;
        loginNames: string[];
        outcome: AccountReadOutcome;
    };

const closeReasonOf = (data: Record<string, unknown>): CloseReason => {
    const reason = typeof data.reason === 'string' ? data.reason : '';
    if (reason === 'done' || reason === 'cancel') return reason;
    return 'other';
};

/** 页面一直开着时的上限：超过就当作被别处收起，免得一个计时器留到 App 关闭。 */
const CLOSE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 等登录页收起。必须在开页面之前就挂上：页面收起得很快（一点就取消）时，晚挂上的监听会等不到那一声。
 * 返回的 settle 由调用方在异常路径上收尾，免得多等。
 */
const openCloseWaiter = async (): Promise<{ closed: Promise<CloseReason>; settle: (reason: CloseReason) => void; dispose: () => void }> => {
    let settled = false;
    let settle: (reason: CloseReason) => void = () => { };
    const closed = new Promise<CloseReason>(resolve => {
        const timer = window.setTimeout(() => done('other'), CLOSE_TIMEOUT_MS);
        function done(reason: CloseReason) {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            resolve(reason);
        }
        settle = done;
    });
    const unsubscribe = await onNativeLoginEvent('loginPageClosed', data => settle(closeReasonOf(data)));
    return {
        closed,
        settle: reason => settle(reason),
        dispose: () => {
            settled = true;
            unsubscribe();
        },
    };
};

/** 把 cookie 写到 App 自己用的地方。 */
const sinkCookies = (spec: PlatformWebLoginSpec, header: string): void => {
    if (spec.sink.kind === 'netease-jar') {
        mergeCookieString(header);
        writeProviderSessionValue(spec.providerId, spec.sink.sessionKey, header);
        return;
    }
    writeProviderSessionValue(spec.providerId, spec.sink.key, header);
};

/**
 * 原生登录页建不起来时的退路：在系统浏览器里登录，把 Cookie 粘进来。
 *
 * 真机上如果 `loginWebView` 没能创建（插件没编进去、页面被系统收起），网页登录这条路就断在这里，
 * 而不是让登录窗口只剩下扫码一条。这一条只做两件事：把粘进来的 Cookie 落到 App 自己用的地方，
 * 再问平台一次认不认——和网页登录收尾时走的是同一段代码，所以「认不认」的说法也一致。
 */
export const runPastedCookieLogin = async (
    spec: PlatformWebLoginSpec,
    rawCookie: string,
): Promise<WebLoginResult> => {
    const header = rawCookie.trim().replace(/^cookie\s*:\s*/iu, '').replace(/\s+/gu, ' ');
    if (!header) return { status: 'no-cookie', cookieNames: [] };
    const names = header
        .split(';')
        .map(part => part.split('=')[0].trim())
        .filter(Boolean);
    sinkCookies(spec, header);
    console.log(`[webLogin] pasted cookie written for ${spec.providerId}: ${names.length} name(s), login names ${spec.loginCookieNames.filter(name => names.includes(name)).join('/') || 'none'}`);
    const outcome = await omni.readAccount(spec.providerId, 'sync');
    return {
        status: 'written',
        cookieCount: names.length,
        loginNames: spec.loginCookieNames.filter(name => names.includes(name)),
        outcome,
    };
};

export type WebLoginRunOptions = {
    /** 目标域上出现了登录 cookie（原生那边在轮询，这里只是被通知一声）。 */
    onCookieFound?: (names: string[]) => void;
    /** 页面还没关就已经能嗅到登录 cookie 时的一次性探问间隔，默认 1.2 秒。 */
    peekIntervalMs?: number;
};

/**
 * 走一遍网页登录。永不 reject：每个结局都是一种 status。
 */
export const runWebLogin = async (
    spec: PlatformWebLoginSpec,
    options: WebLoginRunOptions = {},
): Promise<WebLoginResult> => {
    // 先挂「页面收起了」再开页面：收起得很快时那一句不会丢。
    const waiter = await openCloseWaiter();

    const opened = await openNativeLoginPage({
        url: spec.url,
        domain: spec.cookieDomain,
        loginCookieNames: spec.loginCookieNames,
        title: spec.title,
    });
    if (!opened) {
        waiter.dispose();
        return { status: 'unsupported' };
    }

    // 两个来源都听：原生那边轮询到了会主动说；Web 这边也在页面开着的时候自己问一遍，
    // 因为桥的轮询只报「新出现的」，页面复用（同一个网页换地址）时可能早就有旧 cookie。
    const heard: string[] = [];
    const note = (names: string[]) => {
        const fresh = names.filter(name => !heard.includes(name));
        if (fresh.length === 0) return;
        heard.push(...fresh);
        options.onCookieFound?.(names);
    };
    const unsubscribeFound = await onNativeLoginEvent('loginCookieFound', data => {
        note(Array.isArray(data.names) ? data.names.filter((name): name is string => typeof name === 'string') : []);
    });
    const peek = window.setInterval(() => {
        void peekNativeLoginCookie(spec.cookieDomain, spec.loginCookieNames).then(found => note(found.names));
    }, options.peekIntervalMs ?? 1200);

    let reason: CloseReason = 'other';
    try {
        reason = await waiter.closed;
    } finally {
        window.clearInterval(peek);
        unsubscribeFound();
        waiter.dispose();
    }

    if (reason === 'cancel') {
        await closeNativeLoginPage();
        return { status: 'cancelled' };
    }

    const snapshot = await readNativeCookies(spec.cookieDomain);
    const header = snapshot?.header ?? '';
    const loginNames = (snapshot?.names ?? []).filter(name => spec.loginCookieNames.includes(name));
    if (!snapshot || !header.trim() || loginNames.length === 0) {
        return { status: 'no-cookie', cookieNames: snapshot?.names ?? [] };
    }

    sinkCookies(spec, header);
    // 写进去之后立刻问平台一次：这一问同时把账号、歌单、红心放进账户 store，界面照它画。
    const outcome = await omni.readAccount(spec.providerId, 'sync');
    return {
        status: 'written',
        cookieCount: snapshot.cookies.length,
        loginNames,
        outcome,
    };
};
