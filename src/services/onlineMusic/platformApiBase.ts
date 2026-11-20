// src/services/onlineMusic/platformApiBase.ts
// The addresses of the platform APIs the builds do not carry: the NetEase API and qq-music-api.
// The desktop app starts both itself, so it never reads these. Every other build (the iOS app, the
// web build) needs them typed in once before a platform can be signed in to at all, and they are
// kept in the app's own storage so the address survives a restart.

const NETEASE_KEY = 'folia_api_base_netease';
const QQ_KEY = 'folia_api_base_qq';
const KUGOU_KEY = 'folia_api_base_kugou';

const readBase = (key: string): string => {
    if (typeof window === 'undefined') return '';
    try {
        return (window.localStorage.getItem(key) ?? '').trim().replace(/\/+$/, '');
    } catch {
        return '';
    }
};

const writeBase = (key: string, value: string): void => {
    if (typeof window === 'undefined') return;
    const trimmed = value.trim().replace(/\/+$/, '');
    try {
        if (trimmed) window.localStorage.setItem(key, trimmed);
        else window.localStorage.removeItem(key);
    } catch (error) {
        console.warn('[OnlineMusic] Failed to keep an API address', error);
    }
};

/** The NetEase API (NeteaseCloudMusicApi) the app asks, when the app does not run one itself. */
export const readNeteaseApiBase = (): string => readBase(NETEASE_KEY);

export const writeNeteaseApiBase = (value: string): void => writeBase(NETEASE_KEY, value);

/** The qq-music-api the app asks, when the app does not run one itself. */
export const readQqApiBase = (): string => readBase(QQ_KEY);

export const writeQqApiBase = (value: string): void => writeBase(QQ_KEY, value);

/** The KuGouMusicApi the app asks, when the app does not run one itself. */
export const readKugouApiBase = (): string => readBase(KUGOU_KEY);

export const writeKugouApiBase = (value: string): void => writeBase(KUGOU_KEY, value);
