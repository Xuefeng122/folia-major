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
// for the bytes and plays them from a `blob:` URL, which the page may always load. Where the address
// is https, or where there is no container at all, the address is played as it came.
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

const nativeHttp = async (): Promise<HttpPlugin | null> => {
    const capacitor = (globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
    const direct = capacitor?.Plugins?.CapacitorHttp as HttpPlugin | undefined;
    if (direct && typeof direct.request === 'function') return direct;
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

/** true in the container that can fetch for the page: what a play may be rescued with. */
export const hasNativeHttp = async (): Promise<boolean> => Boolean(await nativeHttp());

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
 * Reads a whole audio file through the native bridge. Throws where the answer is not audio: a
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
    const bytes = bytesOf(answer.data);
    if (!bytes.byteLength) throw new Error('the address answered no bytes');
    return { bytes, contentType, status };
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
};

export const clearRefusedAudioSources = (): void => {
    refused.clear();
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
 * remembered as refused). `address` is returned untouched when it is not a plain-http address, when
 * there is no container, or when the very same file is already in hand.
 */
export const toPlayableAudioAddress = async (address: string): Promise<PlayableAudioAddress | null> => {
    const trimmed = address.trim();
    if (!trimmed) return null;
    if (!/^https?:\/\//iu.test(trimmed)) return { url: trimmed, throughNative: false };
    if (isAudioSourceRefused(trimmed)) return null;
    const key = audioSourceKey(trimmed) as string;
    const held = copies.get(key);
    if (held) {
        held.at = Date.now();
        return { url: held.objectUrl, blobUrl: held.objectUrl, throughNative: true };
    }
    // https plays in the page as it is: fetching it would only add a copy and a wait.
    if (trimmed.toLowerCase().startsWith('https://')) return { url: trimmed, throughNative: false };
    if (!(await hasNativeHttp())) return { url: trimmed, throughNative: false };
    try {
        const answer = await fetchAudioBytes(trimmed);
        const objectUrl = storeCopy(key, answer.bytes, answer.contentType);
        return { url: objectUrl, blobUrl: objectUrl, throughNative: true };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[AudioProxy] ${key} could not be fetched through the native bridge: ${reason}`);
        refuseAudioSource(trimmed);
        return null;
    }
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
