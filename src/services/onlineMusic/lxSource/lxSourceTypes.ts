// src/services/onlineMusic/lxSource/lxSourceTypes.ts
// One imported LX Music custom source (洛雪音源): the metadata kept beside it and what its script
// says it can do. The script body itself is kept in the media store (see lxSourceStorage.ts), not
// in the settings store: the largest of them is over a megabyte.

/** The platforms an LX script speaks for. */
export type LxPlatformId = 'wy' | 'tx' | 'kg' | 'kw' | 'mg';

/** The qualities an LX script is asked for; their names are the script API's, not ours. */
export type LxQuality = '128k' | '320k' | 'flac' | 'flac24bit';

export interface LxSourceMeta {
    id: string;
    name: string;
    description?: string;
    version?: string;
    author?: string;
    homepage?: string;
    /**
     * Where a newer copy of the script is fetched from (a raw .js address, or one a release page's
     * GitHub blob link is turned into). Written when the script is imported and kept beside it, so
     * the settings page can check it without asking the listener for the address again.
     */
    updateUrl?: string;
    /** When the script was last replaced by an online update, in milliseconds. */
    updatedAt?: number;
    /** The version the remote copy had when that update was taken; what a later check compares to. */
    updateVersion?: string;
    /** Platforms the script declared (from its header or from its first answers). */
    platforms: LxPlatformId[];
    enabled: boolean;
    /** Later entries are tried first: the list is the order sources are switched through. */
    order: number;
    addedAt: number;
    /** How many times this source has produced a playable address, and how many times it failed. */
    hits?: number;
    misses?: number;
    lastError?: string;
}

/** What a script's `request` handler is asked for; `action` is 'musicUrl' here. */
export interface LxMusicUrlRequest {
    source: LxPlatformId;
    action: 'musicUrl';
    info: {
        type: LxQuality;
        musicInfo: Record<string, unknown>;
    };
}

export interface LxScriptInfo {
    name: string;
    description: string;
    version: string;
    author: string;
    homepage: string;
    rawScript: string;
}
