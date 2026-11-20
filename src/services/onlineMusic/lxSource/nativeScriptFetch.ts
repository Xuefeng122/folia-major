// src/services/onlineMusic/lxSource/nativeScriptFetch.ts
// Reading a script or a version manifest from its address on the phone.
//
// fetch cannot be used there: an update address is another origin (gitee, a source's own host) and
// those hosts send no Access-Control-Allow-Origin, so WebKit refuses the read before a byte arrives
// and every check says "download failed". CapacitorHttp makes the request outside the WebView, where
// there is no origin to be refused. On the desktop build there is no plugin and fetch is used as it
// always was.

type NativeResponse = {
    status?: number;
    data?: unknown;
    headers?: Record<string, unknown>;
};

interface HttpPlugin {
    request: (options: Record<string, unknown>) => Promise<NativeResponse>;
}

const nativeHttp = async (): Promise<HttpPlugin | null> => {
    const capacitor = (globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
    const direct = capacitor?.Plugins?.CapacitorHttp as HttpPlugin | undefined;
    if (direct && typeof direct.request === 'function') {
        return direct;
    }
    try {
        // Named through a variable so a build without @capacitor/core resolves nothing at build time.
        const name = '@capacitor/core';
        const mod = await import(/* @vite-ignore */ name) as { CapacitorHttp?: HttpPlugin };
        const plugin = mod.CapacitorHttp;
        return plugin && typeof plugin.request === 'function' ? plugin : null;
    } catch {
        return null;
    }
};

const asText = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return '';
        }
    }
    return String(value);
};

export interface LxTextAnswer {
    text: string;
    /** Where the bytes came from: the native bridge on a phone, fetch elsewhere. */
    through: 'native' | 'fetch';
}

const FETCH_TIMEOUT_MS = 20000;

/**
 * Reads an http(s) address as text, through the native bridge where the container has one and
 * through fetch where it does not. A non-2xx answer throws: a manifest that 404s must not be read
 * as the empty script it also is.
 */
export const readLxAddressText = async (
    address: string,
    headers: Record<string, string> = {},
): Promise<LxTextAnswer> => {
    const plugin = await nativeHttp();
    if (plugin) {
        const answer = await plugin.request({
            url: address,
            method: 'GET',
            headers: { Accept: 'text/plain, application/javascript, application/json, */*', ...headers },
            responseType: 'text',
            connectTimeout: FETCH_TIMEOUT_MS,
            readTimeout: FETCH_TIMEOUT_MS,
        });
        const status = typeof answer.status === 'number' ? answer.status : 0;
        if (status < 200 || status >= 300) {
            throw new Error(`HTTP ${status}`);
        }
        const text = asText(answer.data);
        if (!text.trim()) throw new Error('地址返回了空内容');
        return { text, through: 'native' };
    }
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(address, {
            signal: controller.signal,
            headers: { Accept: 'text/plain, application/javascript, application/json, */*', ...headers },
            cache: 'no-store',
        });
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`.trim());
        }
        const text = await response.text();
        if (!text.trim()) throw new Error('地址返回了空内容');
        return { text, through: 'fetch' };
    } finally {
        globalThis.clearTimeout(timer);
    }
};

/** Whether the native bridge is here, so a caller can say which road a read will take. */
export const hasNativeScriptFetch = async (): Promise<boolean> => Boolean(await nativeHttp());
