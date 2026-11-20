// src/mods/web/capacitorCoreStub.ts
// 非 iOS 壳构建里 @capacitor/core 的替身（见 vite.config.ts 的 resolve.alias）。
//
// 这里不是"假装有原生桥"：isNativePlatform 恒为 false、registerPlugin 回的插件每个办法都 reject，
// 于是 services/onlineMusic/webLogin/nativeLoginBridge.ts 在网页版和桌面版里拿不到桥，
// 「网页登录」这一项就不出现在界面上。

type PluginProxy = Record<string, (...args: unknown[]) => Promise<never>>;

const unavailable = (): Promise<never> => Promise.reject(new Error('capacitor-core-unavailable'));

export const Capacitor = {
    platform: 'web',
    isNativePlatform: () => false,
    isPluginAvailable: () => false,
    getPlatform: () => 'web',
    Plugins: {} as Record<string, PluginProxy>,
};

export const registerPlugin = <T>(name: string): T => new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => (typeof prop === 'string' ? unavailable : undefined),
    has: () => true,
}) as unknown as T & { __stubName?: string };

export default { Capacitor, registerPlugin };
