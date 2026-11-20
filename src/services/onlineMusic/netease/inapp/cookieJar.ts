// The cookie jar the in-app channel keeps for NetEase.
//
// Why a jar and not "just send the login cookie": NetEase hands out the anonymous device identity
// (`MUSIC_A`, `__csrf`, `NMTID`, `deviceId`) in Set-Cookie on the first response and expects it back on
// every later request. Keeping it in localStorage is what makes a scan-code login survive an app
// restart: the `MUSIC_U` cookie the login returns is stored with the rest, and the next launch sends it
// again without asking the user anything.
//
// Unlike the desktop stack the cookie is captured from the *native* HTTP response (CapacitorHttp), so
// Set-Cookie is visible even though the WebView would hide it from fetch.
const STORAGE_KEY = 'folia_inapp_netease_cookie';

export type CookieJar = Record<string, string>;

// Identity the phone client sends. `deviceId` and `buildver` are kept once generated: NetEase treats a
// changed device id as a new device, which shows up as frequent re-logins and as recommendations that
// restart from zero.
const IDENTITY_DEFAULTS: CookieJar = {
    os: 'iPhone OS',
    appver: '9.0.90',
    osver: '16.2',
    channel: 'distribution',
    resolution: '1170x2532',
    mobilename: 'iPhone14,5',
};

const randomDeviceId = () => {
    const bytes = new Uint8Array(16);
    const webCrypto = typeof crypto !== 'undefined' ? crypto : undefined;
    if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
        webCrypto.getRandomValues(bytes);
    } else {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

export const readCookieJar = (): CookieJar => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const jar: CookieJar = {};
        Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
            if (typeof value === 'string' && value) jar[key] = value;
        });
        return jar;
    } catch {
        return {};
    }
};

const writeCookieJar = (jar: CookieJar) => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(jar));
    } catch {
        // A full or blocked localStorage only costs persistence, never the request itself.
    }
};

// Fills in the identity cookies once and stores them, so every later launch sends the same device.
export const ensureIdentity = (): CookieJar => {
    const jar = readCookieJar();
    let changed = false;
    const defaults: CookieJar = {
        ...IDENTITY_DEFAULTS,
        deviceId: jar.deviceId || randomDeviceId(),
        buildver: jar.buildver || String(Math.floor(Date.now() / 1000)),
    };
    Object.entries(defaults).forEach(([key, value]) => {
        if (!jar[key]) {
            jar[key] = value;
            changed = true;
        }
    });
    if (changed) writeCookieJar(jar);
    return jar;
};

// "k=v; k2=v2" — what a Cookie header expects.
export const toCookieHeader = (jar: CookieJar) =>
    Object.entries(jar)
        .filter(([, value]) => value !== '')
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');

const applyCookiePairs = (jar: CookieJar, source: string) => {
    source.split(';').forEach(pair => {
        const text = pair.trim();
        if (!text) return;
        const separator = text.indexOf('=');
        if (separator <= 0) return;
        const key = text.slice(0, separator).trim();
        const value = text.slice(separator + 1).trim();
        // An empty value means the server cleared the cookie (logout does this).
        if (key) jar[key] = value;
    });
};

// Accepts one Set-Cookie line, several lines joined by newline or comma, or an array of them. Entries
// are split on the comma that starts a new `name=` pair, because `Expires` carries a comma of its own.
export const absorbSetCookie = (raw: unknown): CookieJar => {
    const jar = ensureIdentity();
    const collect = (value: unknown) => {
        if (typeof value !== 'string' || !value) return;
        value
            .split(/\n+/)
            .flatMap(line => line.split(/,(?=[^;,\s]+=)/))
            .forEach(line => {
                const cookiePart = line.split(';')[0];
                if (cookiePart && cookiePart.includes('=')) applyCookiePairs(jar, cookiePart);
            });
    };
    if (Array.isArray(raw)) {
        raw.forEach(collect);
    } else {
        collect(raw);
    }
    writeCookieJar(jar);
    return jar;
};

// The login flow stores "MUSIC_U=…; __csrf=…" in the app's own session storage; it is merged into the
// jar so the native channel and the rest of the app agree on who is signed in.
export const mergeCookieString = (cookieString: string | null | undefined): CookieJar => {
    const jar = ensureIdentity();
    if (cookieString) applyCookiePairs(jar, cookieString);
    writeCookieJar(jar);
    return jar;
};

export const snapshotCookieString = () => toCookieHeader(ensureIdentity());

export const clearCookieJar = () => {
    writeCookieJar({});
};
