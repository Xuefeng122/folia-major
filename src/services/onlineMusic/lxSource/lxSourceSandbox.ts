// src/services/onlineMusic/lxSource/lxSourceSandbox.ts
// Runs one imported LX Music custom source (a `lx` script) inside the app and asks it for a play
// address. Everything the script is given lives here: the `lx` object it destructures at the top,
// the HTTP it reaches the platforms through (the app's own fetch, so a native bridge or a proxy
// in front of it applies as it does everywhere else), and the timeout that keeps a hanging script
// from holding the play.
//
// A script is ordinary code the listener imported: it is compiled as it stands, with `lx` and the
// global object handed to it. It is not saved, transformed or rewritten.

import type { LxMusicUrlRequest, LxPlatformId, LxQuality, LxSourceMeta } from './lxSourceTypes';

const REQUEST_TIMEOUT_MS = 20000;
// How long a play waits for a script that registers its handler late (after an `await`, a timer).
const HANDLER_WAIT_MS = 2500;

type LxHeaders = Record<string, string>;

type LxRequestOptions = {
    method?: string;
    headers?: LxHeaders;
    body?: unknown;
    form?: unknown;
    timeout?: number;
    responseType?: string;
};

type LxHttpAnswer = {
    statusCode: number;
    headers: LxHeaders;
    body: unknown;
};

export interface LxSourceHost {
    readonly id: string;
    readonly name: string;
    /** Whether the script registered a `request` handler: without one it cannot say where a song is. */
    readonly usable: boolean;
    /** The platforms the script named in its `inited` notice; empty where it named none. */
    readonly platforms: LxPlatformId[];
    /** The last answer the script sent the app through `lx.send` (a notice, usually), for the UI. */
    readonly lastSent: unknown;
    getMusicUrl(platform: LxPlatformId, musicInfo: Record<string, unknown>, quality: LxQuality): Promise<string | null>;
    dispose(): void;
}

export class LxSourceScriptError extends Error {
    readonly sourceName: string;
    constructor(sourceName: string, message: string) {
        super(message);
        this.name = 'LxSourceScriptError';
        this.sourceName = sourceName;
    }
}

const LX_EVENT_NAMES = {
    request: 'request',
    inited: 'inited',
    updateAlert: 'updateAlert',
} as const;

const LX_VERSION = '2.0.0';

const withTimeout = <T>(work: Promise<T>, ms: number, message: string): Promise<T> => new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
    }, ms);
    work.then(value => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
    }, error => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        reject(error);
    });
});

/** The bytes helpers a script may use to read a response it was given as binary. */
const createBufferUtils = () => {
    const toBytes = (value: unknown): Uint8Array => {
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (Array.isArray(value)) return Uint8Array.from(value as number[]);
        if (typeof value === 'string') {
            const bytes = new Uint8Array(value.length);
            for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xff;
            return bytes;
        }
        return new Uint8Array(0);
    };
    return {
        buffer: {
            bufToString: (value: unknown, format?: string): string => {
                if (typeof value === 'string') return value;
                const bytes = toBytes(value);
                if (format === 'hex') {
                    return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
                }
                let binary = '';
                bytes.forEach(byte => { binary += String.fromCharCode(byte); });
                try {
                    return globalThis.btoa(binary);
                } catch {
                    return binary;
                }
            },
            toHex: (value: unknown): string => Array.from(toBytes(value)).map(byte => byte.toString(16).padStart(2, '0')).join(''),
            fromHex: (value: string): Uint8Array => {
                const clean = value.replace(/[^0-9a-fA-F]/g, '');
                const bytes = new Uint8Array(Math.floor(clean.length / 2));
                for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
                return bytes;
            },
        },
    };
};

/**
 * The native HTTP the iOS/Android container offers. A script reaches the platforms' own hosts, which
 * answer no preflight: inside a WebView its fetch would be stopped by CORS before the request left,
 * so where the bridge is present every request goes through it instead.
 */
type NativeHttpBridge = {
    request: (options: {
        url: string;
        method: string;
        headers: LxHeaders;
        data?: unknown;
        responseType?: 'text' | 'json';
        connectTimeout?: number;
        readTimeout?: number;
    }) => Promise<{ status: number; headers?: LxHeaders; data: unknown }>;
};

const getNativeHttp = (): NativeHttpBridge | null => {
    const scope = globalThis as { Capacitor?: { Plugins?: { CapacitorHttp?: NativeHttpBridge } } };
    const bridge = scope.Capacitor?.Plugins?.CapacitorHttp;
    return bridge && typeof bridge.request === 'function' ? bridge : null;
};

const requestThroughNative = async (
    bridge: NativeHttpBridge,
    url: string,
    options: LxRequestOptions | undefined,
): Promise<LxHttpAnswer> => {
    const method = (options?.method ?? 'get').toUpperCase();
    const headers: LxHeaders = { ...(options?.headers ?? {}) };
    let data: unknown;
    if (options?.form !== undefined) {
        data = typeof options.form === 'string'
            ? options.form
            : Object.entries(options.form as Record<string, unknown>)
                .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value ?? ''))}`)
                .join('&');
        if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
    } else if (options?.body !== undefined && options.body !== null) {
        data = options.body;
        if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = 'application/json';
        }
    }
    const timeout = Number(options?.timeout) > 0 ? Number(options?.timeout) : REQUEST_TIMEOUT_MS;
    const wantsJson = options?.responseType === 'json';
    const answer = await bridge.request({
        url,
        method,
        headers,
        data,
        responseType: wantsJson ? 'json' : 'text',
        connectTimeout: timeout,
        readTimeout: timeout,
    });
    const body = wantsJson && typeof answer.data === 'string'
        ? (() => {
            try {
                return JSON.parse(answer.data);
            } catch {
                return answer.data;
            }
        })()
        : answer.data;
    return { statusCode: answer.status, headers: answer.headers ?? {}, body };
};

/** The HTTP the script asks for, made with the app's fetch so every transport rule already in place holds. */
const requestThrough = async (url: string, options: LxRequestOptions | undefined): Promise<LxHttpAnswer> => {
    const bridge = getNativeHttp();
    if (bridge) {
        try {
            return await requestThroughNative(bridge, url, options);
        } catch (error) {
            // A bridge that refuses (an unregistered plugin, a scheme it will not carry) leaves the
            // request to fetch rather than failing the script outright.
            console.warn('[LxSource] native HTTP refused the request, falling back to fetch', error);
        }
    }
    const controller = new AbortController();
    const timeout = Number(options?.timeout) > 0 ? Number(options?.timeout) : REQUEST_TIMEOUT_MS;
    const timer = globalThis.setTimeout(() => controller.abort(), timeout);
    try {
        const method = (options?.method ?? 'get').toUpperCase();
        const headers: LxHeaders = { ...(options?.headers ?? {}) };
        let body: BodyInit | undefined;
        if (options?.form !== undefined) {
            const form = options.form;
            const params = typeof form === 'string'
                ? form
                : Object.entries(form as Record<string, unknown>)
                    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value ?? ''))}`)
                    .join('&');
            body = params;
            if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
                headers['Content-Type'] = 'application/x-www-form-urlencoded';
            }
        } else if (options?.body !== undefined && options.body !== null) {
            body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
            if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
                headers['Content-Type'] = 'application/json';
            }
        }
        const response = await fetch(url, { method, headers, body, signal: controller.signal });
        const text = await response.text();
        const answerHeaders: LxHeaders = {};
        response.headers.forEach((value, key) => { answerHeaders[key] = value; });
        if (options?.responseType === 'json') {
            let parsed: unknown = text;
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = text;
            }
            return { statusCode: response.status, headers: answerHeaders, body: parsed };
        }
        return { statusCode: response.status, headers: answerHeaders, body: text };
    } finally {
        globalThis.clearTimeout(timer);
    }
};

/**
 * Compiles one script and keeps the `request` handler it registers. Compiling throws where the
 * script does not parse, or where it wants something this host does not give it (a Node module, the
 * Electron bridge): the caller shows that to the listener as the reason the source is unusable.
 */
export const createLxSourceHost = (meta: LxSourceMeta, code: string): LxSourceHost => {
    const handlers = new Map<string, (payload: unknown) => unknown>();
    // What the script says it speaks for, read off its `inited` notice: a source naming only `tx`
    // is not asked about a Netease song, and the play moves on to the next one at once.
    const platforms = new Set<LxPlatformId>();
    let lastSent: unknown = null;
    let disposed = false;

    const lx = {
        version: LX_VERSION,
        env: 'desktop',
        EVENT_NAMES: LX_EVENT_NAMES,
        currentScriptInfo: {
            name: meta.name,
            description: meta.description ?? '',
            version: meta.version ?? '',
            author: meta.author ?? '',
            homepage: meta.homepage ?? '',
        },
        on(event: string, handler: (payload: unknown) => unknown) {
            if (typeof handler === 'function') handlers.set(event, handler);
        },
        send(event: string, data: unknown) {
            lastSent = { event, data, at: Date.now() };
            if (event === LX_EVENT_NAMES.inited) {
                const sources = (data as { sources?: Record<string, unknown> } | null)?.sources;
                if (sources && typeof sources === 'object') {
                    Object.keys(sources).forEach(key => platforms.add(key as LxPlatformId));
                }
            }
            if (event === LX_EVENT_NAMES.inited || event === LX_EVENT_NAMES.updateAlert) {
                console.log(`[LxSource] ${meta.name} ${event}`, data);
            }
        },
        request(
            url: string,
            options?: LxRequestOptions,
            callback?: (error: Error | null, answer?: LxHttpAnswer) => void,
        ) {
            const answer = requestThrough(String(url), options);
            if (typeof callback === 'function') {
                answer.then(result => callback(null, result), error => callback(error as Error));
                return;
            }
            return answer;
        },
        utils: {
            ...createBufferUtils(),
        },
    };

    const globalScope = globalThis as unknown as Record<string, unknown> & { lx?: unknown };
    // The script reads `lx` from the global object: it is put there for the compile and left in
    // place, because a handler usually reaches for it long after the script's last line ran.
    globalScope.lx = lx;
    try {
        const runner = new Function('lx', 'self', 'window', code);
        runner.call(globalScope, lx, globalScope, globalScope);
    } catch (error) {
        throw new LxSourceScriptError(meta.name, error instanceof Error ? error.message : String(error));
    }

    /** Waits a short while for a handler a script registers asynchronously; null where none came. */
    const waitForHandler = async (): Promise<((payload: unknown) => unknown) | null> => {
        const deadline = Date.now() + HANDLER_WAIT_MS;
        let handler = handlers.get(LX_EVENT_NAMES.request);
        while (!handler && !disposed && Date.now() < deadline) {
            await new Promise<void>(resolve => { globalThis.setTimeout(resolve, 50); });
            handler = handlers.get(LX_EVENT_NAMES.request);
        }
        return handler ?? null;
    };

    const readUrl = (answer: unknown): string | null => {
        if (!answer) return null;
        if (typeof answer === 'string') return answer.startsWith('http') ? answer : null;
        const url = (answer as { url?: unknown }).url;
        return typeof url === 'string' && url.startsWith('http') ? url : null;
    };

    return {
        id: meta.id,
        name: meta.name,
        get usable() {
            return handlers.has(LX_EVENT_NAMES.request);
        },
        get platforms() {
            return Array.from(platforms);
        },
        get lastSent() {
            return lastSent;
        },
        async getMusicUrl(platform, musicInfo, quality) {
            if (disposed) return null;
            // A script may register its handler after an `await` or a timer, so the first play waits
            // a moment for it rather than reporting a source as unusable for being slow to start.
            const handler = await waitForHandler();
            if (!handler) {
                throw new LxSourceScriptError(meta.name, 'The script registered no request handler');
            }
            const payload: LxMusicUrlRequest = {
                source: platform,
                action: 'musicUrl',
                info: { type: quality, musicInfo },
            };
            const answer = await withTimeout(
                Promise.resolve().then(() => handler(payload)),
                REQUEST_TIMEOUT_MS,
                `${meta.name} did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`,
            );
            return readUrl(answer);
        },
        dispose() {
            disposed = true;
            handlers.clear();
        },
    };
};

/** Reads the header comment of an imported script: its name, version and the like. */
export const readLxScriptHeader = (code: string): Pick<LxSourceMeta, 'name' | 'description' | 'version' | 'author' | 'homepage'> => {
    const head = code.slice(0, 4000);
    const read = (field: string): string | undefined => {
        const match = new RegExp(`@${field}\\s+([^\\n\\r*]+)`, 'i').exec(head);
        const value = match?.[1]?.trim();
        return value ? value : undefined;
    };
    return {
        name: read('name') ?? '',
        description: read('description'),
        version: read('version'),
        author: read('author'),
        homepage: read('homepage'),
    };
};
