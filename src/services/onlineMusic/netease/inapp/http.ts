// How the in-app channel reaches NetEase from the phone.
//
// fetch cannot be used: music.163.com sends no Access-Control-Allow-Origin, so WebKit refuses the
// request from the app's own origin (capacitor://localhost) before a byte leaves. CapacitorHttp makes
// the request outside the WebView, where there is no origin to be refused — and, unlike fetch, its
// response carries the Set-Cookie headers, which is exactly what the login needs.
type NativeResponse = {
    status?: number;
    data?: unknown;
    headers?: Record<string, unknown>;
    url?: string;
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

/** Whether this build can make requests the WebView would otherwise refuse (a real phone). */
export const canUseNativeHttp = async () => Boolean(await httpPlugin());

export interface NativeTextResponse {
    status: number;
    body: string;
    headers: Record<string, unknown>;
}

const asText = (value: unknown) => {
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

/**
 * POSTs an `application/x-www-form-urlencoded` body through the native plugin.
 * Throws when there is no plugin: a fetch fallback would be refused by WebKit anyway, so the caller
 * should surface a network failure instead of pretending it tried.
 */
export const nativeFormPost = async (
    url: string,
    headers: Record<string, string>,
    form: string,
): Promise<NativeTextResponse> => {
    const plugin = await httpPlugin();
    if (!plugin) {
        throw new Error('no native HTTP plugin available for the in-app NetEase channel');
    }
    const response = await plugin.request({
        url,
        method: 'POST',
        headers,
        // A string body is sent as-is; an object would be serialised as JSON by the plugin.
        data: form,
        responseType: 'text',
        connectTimeout: 15000,
        readTimeout: 20000,
    });
    return {
        status: typeof response.status === 'number' ? response.status : 0,
        body: asText(response.data),
        headers: response.headers && typeof response.headers === 'object' ? response.headers : {},
    };
};

/** The Set-Cookie value of a response, whichever casing the plugin used. */
export const setCookieOf = (headers: Record<string, unknown>): unknown => {
    const key = Object.keys(headers).find(name => name.toLowerCase() === 'set-cookie');
    return key ? headers[key] : undefined;
};
