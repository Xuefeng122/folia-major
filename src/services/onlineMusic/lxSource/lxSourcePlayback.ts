// src/services/onlineMusic/lxSource/lxSourcePlayback.ts
// Switches a play that its own platform could not hand an address for through the imported LX
// sources, in the order the listener set. The first source that answers with a playable address
// wins, which is what makes a source list a fallback chain rather than a pile of scripts.

import type { AudioQualityPreference } from '../../../types/onlineMusic';
import type { SongResult } from '../../../types';
import { getOnlineProviderIdForSong } from '../../../utils/appPlaybackGuards';
import { clearLxVersionGateReports, createLxSourceHost, lxVersionGateReport, type LxSourceHost } from './lxSourceSandbox';
import { enabledLxSources, useLxSourceStore } from './lxSourceStore';
import type { LxPlatformId, LxQuality, LxSourceMeta } from './lxSourceTypes';

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

/**
 * Asks every enabled source that speaks for this song's platform, in order, for a play address.
 * Answers null where none of them had one: the caller then reports the failure it already has.
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
    const level = QUALITY_BY_PREFERENCE[quality] ?? '320k';
    for (const meta of sources) {
        const host = await readHost(meta);
        if (!host) {
            useLxSourceStore.getState().noteResult(meta.id, { ok: false, error: brokenHosts.get(meta.id) });
            continue;
        }
        // What the script itself says it speaks for outranks what its text looked like it mentioned:
        // a source that named other platforms is passed over without being asked.
        const spoken = host.platforms;
        if (spoken.length && !spoken.includes(platform)) continue;
        try {
            const url = await host.getMusicUrl(platform, musicInfo, level);
            if (url) {
                useLxSourceStore.getState().noteResult(meta.id, { ok: true });
                console.log(`[LxSource] "${song.name}" played from ${meta.name}`);
                return url;
            }
            useLxSourceStore.getState().noteResult(meta.id, { ok: false, error: 'The script returned no address' });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            useLxSourceStore.getState().noteResult(meta.id, { ok: false, error: message });
        }
    }
    return null;
};
