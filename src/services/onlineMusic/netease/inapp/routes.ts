// The app's own routes, answered by NetEase itself instead of by an API server.
//
// `netease.ts` asks for the same route names a NeteaseCloudMusicApi instance serves (`/cloudsearch`,
// `/song/url/v1`, `/login/qr/key`…). On the phone there is no such server, so each of those routes is
// translated here into the request NetEase's own clients make: the path NetEase expects, its body, and
// which encryption that route wants. The mapping is taken from the API package this project already
// ships (@neteasecloudmusicapienhanced/api → module/*.js), so a route answers with the same shape the
// rest of the app already reads — that is what keeps the desktop and the phone paths interchangeable.
//
// Two kinds of request:
//   eapi  — the phone client's routes (search, playback URLs, lyrics, QR login). Sent to
//           interfacepc.music.163.com with the iOS user agent; this is also the API package's default.
//   weapi — the account and library routes (playlists, album, artist, daily recommendations). Sent to
//           music.163.com. The clientlog host serves the play log only.
import {
    NETEASE_EAPI_DOMAIN,
    NETEASE_WEB_DOMAIN,
    UA_IOS,
    UA_PC,
    buildEapiPayload,
    buildWeapiPayload,
    decryptEapiBody,
} from './crypto';
import { readProviderSessionValue } from '../../providerStorage';
import { absorbSetCookie, clearCookieJar, ensureIdentity, mergeCookieString, toCookieHeader } from './cookieJar';
import { nativeFormPost, setCookieOf } from './http';

const CLIENTLOG_DOMAIN = 'https://clientlog.music.163.com';

// Sent with playlist subscribe: NetEase's own client sends it, and the route answers 400 without it.
// It is a constant of the client, not a secret of the account (the API package ships it in config.json).
const SUBSCRIBE_CHECK_TOKEN = '9ca17ae2e6ffcda170e2e6ee8af14fbabdb988f225b3868eb2c15a879b9a83d274a790ac8ff54a97b889d5d42af0feaec3b92af58cff99c470a7eafd88f75e839a9ea7c14e909da883e83fb692a3abdb6b92adee9e';

const encodeForm = (fields: Record<string, string>) => Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

// A body is JSON, or — on eapi — a hex ciphertext of JSON. Anything else is a failure worth naming:
// a proxy's error page, a rate-limit HTML page.
const decodeAnswer = (text: string) => {
    const trimmed = (text ?? '').trim();
    if (!trimmed) throw new Error('in-app NetEase: empty answer');
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            return JSON.parse(trimmed);
        } catch {
            throw new Error(`in-app NetEase: unreadable JSON answer: ${trimmed.slice(0, 120)}`);
        }
    }
    const decrypted = decryptEapiBody(trimmed.replace(/\s+/g, ''));
    if (decrypted) {
        try {
            return JSON.parse(decrypted);
        } catch {
            // Falls through to the error below: a body that decrypts to something else is still not
            // an answer this app can read.
        }
    }
    throw new Error(`in-app NetEase: unreadable answer: ${trimmed.slice(0, 120)}`);
};

// A session cookie may already be stored: a user who signed in while pointing the app at a remote API
// base, or signed in here during an earlier launch. The jar is what actually goes out on the wire, so
// it is filled from that stored cookie once — after that the jar itself is the source of truth (it is
// persisted, and every answer may add to it).
let credentialSeeded = false;
const seedCredential = () => {
    if (credentialSeeded) return;
    credentialSeeded = true;
    const stored = readProviderSessionValue('netease', 'cookie', ['netease_cookie']);
    if (stored) mergeCookieString(stored);
};

const postEapi = async (apiPath: string, data: Record<string, unknown>, domain = NETEASE_EAPI_DOMAIN) => {
    seedCredential();
    const jar = ensureIdentity();
    const { params } = buildEapiPayload(apiPath, data);
    const response = await nativeFormPost(
        // NetEase's eapi lives under /eapi and takes the path without its leading /api.
        `${domain}/eapi/${apiPath.replace(/^\/api\//, '')}`,
        {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            'User-Agent': UA_IOS,
            Cookie: toCookieHeader(jar),
        },
        encodeForm({ params }),
    );
    // Every answer can carry a new session cookie (the anonymous identity on the first request, the
    // login cookie on the last one), so it is taken from the native response and stored right away.
    absorbSetCookie(setCookieOf(response.headers));
    return decodeAnswer(response.body);
};

const postWeapi = async (apiPath: string, data: Record<string, unknown>) => {
    seedCredential();
    const jar = ensureIdentity();
    const { params, encSecKey } = buildWeapiPayload({ ...data, csrf_token: jar.__csrf || '' });
    const response = await nativeFormPost(
        `${NETEASE_WEB_DOMAIN}/weapi/${apiPath.replace(/^\/api\//, '')}`,
        {
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            'User-Agent': UA_PC,
            Referer: NETEASE_WEB_DOMAIN,
            Cookie: toCookieHeader(jar),
        },
        encodeForm({ params, encSecKey }),
    );
    absorbSetCookie(setCookieOf(response.headers));
    return decodeAnswer(response.body);
};

const text = (query: URLSearchParams, key: string, fallback = '') => {
    const raw = query.get(key);
    return raw === null || raw === '' ? fallback : raw;
};

const integer = (query: URLSearchParams, key: string, fallback = 0) => {
    const raw = query.get(key);
    if (raw === null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
};

const list = (query: URLSearchParams, key: string) => text(query, key)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

const numberList = (query: URLSearchParams, key: string) => list(query, key)
    .map(Number)
    .filter(value => Number.isFinite(value));

type Route = (query: URLSearchParams) => Promise<unknown>;

// Song details in the batch form NetEase wants: [{"id":1},{"id":2}].
const songDetailOf = async (ids: number[]) => postEapi('/api/v3/song/detail', {
    c: JSON.stringify(ids.map(id => ({ id }))),
});

const routes: Record<string, Route> = {
    // --- Search ---
    '/cloudsearch': async (query) => postEapi('/api/cloudsearch/pc', {
        s: text(query, 'keywords'),
        type: integer(query, 'type', 1),
        limit: integer(query, 'limit', 30),
        offset: integer(query, 'offset', 0),
        total: true,
    }),

    // --- Songs ---
    '/song/url/v1': async (query) => postEapi('/api/song/enhance/player/url/v1', {
        ids: JSON.stringify(numberList(query, 'id')),
        level: text(query, 'level', 'exhigh'),
        encodeType: 'flac',
    }),

    '/song/detail': (query) => songDetailOf([...numberList(query, 'ids'), ...numberList(query, 'id')]),

    '/lyric/new': async (query) => postEapi('/api/song/lyric/v1', {
        id: integer(query, 'id'),
        lv: 0,
        kv: 0,
        tv: 0,
        rv: 0,
        cp: false,
    }),

    // The route takes one id but NetEase answers a list.
    '/song/chorus': async (query) => postEapi('/api/song/chorus', {
        ids: JSON.stringify(numberList(query, 'id')),
    }),

    '/song/copyright/rcmd': async (query) => postEapi('/api/song/copyright/rcmd', {
        songid: text(query, 'songid', text(query, 'id')),
    }),

    // --- Playlists ---
    // The whole playlist comes back in this one answer (the same 100000 NetEase's client asks for),
    // which is why `/playlist/track/all` needs nothing beyond slicing it.
    '/playlist/detail': async (query) => postEapi('/api/v6/playlist/detail', {
        id: integer(query, 'id'),
        n: 100000,
        s: integer(query, 's', 8),
    }),

    '/playlist/detail/dynamic': async (query) => postEapi('/api/playlist/detail/dynamic', {
        id: integer(query, 'id'),
        n: 100000,
        s: integer(query, 's', 8),
    }),

    '/playlist/track/all': async (query) => {
        const detail: any = await postEapi('/api/v6/playlist/detail', {
            id: integer(query, 'id'),
            n: 100000,
            s: integer(query, 's', 8),
        });
        const tracks: any[] = Array.isArray(detail?.playlist?.tracks) ? detail.playlist.tracks : [];
        // A playlist longer than the answer's own page has its tracks as ids only, so they are asked
        // for separately — the same two steps the API package's playlist_track_all takes.
        if (!tracks.length) {
            const trackIds: any[] = Array.isArray(detail?.playlist?.trackIds) ? detail.playlist.trackIds : [];
            const offset = integer(query, 'offset', 0);
            const limit = integer(query, 'limit', 1000);
            const page = trackIds.slice(offset, offset + limit)
                .map((entry: any) => Number(entry?.id))
                .filter((id: number) => Number.isFinite(id));
            if (!page.length) return { songs: [], code: 200 };
            const songs: any = await songDetailOf(page);
            return { songs: songs?.songs ?? [], privileges: songs?.privileges ?? [], code: 200 };
        }
        const offset = integer(query, 'offset', 0);
        const limit = integer(query, 'limit', 1000);
        return { songs: tracks.slice(offset, offset + limit), code: 200 };
    },

    '/playlist/tracks': async (query) => postEapi('/api/playlist/manipulate/tracks', {
        op: text(query, 'op'),
        pid: text(query, 'pid'),
        trackIds: JSON.stringify(list(query, 'tracks')),
        imme: 'true',
    }),

    '/playlist/subscribe': async (query) => {
        const subscribe = text(query, 't', '1') === '1';
        return postEapi(`/api/playlist/${subscribe ? 'subscribe' : 'unsubscribe'}`, {
            id: integer(query, 'id'),
            ...(subscribe ? { checkToken: SUBSCRIBE_CHECK_TOKEN } : {}),
        });
    },

    '/top/playlist': async (query) => postWeapi('/api/playlist/list', {
        cat: text(query, 'cat', '全部'),
        order: text(query, 'order', 'hot'),
        limit: integer(query, 'limit', 50),
        offset: integer(query, 'offset', 0),
        total: true,
    }),

    '/personalized': async (query) => postWeapi('/api/personalized/playlist', {
        limit: integer(query, 'limit', 30),
        total: true,
        n: 1000,
    }),

    // --- Albums ---
    '/album': async (query) => postWeapi(`/api/v1/album/${integer(query, 'id')}`, {}),

    '/album/new': async (query) => postWeapi('/api/album/new', {
        limit: integer(query, 'limit', 30),
        offset: integer(query, 'offset', 0),
        total: true,
        area: text(query, 'area', 'ALL'),
    }),

    '/album/sublist': async (query) => postWeapi('/api/album/sublist', {
        limit: integer(query, 'limit', 25),
        offset: integer(query, 'offset', 0),
        total: true,
    }),

    '/album/sub': async (query) => postWeapi(`/api/album/${text(query, 't', '1') === '1' ? 'sub' : 'unsub'}`, {
        id: integer(query, 'id'),
    }),

    '/album/detail/dynamic': async (query) => postWeapi('/api/album/detail/dynamic', {
        id: integer(query, 'id'),
    }),

    // --- Artists ---
    '/artist/detail': async (query) => postEapi('/api/artist/head/info/get', {
        id: integer(query, 'id'),
    }),

    '/artist/album': async (query) => postWeapi(`/api/artist/albums/${integer(query, 'id')}`, {
        limit: integer(query, 'limit', 30),
        offset: integer(query, 'offset', 0),
        total: true,
    }),

    '/artist/songs': async (query) => postEapi('/api/v1/artist/songs', {
        id: integer(query, 'id'),
        private_cloud: 'true',
        work_type: 1,
        order: text(query, 'order', 'hot'),
        offset: integer(query, 'offset', 0),
        limit: integer(query, 'limit', 100),
    }),

    '/artist/top/song': async (query) => postWeapi('/api/artist/top/song', {
        id: integer(query, 'id'),
    }),

    '/simi/song': async (query) => postWeapi('/api/v1/discovery/simiSong', {
        songid: integer(query, 'id'),
        limit: integer(query, 'limit', 50),
        offset: integer(query, 'offset', 0),
    }),

    // --- Charts and new releases ---
    '/toplist': async () => postEapi('/api/toplist', {}),

    '/top/song': async (query) => postWeapi('/api/v1/discovery/new/songs', {
        areaId: integer(query, 'type', 0),
        total: true,
    }),

    // --- Account and library ---
    '/login/status': async () => {
        const answer: any = await postWeapi('/api/w/nuser/account/get', {});
        return { data: { ...answer }, code: answer?.code ?? 200 };
    },

    '/user/account': async () => {
        const answer: any = await postWeapi('/api/nuser/account/get', {});
        return {
            code: answer?.code ?? 200,
            account: answer?.account ?? null,
            profile: answer?.profile ?? null,
        };
    },

    '/user/playlist': async (query) => postWeapi('/api/user/playlist', {
        uid: integer(query, 'uid'),
        limit: integer(query, 'limit', 1000),
        offset: integer(query, 'offset', 0),
        includeVideo: true,
    }),

    '/likelist': async (query) => postEapi('/api/song/like/get', {
        uid: integer(query, 'uid'),
    }),

    '/like': async (query) => postWeapi('/api/radio/like', {
        alg: 'itembased',
        trackId: integer(query, 'id'),
        like: text(query, 'like', 'true') !== 'false',
        time: '3',
    }),

    '/user/record': async (query) => postWeapi('/api/v1/play/record', {
        uid: integer(query, 'uid'),
        type: integer(query, 'type', 0),
    }),

    '/user/cloud': async (query) => postWeapi('/api/v1/cloud/get', {
        limit: integer(query, 'limit', 30),
        offset: integer(query, 'offset', 0),
    }),

    '/user/cloud/detail': async (query) => postWeapi('/api/v1/cloud/get/byids', {
        songIds: list(query, 'id'),
    }),

    '/cloud/lyric/get': async (query) => postEapi('/api/cloud/lyric/get', {
        userId: integer(query, 'uid'),
        songId: integer(query, 'sid'),
        lv: -1,
        kv: -1,
    }),

    // --- Sign-in ---
    '/login/qr/key': async () => {
        const answer: any = await postEapi('/api/login/qrcode/unikey', { type: 3 });
        return { data: { ...answer, code: 200 }, code: 200 };
    },

    // The QR code itself is drawn from the key, so nothing is asked of NetEase here.
    '/login/qr/create': async (query) => {
        const key = text(query, 'key');
        return { code: 200, data: { qrurl: `https://music.163.com/login?codekey=${key}`, qrimg: '' } };
    },

    // NetEase's answer carries the session cookies; they are already in the jar (see postEapi) and
    // handed back as a cookie string, which is the field the sign-in code stores.
    '/login/qr/check': async (query) => {
        const answer: any = await postEapi('/api/login/qrcode/client/login', {
            key: text(query, 'key'),
            type: 3,
        });
        return { ...answer, cookie: toCookieHeader(ensureIdentity()) };
    },

    '/logout': async () => {
        try {
            await postEapi('/api/logout', {});
        } finally {
            // Dropping the jar is what signs out here: the session lives in its cookies, and NetEase
            // treats the next request as a fresh device.
            clearCookieJar();
        }
        return { code: 200 };
    },

    // The anonymous identity is the jar itself; nothing is registered with NetEase up front, the
    // first eapi answer hands out the cookies (`MUSIC_A`, `__csrf`).
    '/register/anonimous': async () => ({ code: 200, cookie: toCookieHeader(ensureIdentity()) }),

    // --- Radio ---
    '/personal_fm': async () => postWeapi('/api/v1/radio/get', {}),

    '/personal/fm/mode': async (query) => postEapi('/api/v1/radio/get', {
        mode: text(query, 'mode'),
        subMode: text(query, 'submode'),
        limit: 3,
    }),

    '/fm_trash': async (query) => postWeapi('/api/radio/trash/add', {
        songId: integer(query, 'id'),
        alg: 'RT',
        time: 25,
    }),

    // --- Recommendations ---
    '/recommend/songs': async (query) => postWeapi('/api/v3/discovery/recommend/songs', {
        afresh: text(query, 'afresh') === 'true',
    }),

    '/recommend/songs/dislike': async (query) => postWeapi('/api/v2/discovery/recommend/dislike', {
        resId: integer(query, 'id'),
        resType: 4,
        sceneType: 1,
    }),

    '/history/recommend/songs': async () => postWeapi('/api/discovery/recommend/songs/history/recent', {}),

    '/history/recommend/songs/detail': async (query) => postWeapi('/api/discovery/recommend/songs/history/detail', {
        date: text(query, 'date'),
    }),

    '/recommend/resource': async () => postWeapi('/api/v1/discovery/recommend/resource', {}),

    '/homepage/block/page': async (query) => postWeapi('/api/homepage/block/page', {
        refresh: text(query, 'refresh') === 'true',
        cursor: text(query, 'cursor'),
    }),

    // NetEase's daily-song style picker (`/recommend/category/*`) is served by the xeapi variant of the
    // API package, which signs its requests with a second scheme (an X25519-derived secret and an
    // HMAC signature). It is deliberately not replicated here: the section shows its own empty state
    // instead of failing, and a user with a remote API base keeps the feature there.
    '/recommend/category/configs': async () => ({ code: 200, data: { categoryList: [] } }),
    '/recommend/category/songs': async () => ({ code: 200, data: { dailySongs: [], privileges: [] } }),
    '/recommend/category/set': async () => ({ code: 200, data: { saveSuccess: false } }),

    // The play log is written through NetEase's log endpoint (`/api/feedback/weblog`), whose body is a
    // nested client-event structure. Not sending it only costs the account's listening history; the
    // player treats the answer as "logged", the same as a NeteaseCloudMusicApi instance that has the
    // log disabled.
    '/scrobble/v1': async () => ({ code: 200 }),
};

/** Whether this endpoint is one the in-app channel can answer. */
export const hasInAppRoute = (endpoint: string) => Boolean(routes[endpoint.split('?')[0]]);

/**
 * Answers one of the app's own route names (`/cloudsearch?keywords=…`) from NetEase directly.
 * Throws for a route that was never mapped, so a missing piece shows up as itself instead of as a
 * silently empty page.
 */
export const requestInAppEndpoint = async (endpoint: string) => {
    const [path, queryString = ''] = endpoint.split('?');
    const route = routes[path];
    if (!route) {
        throw Object.assign(new Error(`in-app NetEase: no route for ${path}`), {
            code: 'NETEASE_INAPP_ROUTE_MISSING',
        });
    }
    return route(new URLSearchParams(queryString));
};

// Kept for the diagnostics panel: which host the in-app channel talks to.
export const INAPP_HOSTS = {
    eapi: NETEASE_EAPI_DOMAIN,
    web: NETEASE_WEB_DOMAIN,
    clientlog: CLIENTLOG_DOMAIN,
};
