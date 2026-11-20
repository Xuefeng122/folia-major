import type { OnlineProviderId } from '../../../types/onlineMusic';

// src/services/onlineMusic/webLogin/platformWebLogin.ts
// 网页登录：在 App 里开一个全屏网页，让用的人在自己熟悉的官方登录页上扫码 / 输密码，登录完之后
// 把平台写在那个域下的 cookie 取回来，交给 App 自己用。
//
// 为什么非要走原生：MUSIC_U、qm_keyst 这些是 HttpOnly，页面里的 document.cookie 读不到，
// 只能由原生 WKWebsiteDataStore 的 cookie 库去取。所以这张表只是「开哪个网址、盯哪个域、
// 出现哪个 cookie 算登录了、取到的 cookie 往哪存」这几件事实，不含任何 Web 侧可执行的捷径。

/** 取到的 cookie 落在哪儿：网易云有自己的 cookie jar（原生通道与 App 共用），另两家落 provider 会话。 */
export type WebLoginCookieSink =
    | { kind: 'netease-jar'; sessionKey: 'cookie' }
    | { kind: 'provider-session'; key: string };

export type PlatformWebLoginSpec = {
    providerId: OnlineProviderId;
    /** 官方网页登录页：桌面 UA 下才有完整的账号密码 / 扫码面板（UA 由原生侧固定）。 */
    url: string;
    /** 打开网页时显示在标题条上的名字。 */
    title: string;
    /** 读 cookie 的域：平台把登录凭据写在哪个域下（含子域）。 */
    cookieDomain: string;
    /** 出现这里面任意一个非空 cookie，就算登录凭据到了。 */
    loginCookieNames: string[];
    /** 取到的 cookie 往哪存。 */
    sink: WebLoginCookieSink;
    /** 这一家的网页登录还要用的人自己做什么（画在按钮说明里的那句话）。 */
    hintKey: string;
};

/**
 * 支持网页登录的平台。只有 iOS 壳里才有原生桥，网页版 / 桌面版自然拿不到这一项（见 nativeLoginBridge）。
 * 网易云与 QQ 音乐的网页登录是常规路径；酷狗网页版登录后 cookie 名各家版本不一，多盯两个。
 */
export const PLATFORM_WEB_LOGINS: Record<string, PlatformWebLoginSpec> = {
    netease: {
        providerId: 'netease',
        url: 'https://music.163.com/#/login',
        title: '网易云音乐',
        cookieDomain: 'music.163.com',
        // MUSIC_U 是登录凭据本体；__csrf 跟着它一起用来签 eapi/weapi。
        loginCookieNames: ['MUSIC_U'],
        sink: { kind: 'netease-jar', sessionKey: 'cookie' },
        hintKey: 'login.webLoginHintNetease',
    },
    qq: {
        providerId: 'qq',
        url: 'https://y.qq.com/',
        title: 'QQ 音乐',
        cookieDomain: 'qq.com',
        loginCookieNames: ['qm_keyst', 'qqmusic_key', 'uin'],
        sink: { kind: 'provider-session', key: 'cookie' },
        hintKey: 'login.webLoginHintQq',
    },
    kugou: {
        providerId: 'kugou',
        url: 'https://www.kugou.com/',
        title: '酷狗音乐',
        cookieDomain: 'kugou.com',
        loginCookieNames: ['KuGoo', 'token', 'userid'],
        sink: { kind: 'provider-session', key: 'cookie' },
        hintKey: 'login.webLoginHintKugou',
    },
};

/** 这个平台有没有网页登录这一条路（与当前环境有没有原生桥无关）。 */
export const platformWebLogin = (providerId: OnlineProviderId | null | undefined): PlatformWebLoginSpec | null => (
    providerId ? PLATFORM_WEB_LOGINS[providerId] ?? null : null
);
