// src/services/playbackRecovery/nativeAudioProxy.ts
//
// Playing an address the WebView refuses.
//
// In the phone container the page is served from `capacitor://localhost`, which WebKit treats as a
// secure context: an `<audio>` element there is not allowed to load `http://…`, and it does not
// matter what ATS allows (NSAllowsArbitraryLoads only governs native requests, not mixed content in
// a secure page). Sources imported from the LX collection hand out plain `http://` addresses, so
// those songs failed with MEDIA_ERR_SRC_NOT_SUPPORTED (code 4 / NotSupportedError code 9) while the
// same address answers fine outside the app.
//
// The road taken here asks the native HTTP plugin (CapacitorHttp, which runs outside the WebView)
// for the bytes and plays them from a `blob:` URL, which the page may always load. This goes for
// https just as much as for plain http: the decks carry `crossOrigin="anonymous"`, so an https file
// from a host that sends no Access-Control-Allow-Origin is refused by WebKit - and a host that
// answers audio without CORS headers is the common case for every source here. That refusal is what
// a track that loads for ever without a sound or an error actually was.
//
// Where the container has no bridge to ask, the plugin is asked for once more from the top, and the
// page's own `fetch` is the last resort - a fetch that cannot read the file in a secure page says so
// in the log instead of handing the element an address that will never sound.
//
// An address that could not be had this way is *remembered as refused*, so the chain that asks for
// an address never hands the same one out twice: the play moves on to another source or another
// level instead of retrying a dead link (the logs had one dead address retried a dozen times).

export interface NativeAudioBytes {
    bytes: Uint8Array;
    contentType: string;
    status: number;
}

interface HttpPlugin {
    request: (options: Record<string, unknown>) => Promise<{
        status?: number;
        data?: unknown;
        headers?: Record<string, string>;
    }>;
}

interface NativePromisePlugin {
    request?: (options: Record<string, unknown>) => Promise<{
        status?: number;
        data?: unknown;
        headers?: Record<string, string>;
    }>;
}

/**
 * The plugin object Capacitor keeps for registered plugins, looked up straight off the injected
 * runtime. CapacitorHttp is a core plugin, so `window.Capacitor.Plugins.CapacitorHttp` is there in
 * every native container - but the iOS 8 runtime only fills that table lazily, so an early call can
 * find it empty. Asking the native side to load the plugin by name fills it.
 */
const runtimeHttpPlugin = (): HttpPlugin | null => {
    const capacitor = (globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
    const direct = capacitor?.Plugins?.CapacitorHttp as HttpPlugin | undefined;
    return direct && typeof direct.request === 'function' ? direct : null;
};

/** Asks the native side for the plugin object itself, once the lazy table has been filled. */
const loadHttpPluginNatively = async (): Promise<HttpPlugin | null> => {
    const capacitor = (globalThis as {
        Capacitor?: {
            nativePromise?: (pluginName: string, methodName: string, options?: Record<string, unknown>) => Promise<unknown>;
            Plugins?: Record<string, unknown>;
        };
    }).Capacitor;
    if (typeof capacitor?.nativePromise !== 'function') return null;
    try {
        await capacitor.nativePromise('CapacitorHttp', 'getPluginVersion');
    } catch {
        // getPluginVersion is only the cheapest call that makes the runtime build the plugin object;
        // whether it answered does not matter, what it left behind does.
    }
    const plugin = capacitor?.Plugins?.CapacitorHttp as HttpPlugin | undefined;
    return plugin && typeof plugin.request === 'function' ? plugin : null;
};

// One lookup per session: the plugin either is there or it is not, and every play asks.
let httpPlugin: HttpPlugin | null | undefined;

const nativeHttp = async (): Promise<HttpPlugin | null> => {
    if (httpPlugin !== undefined) return httpPlugin;
    httpPlugin = runtimeHttpPlugin();
    if (httpPlugin) {
        console.log('[AudioProxy] native http plugin found in the injected runtime');
        return httpPlugin;
    }
    httpPlugin = await loadHttpPluginNatively();
    if (httpPlugin) {
        console.log('[AudioProxy] native http plugin loaded by name');
        return httpPlugin;
    }
    try {
        // Named through a variable so a build without @capacitor/core resolves nothing at build time.
        const name = '@capacitor/core';
        const mod = await import(/* @vite-ignore */ name) as { CapacitorHttp?: HttpPlugin };
        const plugin = mod.CapacitorHttp;
        httpPlugin = plugin && typeof plugin.request === 'function' ? plugin : null;
    } catch {
        httpPlugin = null;
    }
    console.log(`[AudioProxy] native http plugin ${httpPlugin ? 'available through @capacitor/core' : 'NOT available'}`);
    return httpPlugin;
};

/** true in the container that can fetch for the page: what a play may be rescued with. */
export const hasNativeHttp = async (): Promise<boolean> => Boolean(await nativeHttp());

/**
 * A bridge that was not there the first time is asked for again, from the top: the injected runtime
 * fills `Capacitor.Plugins` lazily and the first ask can happen before the container has registered
 * the core plugin (an early play, a cold start). Nothing is allowed to be concluded from that one
 * empty table, so the cached answer is dropped and the three ways of finding the plugin are walked
 * again. Where that still answers nothing, the caller falls back to the page's own fetch.
 */
const reaskNativeHttp = async (): Promise<HttpPlugin | null> => {
    const capacitor = (globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
    console.warn(`[AudioProxy] no-bridge: asking the container again (window.Capacitor=${capacitor ? (capacitor.Plugins ? 'Plugins present' : 'no Plugins') : 'absent'})`);
    httpPlugin = undefined;
    const plugin = await nativeHttp();
    if (plugin) console.log('[AudioProxy] no-bridge: the bridge answered on the second ask');
    return plugin;
};

const AUDIO_HEADERS = {
    // Some sources answer only to a browser-like ask; the container's own UA is not one they know.
    Accept: 'audio/*, */*',
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

const base64ToBytes = (value: string): Uint8Array => {
    const clean = value.replace(/^data:[^,]*,/u, '').replace(/\s/gu, '');
    const binary = globalThis.atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
};

const bytesOf = (data: unknown): Uint8Array => {
    if (typeof data === 'string') return base64ToBytes(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new Error('the native answer carried no bytes');
};

const headerOf = (headers: Record<string, string> | undefined, name: string): string => {
    if (!headers) return '';
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) return String(value ?? '');
    }
    return '';
};

/** An audio type from the answer's own Content-Type, or the one the address implies. */
const audioTypeOf = (address: string, headers: Record<string, string> | undefined): string => {
    const said = headerOf(headers, 'content-type').split(';')[0].trim().toLowerCase();
    if (said.startsWith('audio/')) return said;
    if (said === 'application/octet-stream' || said === 'binary/octet-stream') {
        const guess = ((/\.(mp3|flac|m4a|aac|ogg|opus|wav)(?:$|\?)/iu.exec(address)?.[1]) ?? '').toLowerCase();
        if (guess) return `audio/${guess === 'flac' ? 'flac' : guess}`;
        return '';
    }
    return said.startsWith('text/') || said === 'application/json' ? `refused:${said}` : '';
};

const AUDIO_TIMEOUT_MS = 30000;

/**
 * The largest file worth turning into a blob. A lossless link answers 80MB and more, and the whole
 * file is held twice on the way (the bytes, then the blob of them), which is how a phone runs out of
 * memory in the middle of a song. Past this size the address is refused *with a reason* - so the
 * chain tries another level instead of the element spinning on a file it never finishes loading.
 */
const MAX_BLOB_BYTES = 60 * 1024 * 1024;

const MAX_BLOB_MB = MAX_BLOB_BYTES / 1048576;

/** A file too large to be held as a blob: the one failure a caller is meant to act on. */
export class AudioTooLargeError extends Error {
    readonly megabytes: number;

    constructor(megabytes: number) {
        super(`file is ${megabytes.toFixed(1)}MB, over the ${MAX_BLOB_MB}MB blob limit`);
        this.name = 'AudioTooLargeError';
        this.megabytes = megabytes;
    }
}

/** Reads a whole audio file through the native bridge. Throws where the answer is not audio: a
 * source that answers an error page with 200 must not be played as if it were the song.
 */
export const fetchAudioBytes = async (
    address: string,
    headers: Record<string, string> = {},
): Promise<NativeAudioBytes> => {
    const plugin = await nativeHttp();
    if (!plugin) throw new Error('no native bridge');
    const answer = await plugin.request({
        url: address,
        method: 'GET',
        headers: { ...AUDIO_HEADERS, ...headers },
        responseType: 'arraybuffer',
        connectTimeout: AUDIO_TIMEOUT_MS,
        readTimeout: AUDIO_TIMEOUT_MS,
    });
    const status = typeof answer.status === 'number' ? answer.status : 0;
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    const contentType = audioTypeOf(address, answer.headers);
    if (contentType.startsWith('refused:')) {
        throw new Error(`the address answered ${contentType.slice(8)} instead of audio`);
    }
    // A declared size that is already too large saves the download: the plugin would hold the whole
    // file in memory before the caller ever sees it.
    const declared = Number(headerOf(answer.headers, 'content-length'));
    if (Number.isFinite(declared) && declared > MAX_BLOB_BYTES) {
        throw new AudioTooLargeError(declared / 1048576);
    }
    const bytes = bytesOf(answer.data);
    if (!bytes.byteLength) throw new Error('the address answered no bytes');
    if (bytes.byteLength > MAX_BLOB_BYTES) throw new AudioTooLargeError(bytes.byteLength / 1048576);
    return { bytes, contentType, status };
};

/**
 * The page's own `fetch`, for a container with no bridge to ask at all. In the secure page the shell
 * is served from, a cross-origin https file that carries no CORS headers cannot be read here - which
 * is exactly the case worth *logging* rather than passing the address on for a silent wait. A read
 * that succeeds gives the same blob the bridge would have.
 */
const fetchAudioBytesInPage = async (
    address: string,
    headers: Record<string, string> = {},
): Promise<NativeAudioBytes> => {
    const response = await fetch(address, {
        method: 'GET',
        headers: { ...AUDIO_HEADERS, ...headers },
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
    });
    if (!response.ok) throw new Error(`web fetch HTTP ${response.status}`);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });
    const contentType = audioTypeOf(address, responseHeaders);
    if (contentType.startsWith('refused:')) {
        throw new Error(`the address answered ${contentType.slice(8)} instead of audio`);
    }
    const declared = Number(responseHeaders['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BLOB_BYTES) {
        throw new AudioTooLargeError(declared / 1048576);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength) throw new Error('the address answered no bytes');
    if (bytes.byteLength > MAX_BLOB_BYTES) throw new AudioTooLargeError(bytes.byteLength / 1048576);
    return { bytes, contentType, status: response.status };
};

// ---- the addresses this session found unplayable -----------------------------------------------

const refused = new Set<string>();

/** The identity of an address for the purpose of "this one already failed": host, path and level. */
export const audioSourceKey = (address: string | null | undefined): string | null => {
    if (!address) return null;
    try {
        const parsed = new URL(address);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return address;
        // The level is part of what an address plays: a source that refuses its lossless link may
        // well answer the same endpoint at 320k, so the two are not the same address.
        const level = parsed.searchParams.get('level') ?? parsed.searchParams.get('br') ?? '';
        return `${parsed.origin}${parsed.pathname}${level ? `?level=${level}` : ''}`;
    } catch {
        return address;
    }
};

export const isAudioSourceRefused = (address: string | null | undefined): boolean => {
    const key = audioSourceKey(address);
    return key ? refused.has(key) : false;
};

/** Records that this address could not be played, so the chain does not hand it out again. */
export const refuseAudioSource = (address: string | null | undefined): void => {
    const key = audioSourceKey(address);
    if (!key) return;
    refused.add(key);
    console.log(`[AudioProxy] ${key} will not be tried again in this session`);
    noticeProxyChange();
};

export const clearRefusedAudioSources = (): void => {
    refused.clear();
};

// ---- telling the player when an address became playable -----------------------------------------

// The element is given a source that arrives a moment later (the bytes come through the bridge), so
// whatever decides "the element is already on the current source, nothing to do" has to be told when
// the blob replaces the address it was waiting on. That is what this counter is: the player watches
// it and re-asks instead of concluding, once and for all, that the element was never handed the song.

const proxyListeners = new Set<() => void>();
let proxyTick = 0;

/** Subscribed to by the player: answers a new number every time an address became playable or died. */
export const subscribeAudioProxy = (listener: () => void): (() => void) => {
    proxyListeners.add(listener);
    return () => {
        proxyListeners.delete(listener);
    };
};

export const getAudioProxyTick = (): number => proxyTick;

const noticeProxyChange = (): void => {
    proxyTick += 1;
    for (const listener of Array.from(proxyListeners)) {
        try {
            listener();
        } catch {
            // A listener that throws must not stop the play it was told about.
        }
    }
};

// ---- the addresses turned into something the page can play ---------------------------------------

interface PlayableCopy {
    objectUrl: string;
    at: number;
    bytes: number;
}

// A copy fetched for a play is kept while the play lasts (a seek back, a replay of the same song, the
// second deck of a crossfade), so the same file is not downloaded again. Bounded: four files, 240MB.
const copies = new Map<string, PlayableCopy>();
const MAX_COPIES = 4;
const MAX_COPY_BYTES = 240 * 1024 * 1024;

const copyBytes = (): number => Array.from(copies.values()).reduce((sum, copy) => sum + copy.bytes, 0);

const forgetCopy = (key: string): void => {
    const copy = copies.get(key);
    if (!copy) return;
    copies.delete(key);
    try {
        URL.revokeObjectURL(copy.objectUrl);
    } catch {
        // A URL revoked twice is nothing to report.
    }
};

const storeCopy = (key: string, bytes: Uint8Array, contentType: string): string => {
    forgetCopy(key);
    while (copies.size >= MAX_COPIES || (copies.size && copyBytes() + bytes.byteLength > MAX_COPY_BYTES)) {
        const oldest = Array.from(copies.entries()).sort((a, b) => a[1].at - b[1].at)[0];
        if (!oldest) break;
        forgetCopy(oldest[0]);
    }
    const blob = new Blob([bytes as unknown as BlobPart], contentType ? { type: contentType } : undefined);
    const objectUrl = URL.createObjectURL(blob);
    copies.set(key, { objectUrl, at: Date.now(), bytes: bytes.byteLength });
    console.log(`[AudioProxy] fetched ${(bytes.byteLength / 1048576).toFixed(1)}MB as ${contentType || 'audio'} for ${key}`);
    noticeProxyChange();
    return objectUrl;
};

export interface PlayableAudioAddress {
    /** What the `<audio>` element is given: the address itself, or the blob of its bytes. */
    url: string;
    /** Set when the bytes were fetched and are played from memory: the caller owns revoking it. */
    blobUrl?: string;
    /** true where the native bridge was what made the address playable. */
    throughNative: boolean;
}

/**
 * The address a play may actually use, or null where it cannot be played here at all (and has been
 * remembered as refused, so the chain asks for another level instead of waiting on it again).
 *
 * Both http and https go through the bridge: inside the shell every remote file is the element's to
 * fetch with `crossOrigin="anonymous"`, which is the one thing these hosts do not allow. The address
 * comes back untouched only where there is nothing to fetch at all (`blob:`, `data:`, the app's own
 * origin) or where the very same file is already in hand.
 */
export const toPlayableAudioAddress = async (address: string): Promise<PlayableAudioAddress | null> => {
    const trimmed = address.trim();
    // Every address a play is about to hand to an <audio> element passes through here, so this is
    // the one line a device log needs to show that the proxy is on the play path at all.
    if (!trimmed) {
        console.log('[AudioProxy] skip: empty address');
        return null;
    }
    if (!/^https?:\/\//iu.test(trimmed)) {
        // blob:, data:, file:, capacitor://localhost: already something the page can load.
        console.log(`[AudioProxy] skip:non-http ${trimmed.slice(0, 48)}`);
        return { url: trimmed, throughNative: false };
    }
    const key = audioSourceKey(trimmed) as string;
    if (isAudioSourceRefused(trimmed)) {
        console.log(`[AudioProxy] skip:refused ${key} was already refused in this session`);
        return null;
    }
    const held = copies.get(key);
    if (held) {
        held.at = Date.now();
        console.log(`[AudioProxy] cache-hit ${key} (${(held.bytes / 1048576).toFixed(1)}MB already in hand)`);
        return { url: held.objectUrl, blobUrl: held.objectUrl, throughNative: true };
    }
    const plain = trimmed.toLowerCase().startsWith('http://');
    const why = plain
        ? 'plain http, the secure page cannot load it itself'
        : 'https through the bridge: the element carries crossOrigin=anonymous and hosts here send no CORS';
    console.log(`[AudioProxy] start ${key} (${why})`);
    // https goes through the bridge exactly like plain http does. A bridge that answered nothing the
    // first time - the lazy plugin table, a cold start - is asked for once more before the page's own
    // fetch is tried, and only a fetch that also fails leaves the address refused with its reason.
    let bridge = await hasNativeHttp();
    if (!bridge) bridge = Boolean(await reaskNativeHttp());
    if (!bridge) console.warn(`[AudioProxy] no-bridge ${key}: nothing native to ask, falling back to the page fetch`);
    try {
        const answer = bridge ? await fetchAudioBytes(trimmed) : await fetchAudioBytesInPage(trimmed);
        const objectUrl = storeCopy(key, answer.bytes, answer.contentType);
        return { url: objectUrl, blobUrl: objectUrl, throughNative: true };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const kind = error instanceof AudioTooLargeError ? 'too-large' : bridge ? 'bridge' : 'page-fetch';
        console.warn(`[AudioProxy] fail ${reason} [${kind}] for ${key}`);
        refuseAudioSource(trimmed);
        return null;
    }
};

/**
 * The blob this session already holds for an address, if any. The player asks before it concludes
 * that an element whose `src` is not the address it is playing has drifted: a `blob:` there is this
 * same song, already fetched.
 */
export const playableCopyOf = (address: string | null | undefined): string | null => {
    const key = audioSourceKey(address);
    if (!key) return null;
    return copies.get(key)?.objectUrl ?? null;
};

/** Whether an element's `src` is this address, either as it came or as the blob fetched for it. */
export const isHoldingAudioAddress = (elementSrc: string | null | undefined, address: string | null | undefined): boolean => {
    if (!elementSrc) return false;
    if (elementSrc === address) return true;
    return Boolean(address) && playableCopyOf(address) === elementSrc;
};

/** Drops every copy held in memory (a new session, or the listener asked to start over). */
export const releaseNativeAudioCopies = (): void => {
    for (const key of Array.from(copies.keys())) forgetCopy(key);
};

/** What a byte range of a remote address came back with, through the native bridge. */
export interface NativeAudioRange {
    status: number;
    bytes: ArrayBuffer;
}

/**
 * Reads a byte range of a remote address natively: what a measuring read needs from a file the page
 * cannot fetch. The status is handed back as it came, because a server that ignores `Range` answers
 * 200 with the whole file - a caller that asked for the first 512KB has to know which it got.
 */
export const fetchAudioRange = async (
    address: string,
    start: number,
    end: number,
): Promise<NativeAudioRange | null> => {
    const plugin = await nativeHttp();
    if (!plugin) return null;
    try {
        const answer = await plugin.request({
            url: address,
            method: 'GET',
            headers: { ...AUDIO_HEADERS, Range: `bytes=${start}-${end - 1}` },
            responseType: 'arraybuffer',
            connectTimeout: AUDIO_TIMEOUT_MS,
            readTimeout: AUDIO_TIMEOUT_MS,
        });
        const bytes = bytesOf(answer.data);
        return {
            status: typeof answer.status === 'number' ? answer.status : 0,
            bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        };
    } catch {
        return null;
    }
};
