// src/services/onlineMusic/webLogin/nativeLoginBridge.ts
// 原生登录桥（capacitor-plugin：FoliaLoginBridge，见 ios-plugin/FoliaLoginBridge.swift）。
//
// 这里只做三件事：找到桥、按需挂事件、把原生回的东西收成普通对象。桥不在（网页版、桌面版、
// 安卓壳还没做）时每个办法都安静地回 null / 空——网页登录这一项就不该出现在界面上。
//
// 找桥有两条路，先从现成的 Capacitor.Plugins 里拿（原生注入的运行时里就有，同步、画界面时用得上），
// 再退到 @capacitor/core 的 registerPlugin（自定义插件按名字注册，见 ios/App/App/capacitor.config.json
// 的 packageClassList）。非 iOS 壳构建里 @capacitor/core 被 vite 指到一个空壳（见 vite.config.ts），
// isNativePlatform() 恒为 false，于是这两条路都拿不到东西。

import { Capacitor as CapacitorCore, registerPlugin } from '@capacitor/core';

export type NativeLoginCookie = {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    expires?: number;
};

export type NativeCookieSnapshot = {
    domain: string;
    /** 直接可以塞进 Cookie 头的那一串。 */
    header: string;
    cookies: NativeLoginCookie[];
    names: string[];
};

type NativeLoginPageResult = { opened?: boolean; reused?: boolean };
type NativePeekResult = { found?: boolean; names?: string[] };

type ListenerHandle = { remove: () => Promise<void> | void };
type NativeListener = (data: Record<string, unknown>) => void;

interface LoginBridgePlugin {
    openLoginPage: (options: Record<string, unknown>) => Promise<NativeLoginPageResult>;
    readCookies: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    peekLoginCookie: (options?: Record<string, unknown>) => Promise<NativePeekResult>;
    clearCookies: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    closeLoginPage: () => Promise<Record<string, unknown>>;
    addListener?: (eventName: string, listener: NativeListener) => Promise<ListenerHandle> | ListenerHandle;
}

interface CapacitorGlobal {
    Plugins?: Record<string, unknown>;
    getPlatform?: () => string;
    isNativePlatform?: () => boolean;
}

const BRIDGE_NAME = 'FoliaLoginBridge';

// 只要是个对象就当作桥：registerPlugin 给的是按需生成的代理（Capacitor 8 里方法不一定在对象上
// 枚举得出来），按方法名判会把真机上的桥误判成「没有」。真缺方法时每个调用各自 try/catch，界面照样有话说。
const asPlugin = (value: unknown): LoginBridgePlugin | null => (
    value && typeof value === 'object' ? value as LoginBridgePlugin : null
);

const capacitorGlobal = (): CapacitorGlobal | null => (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor ?? null;

/** 原生注入的运行时里现成的那一份（有就直接用，不必等 registerPlugin）。 */
const bridgeFromRuntime = (): LoginBridgePlugin | null => {
    const capacitor = capacitorGlobal();
    if (!capacitor) return null;
    if (typeof capacitor.isNativePlatform === 'function' && !capacitor.isNativePlatform()) return null;
    return asPlugin(capacitor.Plugins?.[BRIDGE_NAME]);
};

let resolved: LoginBridgePlugin | null = null;

/**
 * 现在这一份页面里有没有原生桥。同步读：画界面时就要知道有没有这一项。
 * iOS 壳里才有；网页版与桌面版没有 Capacitor，安卓壳还没有这个插件。
 */
export const nativeLoginBridge = (): LoginBridgePlugin | null => {
    if (resolved) return resolved;
    const ready = bridgeFromRuntime();
    if (ready) {
        resolved = ready;
        return resolved;
    }
    try {
        if (typeof CapacitorCore?.isNativePlatform === 'function' && !CapacitorCore.isNativePlatform()) return null;
        resolved = typeof registerPlugin === 'function' ? asPlugin(registerPlugin(BRIDGE_NAME)) : null;
    } catch {
        resolved = null;
    }
    return resolved;
};

/** 兜底的那一份：同步那一条没拿到时再问一次（负结果不缓存，插件晚一步注册也还能用上）。 */
const loadLoginBridge = async (): Promise<LoginBridgePlugin | null> => nativeLoginBridge();

/** 这是不是 iOS 原生壳（Capacitor 的 iOS 容器）。网页版 / 桌面版这里恒为 false。 */
export const isIosNativePlatform = (): boolean => {
    // 先问原生注入的运行时（一定在、一定同步），再退到 @capacitor/core：真机上这两条哪一条先答得上
    // 都算 iOS 壳，不该因为 @capacitor/core 这一侧被替换/晚到就把入口判成「没有」。
    const runtime = capacitorGlobal() as (CapacitorGlobal & { getPlatform?: () => string }) | null;
    try {
        if (typeof runtime?.getPlatform === 'function' && runtime.getPlatform() === 'ios') return true;
    } catch {
        // 运行时这一条问不出来，接着问 @capacitor/core。
    }
    try {
        if (typeof CapacitorCore?.isNativePlatform === 'function' && !CapacitorCore.isNativePlatform()) return false;
        return typeof CapacitorCore?.getPlatform === 'function' && CapacitorCore.getPlatform() === 'ios';
    } catch {
        return false;
    }
};

/**
 * 网页登录在这个环境里该不该出现。
 *
 * 只要跑在 iOS 原生壳里就给这一项：插件是编进 App target、按类名登记进 packageClassList 的，
 * registerPlugin 拿到的代理对象在彩色打印（Capacitor 8 的 createPluginHandle）下不一定能把方法名
 * 一一枚举出来，早先按「有没有 openLoginPage 这个方法」判会把入口整个吞掉——真机上一版就是这么没的。
 * 桥真的不在时，按下去会说清楚（login.webLoginUnavailable），入口本身不能凭一次探测就消失。
 */
export const canUseWebLogin = (): boolean => nativeLoginBridge() !== null || isIosNativePlatform();

/**
 * 现在这一份页面里，桥是"没有"还是"还没到"。诊断用（设置里的登录诊断报告、真机排查）。
 * 只报事实，不做任何写入。
 */
export const loginBridgeDiagnostics = (): {
    platform: string;
    native: boolean;
    /** 原生注入的运行时里直接就有这一份插件（window.Capacitor.Plugins.FoliaLoginBridge）。 */
    runtimePlugin: boolean;
    /** 原生在文档开头推的插件头（packageClassList 认到才会推）。 */
    headerSeen: boolean;
    /** registerPlugin 拿到的是一个可用的插件对象。 */
    registered: boolean;
    /** 代理对象上能直接看到 openLoginPage / readCookies 这两个方法（调试用，不参与判定）。 */
    methodsVisible: boolean;
} => {
    const capacitor = capacitorGlobal() as (CapacitorGlobal & { PluginHeaders?: { name?: string }[] }) | null;
    const headers = Array.isArray(capacitor?.PluginHeaders) ? capacitor!.PluginHeaders! : [];
    let native = false;
    try {
        native = Boolean(CapacitorCore?.isNativePlatform?.());
    } catch {
        native = false;
    }
    let registered = false;
    try {
        registered = asPlugin(registerPlugin(BRIDGE_NAME)) !== null;
    } catch {
        registered = false;
    }
    return {
        platform: (() => {
            try {
                return typeof CapacitorCore?.getPlatform === 'function' ? CapacitorCore.getPlatform() : 'unknown';
            } catch {
                return 'unknown';
            }
        })(),
        native,
        runtimePlugin: Boolean(asPlugin(capacitor?.Plugins?.[BRIDGE_NAME])),
        headerSeen: headers.some(header => header?.name === BRIDGE_NAME),
        registered,
        methodsVisible: (() => {
            try {
                const plugin = registerPlugin(BRIDGE_NAME) as unknown as Partial<LoginBridgePlugin>;
                return typeof plugin?.openLoginPage === 'function' && typeof plugin?.readCookies === 'function';
            } catch {
                return false;
            }
        })(),
    };
};

/**
 * 再问一次桥在不在（画界面那一刻可能比原生注入晚一步）。有就记下来，之后 canUseWebLogin 也回 true。
 * 界面上等不到桥时用它补一次，免得入口因为一次时序就永远不出现。
 */
export const probeLoginBridge = async (): Promise<boolean> => {
    if (nativeLoginBridge()) return true;
    await new Promise<void>(resolve => {
        // 让出一轮事件循环：registerPlugin 起的原生调用来得及回来。
        setTimeout(resolve, 0);
    });
    return nativeLoginBridge() !== null;
};

export type NativeLoginEvent = 'loginCookieFound' | 'loginPageClosed' | 'loginPageError' | 'loginPageTitle';

/** 挂一个原生事件，返回退订。没有桥就当没挂上，退订是个空动作。 */
export const onNativeLoginEvent = async (
    event: NativeLoginEvent,
    handler: (data: Record<string, unknown>) => void,
): Promise<() => void> => {
    const plugin = await loadLoginBridge();
    if (!plugin?.addListener) return () => { };
    try {
        const handle = await plugin.addListener(event, handler);
        return () => {
            try {
                void handle?.remove?.();
            } catch {
                // 退订失败无所谓：页面已经收起时桥那边也不会再发。
            }
        };
    } catch {
        return () => { };
    }
};

/** 开一个全屏网页。`reused` 是同一个页面里换了地址（没有再叠一层）。 */
export const openNativeLoginPage = async (options: {
    url: string;
    domain: string;
    loginCookieNames: string[];
    title: string;
}): Promise<{ opened: boolean; reused: boolean } | null> => {
    const plugin = await loadLoginBridge();
    if (!plugin) return null;
    try {
        const result = await plugin.openLoginPage(options);
        return { opened: result?.opened !== false, reused: result?.reused === true };
    } catch {
        return null;
    }
};

/** 读某个域下的全部 cookie（含 HttpOnly，document.cookie 读不到的那些）。 */
export const readNativeCookies = async (domain: string): Promise<NativeCookieSnapshot | null> => {
    const plugin = await loadLoginBridge();
    if (!plugin) return null;
    try {
        const raw = await plugin.readCookies({ domain });
        const cookies = Array.isArray(raw?.cookies) ? raw.cookies as NativeLoginCookie[] : [];
        const headerFromNative = typeof raw?.cookieHeader === 'string' ? raw.cookieHeader : '';
        const header = headerFromNative || cookies
            .filter(cookie => cookie && cookie.name && typeof cookie.value === 'string')
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
        return {
            domain: typeof raw?.domain === 'string' && raw.domain ? raw.domain : domain,
            header,
            cookies,
            names: cookies.map(cookie => cookie.name).filter(Boolean),
        };
    } catch {
        return null;
    }
};

/** 问一次目标域上登录 cookie 到了没有（不写任何东西）。 */
export const peekNativeLoginCookie = async (domain: string, loginCookieNames: string[]): Promise<{ found: boolean; names: string[] }> => {
    const plugin = await loadLoginBridge();
    if (!plugin) return { found: false, names: [] };
    try {
        const result = await plugin.peekLoginCookie({ domain, loginCookieNames });
        const names = Array.isArray(result?.names) ? result.names.filter((name): name is string => typeof name === 'string') : [];
        return { found: Boolean(result?.found) || names.length > 0, names };
    } catch {
        return { found: false, names: [] };
    }
};

/** 收起网页（用的人没点「完成登录」时由 Web 侧收）。 */
export const closeNativeLoginPage = async (): Promise<void> => {
    const plugin = await loadLoginBridge();
    if (!plugin) return;
    try {
        await plugin.closeLoginPage();
    } catch {
        // 已经收起了。
    }
};
