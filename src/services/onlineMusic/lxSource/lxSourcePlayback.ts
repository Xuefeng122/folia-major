// src/services/onlineMusic/lxSource/lxSourcePlayback.ts
// Switches a play that its own platform could not hand an address for through the imported LX
// sources, in the order the listener set. The first source that answers with a playable address
// wins, which is what makes a source list a fallback chain rather than a pile of scripts.

import type { AudioQualityPreference, OnlineProviderId } from '../../../types/onlineMusic';
import type { SongResult, UnifiedSong } from '../../../types';
import { getOnlineProviderIdForSong } from '../../../utils/appPlaybackGuards';
import { setStatusMessage } from '../../../stores/useStatusMessageStore';
import i18n from '../../../i18n/config';
import { clearLxVersionGateReports, createLxSourceHost, lxVersionGateReport, type LxSourceHost } from './lxSourceSandbox';
import { enabledLxSources, useLxSourceStore } from './lxSourceStore';
import type { LxPlatformId, LxQuality, LxSearchRow, LxSourceMeta } from './lxSourceTypes';

/** Which LX platform name stands for each of our providers. The rest have no LX equivalent. */
const PLATFORM_BY_PROVIDER: Record<string, LxPlatformId> = {
    netease: 'wy',
    qq: 'tx',
    kugou: 'kg',
};

const QUALITY_BY_PREFERENCE: Record<AudioQualityPreference, LxQuality> = {
    standard: '128k',
    high: '320k',
    ultra: '320k',
    lossless: 'flac',
    hires: 'flac24bit',
};

// One compiled script per source, kept for the session: compiling a big one takes a moment, and a
// play may ask the same source again a minute later.
const hosts = new Map<string, LxSourceHost>();
const brokenHosts = new Map<string, string>();

export const lxPlatformForSong = (song: SongResult): LxPlatformId | null => {
    const providerId = getOnlineProviderIdForSong(song);
    if (!providerId) return null;
    return PLATFORM_BY_PROVIDER[providerId] ?? null;
};

/** The LX name of a provider's platform, for a caller that has the provider id but no song. */
export const lxPlatformForProvider = (providerId: OnlineProviderId | null): LxPlatformId | null => (
    providerId ? PLATFORM_BY_PROVIDER[providerId] ?? null : null
);

/** The provider a source's platform name belongs to, for turning a row it found into a song. */
export const PROVIDER_BY_LX_PLATFORM: Partial<Record<LxPlatformId, OnlineProviderId>> =
    Object.entries(PLATFORM_BY_PROVIDER).reduce<Partial<Record<LxPlatformId, OnlineProviderId>>>(
        (byLxName, [providerId, lxName]) => {
            byLxName[lxName] = providerId as OnlineProviderId;
            return byLxName;
        },
        {},
    );

// Which source last handed out an address for a song, kept across starts: the source that worked is
// asked first the next time, and the rest stay behind it as the fallback chain.
const PREFERRED_KEY = 'folia_lx_preferred_source_v1';
const PREFERRED_LIMIT = 800;

const readPreferred = (): Record<string, string> => {
    if (typeof window === 'undefined') return {};
    try {
        const raw = window.localStorage.getItem(PREFERRED_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
    } catch {
        return {};
    }
};

const preferredKeyOf = (song: SongResult): string => {
    const platform = lxPlatformForSong(song);
    return platform ? `${platform}:${String(song.id)}` : '';
};

/** The source that worked for this song last time, where it is still imported and switched on. */
export const preferredLxSourceFor = (song: SongResult): string | null => {
    const key = preferredKeyOf(song);
    if (!key) return null;
    const sources = useLxSourceStore.getState().sources;
    const enabled = (id: string | null | undefined): boolean => Boolean(
        id && sources.some(source => source.id === id && source.enabled),
    );
    // A row the sources themselves answered names its source, and that one is asked before any
    // earlier memory: it is the source that actually has this song, not merely one that once did.
    const fromRow = (song as UnifiedSong).lxSourceId;
    if (enabled(fromRow)) return fromRow as string;
    const id = readPreferred()[key];
    if (!id) return null;
    return enabled(id) ? id : null;
};

const rememberPreferred = (song: SongResult, sourceId: string): void => {
    const key = preferredKeyOf(song);
    if (!key || typeof window === 'undefined') return;
    try {
        const map = readPreferred();
        map[key] = sourceId;
        const keys = Object.keys(map);
        // The map is a hint, not a history: once it is long, the oldest entries are dropped.
        if (keys.length > PREFERRED_LIMIT) {
            keys.slice(0, keys.length - PREFERRED_LIMIT).forEach(stale => { delete map[stale]; });
        }
        window.localStorage.setItem(PREFERRED_KEY, JSON.stringify(map));
    } catch (error) {
        console.warn('[LxSource] Could not record which source worked', error);
    }
};

/** What a script is told about the song; every platform names its ids differently, so all are given. */
const buildMusicInfo = (song: SongResult, platform: LxPlatformId): Record<string, unknown> => {
    const id = String(song.id);
    const singer = (song.artists ?? []).map(artist => artist.name).join('、');
    const info: Record<string, unknown> = {
        songmid: id,
        musicId: id,
        id,
        songId: id,
        hash: id,
        name: song.name,
        songname: song.name,
        singer,
        singerName: singer,
        interval: Math.round((song.durationMs ?? 0) / 1000),
        albumName: song.album?.name ?? '',
        albumId: song.album?.id ?? '',
        source: platform,
    };
    if (platform === 'tx') {
        info.songmid = song.qqMid ?? id;
        info.strMediaMid = song.qqMid ?? id;
        info.media_mid = song.qqMid ?? id;
    }
    if (platform === 'kg') {
        info.hash = song.kgHash ?? id;
        info.album_id = song.album?.id ?? '';
    }
    return info;
};

const readHost = async (meta: LxSourceMeta): Promise<LxSourceHost | null> => {
    const kept = hosts.get(meta.id);
    if (kept) return kept;
    const broken = brokenHosts.get(meta.id);
    if (broken) return null;
    const code = await useLxSourceStore.getState().readScript(meta.id);
    if (!code) {
        brokenHosts.set(meta.id, 'The script is missing from the store');
        return null;
    }
    try {
        const host = createLxSourceHost(meta, code);
        if (!host.usable) {
            brokenHosts.set(meta.id, 'The script registered no request handler');
            return null;
        }
        hosts.set(meta.id, host);
        return host;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[LxSource] ${meta.name} could not be loaded: ${message}`);
        brokenHosts.set(meta.id, message);
        return null;
    }
};

/** Why a source could not be loaded, for the settings page; null where it loaded fine. */
export const lxSourceLoadError = (id: string): string | null => brokenHosts.get(id) ?? null;

/**
 * What the version gate answered for a source, for the settings row: a source that had to be let
 * past its own "a newer release exists" check works, but the listener should still see that a newer
 * script is out there. Null where no check was answered.
 */
export const lxSourceGateNotice = (id: string): string | null => {
    const report = lxVersionGateReport(id);
    if (!report) return null;
    return report.localVersion || 'unknown';
};

/** Forgets the compiled scripts, so the next play compiles them again (after an import or a removal). */
export const resetLxSourceHosts = (): void => {
    hosts.forEach(host => host.dispose());
    hosts.clear();
    brokenHosts.clear();
    // A replaced script is judged afresh: whether its own check still needs letting through is
    // decided by the script that runs next, not by the one that ran before.
    clearLxVersionGateReports();
};

/** The levels tried after the one asked for, best first: a play that cannot be had at the level the
 * listener chose is still better as a lower level than as silence. */
const QUALITY_CHAIN: Record<LxQuality, LxQuality[]> = {
    flac24bit: ['flac24bit', 'flac', '320k', '128k'],
    flac: ['flac', '320k', '128k'],
    '320k': ['320k', '128k'],
    '128k': ['128k'],
};

/** Which levels a play asks for, in order: the one the setting means, then the ones below it. */
const levelsFor = (quality: AudioQualityPreference): LxQuality[] => {
    const asked = QUALITY_BY_PREFERENCE[quality] ?? '320k';
    return QUALITY_CHAIN[asked] ?? [asked];
};

/**
 * Asks every enabled source that speaks for this song's platform, in order, for a play address.
 * Each source is asked at the level the setting means first, then at the levels below it: a source
 * that has the song only in 128k still plays it instead of the play failing (the listener is told
 * that the level dropped). Answers null where none of them had one: the caller then reports the
 * failure it already has, and may go on to another source's copy of the same song.
 */
export const resolveLxSourceUrl = async (
    song: SongResult,
    quality: AudioQualityPreference,
): Promise<string | null> => {
    const platform = lxPlatformForSong(song);
    if (!platform) return null;
    const sources = enabledLxSources();
    if (!sources.length) return null;
    const musicInfo = buildMusicInfo(song, platform);
    const levels = levelsFor(quality);
    // The source that supplied this song last time goes first; the listener's order is kept behind it,
    // so a source that stops answering still falls through to the next one.
    const preferredId = preferredLxSourceFor(song);
    const ordered = preferredId
        ? [...sources].sort((a, b) => (a.id === preferredId ? -1 : b.id === preferredId ? 1 : a.order - b.order))
        : sources;
    const tried: string[] = [];
    for (const level of levels) {
        for (const meta of ordered) {
            const host = await readHost(meta);
            if (!host) {
                useLxSourceStore.getState().noteResult(meta.id, { ok: false, error: brokenHosts.get(meta.id) });
                continue;
            }
            // What the script itself says it speaks for outranks what its text looked like it mentioned:
            // a source that named other platforms is passed over without being asked.
            const spoken = host.platforms;
            if (spoken.length && !spoken.includes(platform)) continue;
            if (!tried.includes(meta.name)) tried.push(meta.name);
            try {
                const url = await host.getMusicUrl(platform, musicInfo, level);
                if (url) {
                    useLxSourceStore.getState().noteResult(meta.id, { ok: true });
                    rememberPreferred(song, meta.id);
                    if (level !== levels[0]) {
                        // The level dropped: said out loud, together with who still had the song.
                        setStatusMessage({
                            type: 'info',
                            text: i18n.t('lxSource.qualityDowngraded', { from: levels[0], to: level }),
                            note: i18n.t('lxSource.switchedTo', { name: meta.name }),
                            durationMs: 4200,
                        });
                    } else if (tried.length > 1) {
                        // The switch between sources is said out loud: what failed is not swallowed.
                        setStatusMessage({
                            type: 'info',
                            text: i18n.t('lxSource.switchedTo', { name: meta.name }),
                            note: i18n.t('lxSource.switchedFrom', { list: tried.slice(0, -1).join(' > ') }),
                            durationMs: 4200,
                        });
                    }
                    console.log(`[LxSource] "${song.name}" played from ${meta.name} at ${level}`);
                    return url;
                }
                useLxSourceStore.getState().noteResult(meta.id, { ok: false, error: 'The script returned no address' });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                useLxSourceStore.getState().noteResult(meta.id, { ok: false, error: message });
            }
        }
    }
    if (tried.length) {
        setStatusMessage({
            type: 'error',
            text: i18n.t('lxSource.noneAnswered', { name: song.name }),
            note: i18n.t('lxSource.triedList', { list: tried.join(' > ') }),
            durationMs: 5200,
        });
    }
    return null;
};

/** What a switch to another source's copy of the same song came back with. */
export interface LxCrossSourceAnswer {
    url: string;
    /** The source that answered, and the platform it answered for. */
    sourceId: string;
    sourceName: string;
    platform: LxPlatformId;
    /** The row it answered with: the name and singer as that platform writes them. */
    songName: string;
    singer: string;
}

/** Names compared as the same song: casing, spacing and the usual brackets/punctuation ignored. */
const plainName = (value: string): string => value
    .toLowerCase()
    .replace(/[\s\-_/\\（）()\[\]【】{}<>《》·.,，、'"!！?？:：;；+&]/gu, '');

const rowSinger = (row: LxSearchRow): string => String(row.singer ?? '');

/** What a search row says about itself, in the shape `musicUrl` is given. */
const buildRowMusicInfo = (row: LxSearchRow, platform: LxPlatformId): Record<string, unknown> => {
    const id = String(row.songmid || row.hash || row.id || '');
    const singer = rowSinger(row);
    const info: Record<string, unknown> = {
        songmid: id,
        musicId: id,
        id,
        songId: id,
        hash: id,
        name: row.name ?? '',
        songname: row.name ?? '',
        singer,
        singerName: singer,
        interval: Number(row.interval) || 0,
        albumName: row.albumName ?? '',
        albumId: row.albumId ?? '',
        source: platform,
    };
    if (platform === 'tx') {
        info.strMediaMid = id;
        info.media_mid = id;
    }
    return info;
};

/**
 * The last link of the chain: the song played from a *different* platform's source. The play that
 * failed has no address anywhere for its own platform, so the enabled sources are asked to search
 * for the song by its name and singer, and the first row that matches by name (and, where the row
 * says who sings it, by singer) is asked for an address at the levels that are still acceptable.
 * Answers null where nothing matched: the caller then says the chain ran out.
 */
export const searchOtherSourcesForSong = async (
    song: SongResult,
    quality: AudioQualityPreference,
): Promise<LxCrossSourceAnswer | null> => {
    const ownPlatform = lxPlatformForSong(song);
    const sources = enabledLxSources();
    const name = song.name?.trim();
    if (!sources.length || !name) return null;
    const artists = (song.artists ?? []).map(artist => artist.name).filter(Boolean);
    const keyword = [name, artists[0] ?? ''].filter(Boolean).join(' ').trim();
    const wanted = plainName(name);
    const levels = levelsFor(quality);
    for (const meta of sources) {
        const host = await readHost(meta);
        if (!host) continue;
        const platforms = (host.platforms.length ? host.platforms : ['wy', 'tx', 'kg'] as LxPlatformId[])
            .filter(platform => platform !== ownPlatform);
        for (const platform of platforms) {
            let rows: LxSearchRow[] = [];
            try {
                rows = await host.search(platform, keyword, 1, 'song');
            } catch (error) {
                console.warn(`[LxSource] ${meta.name} could not search "${keyword}" on ${platform}`, error);
                continue;
            }
            const matches = rows.filter(row => row?.name && (row.songmid || row.hash || row.id) && plainName(row.name) === wanted);
            if (!matches.length) continue;
            // The row that names the same singer first: same-titled songs by other people are common.
            matches.sort((a, b) => {
                const score = (row: LxSearchRow): number => artists.reduce(
                    (hits, artist) => hits + (rowSinger(row).includes(artist) ? 1 : 0),
                    0,
                );
                return score(b) - score(a);
            });
            for (const row of matches) {
                for (const level of levels) {
                    try {
                        const url = await host.getMusicUrl(platform, buildRowMusicInfo(row, platform), level);
                        if (!url) continue;
                        useLxSourceStore.getState().noteResult(meta.id, { ok: true });
                        console.log(`[LxSource] "${song.name}" switched to ${meta.name}/${platform} as "${row.name}"`);
                        return {
                            url,
                            sourceId: meta.id,
                            sourceName: meta.name,
                            platform,
                            songName: row.name ?? name,
                            singer: rowSinger(row),
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.warn(`[LxSource] ${meta.name}/${platform} had no address for "${row.name}": ${message}`);
                    }
                }
            }
        }
    }
    return null;
};

/** One row a source found for a keyword, with the source that found it, for the search list. */
export interface LxSourceSearchHit {
    sourceId: string;
    sourceName: string;
    platform: LxPlatformId;
    row: LxSearchRow;
}

/**
 * Asks every enabled source that speaks for the platform for songs by keyword. A source that does
 * not implement search contributes nothing (it answers no rows, which is not an error), and a source
 * that fails is passed over so the others' rows still arrive: search is a merge, not a vote.
 */
export const searchLxSources = async (
    providerId: OnlineProviderId | null,
    keyword: string,
    page = 1,
): Promise<LxSourceSearchHit[]> => {
    const platform = lxPlatformForProvider(providerId);
    const trimmed = keyword.trim();
    if (!platform || !trimmed) return [];
    const sources = enabledLxSources();
    if (!sources.length) return [];
    const asked = sources.filter(meta => !meta.platforms.length || meta.platforms.includes(platform));
    if (!asked.length) return [];
    const answers = await Promise.all(asked.map(async (meta): Promise<LxSourceSearchHit[]> => {
        const host = await readHost(meta);
        if (!host) return [];
        try {
            const rows = await host.search(platform, trimmed, page, 'song');
            return rows
                .filter(row => row && (row.songmid || row.hash || row.id) && row.name)
                .map(row => ({ sourceId: meta.id, sourceName: meta.name, platform, row }));
        } catch (error) {
            console.warn(`[LxSource] ${meta.name} could not search "${trimmed}"`, error);
            return [];
        }
    }));
    return answers.flat();
};
