// src/mods/web/http.ts
// Getting the catalogue's bytes on a phone.
//
// catalog.json answers with `Access-Control-Allow-Origin: *`, but the zips under /downloads do not,
// and neither do the previews. A fetch from the app's own origin (capacitor://localhost) is then
// refused by WebKit before a byte arrives, so the desktop path cannot be reused here: the native
// CapacitorHttp plugin makes the request outside the WebView, where there is no origin to be
// refused, and hands the body back base64-encoded. Desktop and the browser build have no such
// plugin and keep using fetch.

type NativeResponse = {
    status?: number;
    data?: unknown;
};

interface HttpPlugin {
    request: (options: Record<string, unknown>) => Promise<NativeResponse>;
}

interface CapacitorGlobal {
    Plugins?: Record<string, unknown>;
    isNativePlatform?: () => boolean;
}

const httpPlugin = async (): Promise<HttpPlugin | null> => {
    const capacitor = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
    if (!capacitor) {
        return null;
    }
    const direct = capacitor.Plugins?.CapacitorHttp as HttpPlugin | undefined;
    if (direct && typeof direct.request === 'function') {
        return direct;
    }
    try {
        // Named through a variable so a build without @capacitor/core resolves nothing at build time.
        const name = '@capacitor/core';
        const mod = await import(/* @vite-ignore */ name) as { CapacitorHttp?: HttpPlugin };
        return mod.CapacitorHttp ?? null;
    } catch {
        return null;
    }
};

const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
    Object.prototype.toString.call(value) === '[object ArrayBuffer]';

const base64ToBytes = (value: string) => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
};

export interface ByteResponse {
    ok: boolean;
    status: number;
    bytes: Uint8Array;
}

/** The body of `url`, through the native HTTP plugin when the app has one, through fetch otherwise. */
export const fetchBytes = async (url: string): Promise<ByteResponse> => {
    const plugin = await httpPlugin();
    if (plugin) {
        try {
            const response = await plugin.request({
                url,
                method: 'GET',
                responseType: 'arraybuffer',
                connectTimeout: 30000,
                readTimeout: 60000,
            });
            const status = typeof response.status === 'number' ? response.status : 0;
            const data = response.data;
            let bytes = new Uint8Array(0);
            if (typeof data === 'string') {
                bytes = base64ToBytes(data);
            } else if (isArrayBuffer(data)) {
                bytes = new Uint8Array(data);
            } else if (ArrayBuffer.isView(data)) {
                bytes = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
            }
            if (status >= 200 && status < 300 && bytes.length > 0) {
                return { ok: true, status, bytes };
            }
            if (status >= 400) {
                return { ok: false, status, bytes };
            }
        } catch {
            // A plugin that is registered but not answering falls back to fetch below.
        }
    }
    const response = await fetch(url, { cache: 'no-store' });
    return { ok: response.ok, status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
};
