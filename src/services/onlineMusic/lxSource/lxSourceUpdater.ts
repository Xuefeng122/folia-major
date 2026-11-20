// src/services/onlineMusic/lxSource/lxSourceUpdater.ts
// Keeping an imported LX source (洛雪音源) up to date from the address it came from. A script is
// ordinary code the listener installed; the copy published at its update address is only ever
// fetched when the listener asks for it (the settings page's 检查更新 / 更新), never on start, and
// the copy it replaces is kept as a backup first — a bad release costs a click, not a source.
//
// What an update is compared on: the `@version` line of the script's header. A script that names no
// version is compared on its text, so a release that changed only its code still counts.

import { createLxSourceHost, readLxScriptHeader } from './lxSourceSandbox';
import { readLxAddressText } from './nativeScriptFetch';
import {
    readLxSourceBackup,
    readLxSourceScript,
    writeLxSourceBackup,
    writeLxSourceScript,
} from './lxSourceStorage';
import { useLxSourceStore } from './lxSourceStore';
import type { LxPlatformId, LxSourceMeta } from './lxSourceTypes';

const MANIFEST_KEY = 'folia_lx_update_manifest';

/**
 * The one public collection the sources usually come from: its files are fetched by name, so a
 * source imported from it is checked without the listener having to paste an address. Kept as data
 * rather than a directory listing (a listing endpoint is rate limited and answers nothing offline).
 */
const BUILTIN_REPO_RAW = 'https://raw.githubusercontent.com/xzh767/lxmusic-source-all/main/';
const BUILTIN_REPO_FILES = [
    'MusicDownloader.js',
    'huibq.js',
    'ikun_latest.js',
    'ikun公益音源备用.js',
    'ikun音源（中国香港服务器）v1.0.1.js',
    'lx-music-source V3.0.js',
    'monster.js',
    'nya.js',
    'sixyin1.2.1.js',
    'zhizun.js',
    '公众号音源2.js',
    '小熊猫v1.1.1.js',
    '废材公社 内部源.js',
    '梓澄公益音源二代v1.2.3.4.5.js',
    '無名v0.0.3.js',
    '聚合API V3(by lerd).js',
    '聚合API接口(decrypt).js',
    '聚合API接口2.0.js',
    '聚合v3.js',
    '肥猫不肥.js',
    '野花音源.js',
    '野草音源.js',
];

/** Comparing names the way a listener reads them: no case, no version, no "音源/source" tail. */
const normalizeName = (value: string): string => value
    .toLowerCase()
    .replace(/v?\d+(?:\.\d+)*/gu, '')
    .replace(/[\s_·・,，.、()（）[\]【】-]+/gu, '')
    .replace(/(音源|源|source)$/u, '');

/** Turns a release page's file link into the raw address the file's text is actually served at. */
export const toRawAddress = (address: string): string => {
    const trimmed = address.trim();
    if (!trimmed) return '';
    const github = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/u.exec(trimmed);
    if (github) {
        const [, owner, repo, branch, path] = github;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
    }
    const gist = /^https?:\/\/gist\.github\.com\/([^/]+)\/([^/]+)$/u.exec(trimmed);
    if (gist) return `https://gist.githubusercontent.com/${gist[1]}/${gist[2]}/raw`;
    return trimmed;
};

interface ManifestEntry {
    name: string;
    url: string;
}

/** The listener's own list of scripts and their addresses (`[{ "name": "…", "url": "…" }]`). */
const readManifest = (): ManifestEntry[] => {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(MANIFEST_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return (parsed as ManifestEntry[])
            .filter(entry => entry && typeof entry.url === 'string' && entry.url)
            .map(entry => ({ name: String(entry.name ?? ''), url: toRawAddress(entry.url) }));
    } catch (error) {
        console.warn('[LxSource] Failed to read the update list', error);
        return [];
    }
};

export const readLxUpdateManifest = readManifest;

/** What the settings page shows in the update-address field before the listener writes one. */
export const lxUpdateManifestAddress = (): string => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(MANIFEST_KEY) ?? '';
};

export const writeLxUpdateManifest = (address: string): void => {
    if (typeof window === 'undefined') return;
    const trimmed = address.trim();
    if (!trimmed) {
        window.localStorage.removeItem(MANIFEST_KEY);
        return;
    }
    window.localStorage.setItem(MANIFEST_KEY, trimmed);
};

/** The addresses a source of this name may be published at, the best guess first. */
const addressesOf = (meta: LxSourceMeta): string[] => {
    const found: string[] = [];
    const push = (address: string) => {
        const raw = toRawAddress(address);
        if (raw && !found.includes(raw)) found.push(raw);
    };
    if (meta.updateUrl) push(meta.updateUrl);
    if (meta.homepage) push(meta.homepage);

    const name = normalizeName(meta.name);
    for (const entry of readManifest()) {
        if (!name || normalizeName(entry.name) === name) push(entry.url);
    }
    if (name) {
        for (const file of BUILTIN_REPO_FILES) {
            const bare = normalizeName(file.replace(/\.js$/iu, ''));
            if (!bare) continue;
            if (bare === name || name.includes(bare) || bare.includes(name)) {
                push(`${BUILTIN_REPO_RAW}${encodeURIComponent(file).replace(/%2F/giu, '/')}`);
            }
        }
    }
    // Only an http(s) address can be fetched; a homepage that is a docs page is not one to try.
    return found.filter(address => /^https?:\/\//iu.test(address));
};

/**
 * Reads a script or a version manifest from its address. On the phone the read goes through the
 * native bridge (see nativeScriptFetch): an update address is another origin and WebKit refuses a
 * cross-origin fetch from the app's own origin, which is why every check used to end in
 * 「下载失败」. What comes back is checked before it is trusted: not a page, not mojibake.
 */
const fetchScriptText = async (address: string): Promise<string> => {
    const answer = await readLxAddressText(address);
    const code = answer.text.replace(/^\uFEFF/u, '');
    if (!code.trim()) throw new Error('地址返回了空内容');
    if (/^\s*</u.test(code) && /<html/iu.test(code.slice(0, 400))) {
        throw new Error('地址返回的是网页而不是脚本');
    }
    // A script stored in GBK arrives as replacement characters once read as UTF-8: 长青/念心 both
    // ship UTF-8, so this catches a wrong-encoded copy rather than silently storing it broken.
    if (code.includes('\uFFFD')) {
        throw new Error('无法解析文件编码（建议使用 UTF-8 保存）');
    }
    console.log(`[LxSource] 读取 ${address} 成功（${answer.through === 'native' ? '原生通道' : 'fetch'}，${code.length} 字符）`);
    return code;
};

/** Numeric-aware comparison of two `@version` texts; >0 when `a` is newer than `b`. */
const compareVersions = (a: string, b: string): number => {
    const split = (value: string) => value.replace(/^v/iu, '').split(/[.\-_+]/u)
        .map(part => Number.parseInt(part, 10))
        .map(part => (Number.isFinite(part) ? part : 0));
    const left = split(a);
    const right = split(b);
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const one = left[index] ?? 0;
        const other = right[index] ?? 0;
        if (one !== other) return one - other;
    }
    return 0;
};

export type LxUpdateStatus = 'update' | 'latest' | 'manifest' | 'no-address' | 'error';

export interface LxUpdateCheck {
    id: string;
    name: string;
    status: LxUpdateStatus;
    /** The address the answer came from (or was tried at). */
    address?: string;
    currentVersion?: string;
    remoteVersion?: string;
    /**
     * The release page a version manifest points at. A manifest is JSON — a version and where the
     * script moved to — so the newer script itself has to be taken from that page by hand.
     */
    releaseUrl?: string;
    /** Why the check failed, for the row to show instead of a bare "error". */
    reason?: string;
}

/** A version manifest: what a source checks itself against, and where its newer copy is announced. */
interface VersionManifest {
    version?: string;
    updateUrl?: string;
    description?: string;
}

const parseVersionManifest = (text: string): VersionManifest | null => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as VersionManifest;
    } catch {
        return null;
    }
};

/** The answer kept for a check: the code is held so `applyLxSourceUpdate` publishes what was read. */
const fetched = new Map<string, { code: string; address: string; version?: string }>();

export const checkLxSourceUpdate = async (
    meta: LxSourceMeta,
    // An updateAlert names its own release address; checking that one first is what the card on
    // the source's row does, rather than re-guessing from the header.
    explicitAddresses?: string[],
): Promise<LxUpdateCheck> => {
    const addresses = explicitAddresses?.length ? explicitAddresses : addressesOf(meta);
    if (!addresses.length) {
        return {
            id: meta.id,
            name: meta.name,
            status: 'no-address',
            currentVersion: meta.version,
            reason: 'no update address',
        };
    }
    const current = await readLxSourceScript(meta.id);
    const currentVersion = meta.version || (current ? readLxScriptHeader(current).version : '') || '';
    let reason = '';
    // A manifest may name where the script went, so the queue grows as answers are read: the
    // page a manifest points at is tried next when it is itself a fetchable script.
    const queue = [...addresses];
    let manifestAnswer: LxUpdateCheck | null = null;
    while (queue.length) {
        const address = queue.shift() as string;
        try {
            const text = await fetchScriptText(address);
            const manifest = parseVersionManifest(text);
            if (manifest) {
                const remoteVersion = typeof manifest.version === 'string' ? manifest.version : '';
                const release = typeof manifest.updateUrl === 'string'
                    ? toRawAddress(manifest.updateUrl)
                    : '';
                const newer = remoteVersion
                    ? (!currentVersion || compareVersions(remoteVersion, currentVersion) > 0)
                    : false;
                console.log(
                    `[LxSource] ${meta.name} checked at ${address}: manifest ${remoteVersion || '(no version)'}, `
                    + `installed ${currentVersion || '(no version)'} → ${newer ? 'newer' : 'same'}`,
                );
                if (newer && /\.jsx?(\?|$)/iu.test(release)) {
                    queue.unshift(release);
                    continue;
                }
                manifestAnswer = {
                    id: meta.id,
                    name: meta.name,
                    status: newer ? 'manifest' : 'latest',
                    address,
                    currentVersion,
                    remoteVersion,
                    releaseUrl: release || undefined,
                    reason: release ? undefined : 'the manifest names no release page',
                };
                return manifestAnswer;
            }
            const header = readLxScriptHeader(text);
            const remoteVersion = header.version ?? '';
            // Text is the fallback identity: a script that names no version is new when it differs.
            const newer = remoteVersion
                ? (!currentVersion || compareVersions(remoteVersion, currentVersion) > 0)
                : current !== null && text.trim() !== current.trim();
            fetched.set(meta.id, { code: text, address, version: remoteVersion || undefined });
            console.log(
                `[LxSource] ${meta.name} checked at ${address}: remote ${remoteVersion || '(no version)'}, `
                + `installed ${currentVersion || '(no version)'} → ${newer ? 'update' : 'latest'}`,
            );
            return {
                id: meta.id,
                name: meta.name,
                status: newer ? 'update' : 'latest',
                address,
                currentVersion,
                remoteVersion,
            };
        } catch (error) {
            reason = error instanceof Error ? error.message : String(error);
            console.warn(`[LxSource] ${meta.name} update check failed at ${address}:`, reason);
        }
    }
    if (manifestAnswer) return manifestAnswer;
    return {
        id: meta.id,
        name: meta.name,
        status: 'error',
        address: addresses[0],
        currentVersion,
        reason,
    };
};

export const checkAllLxSourceUpdates = async (): Promise<LxUpdateCheck[]> => {
    const sources = useLxSourceStore.getState().sources;
    const results: LxUpdateCheck[] = [];
    for (const source of sources) {
        results.push(await checkLxSourceUpdate(source));
    }
    return results;
};

export interface LxUpdateApplied {
    id: string;
    name: string;
    version?: string;
    address: string;
}

/** The platforms a script mentions, the guess a fresh import makes before the script says its own. */
const ALL_PLATFORMS: LxPlatformId[] = ['wy', 'tx', 'kg', 'kw', 'mg'];

const platformsNamedIn = (code: string): LxPlatformId[] => {
    const found = ALL_PLATFORMS.filter(platform => new RegExp(`['"\`]${platform}['"\`]`).test(code));
    return found.length ? found : [...ALL_PLATFORMS];
};

const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => {
    globalThis.setTimeout(resolve, ms);
});

interface CheckedScript {
    header: Pick<LxSourceMeta, 'name' | 'description' | 'version' | 'author' | 'homepage' | 'updateUrl'>;
    platforms: LxPlatformId[];
}

/**
 * What a script has to be before it may replace one that works: it parses, it carries a source
 * header, and it can be compiled here so the platforms it speaks for are known. A script that fails
 * any of these is refused and the installed copy is left untouched.
 */
const inspectScript = async (meta: LxSourceMeta, code: string): Promise<CheckedScript> => {
    const trimmed = code.replace(/^\uFEFF/u, '').trim();
    if (!trimmed) throw new Error('脚本内容为空');
    try {
        // Compiled, not run: this only asks whether the text is valid JavaScript at all.
        // eslint-disable-next-line no-new-func
        new Function(trimmed);
    } catch (error) {
        throw new Error(`脚本语法错误：${error instanceof Error ? error.message : String(error)}`);
    }
    const header = readLxScriptHeader(trimmed);
    if (!header.name && !header.version) {
        throw new Error('这不像是音源脚本：缺少 @name / @version 头注释');
    }
    let platforms: LxPlatformId[] = [];
    const scope = globalThis as unknown as Record<string, unknown>;
    const previousLx = scope.lx;
    let host: ReturnType<typeof createLxSourceHost> | null = null;
    try {
        host = createLxSourceHost({ ...meta, name: header.name || meta.name, version: header.version ?? meta.version }, trimmed);
        // A script says what it speaks for in its `inited` notice, which may follow its own version
        // check; the gate inside the sandbox answers that check, so this settles quickly.
        for (let waited = 0; waited < 2000 && !host.platforms.length; waited += 100) {
            await sleep(100);
        }
        platforms = host.platforms;
    } catch (error) {
        throw new Error(`脚本无法运行：${error instanceof Error ? error.message : String(error)}`);
    } finally {
        host?.dispose();
        scope.lx = previousLx;
    }
    return { header, platforms: platforms.length ? platforms : platformsNamedIn(trimmed) };
};

/** The address a paste came from, checked to be a script and not a page or a version manifest. */
export const fetchLxScriptFromAddress = async (address: string): Promise<string> => {
    const raw = toRawAddress(address);
    if (!/^https?:\/\//iu.test(raw)) throw new Error('更新地址必须是 http(s) 链接');
    const text = await fetchScriptText(raw);
    if (parseVersionManifest(text)) {
        throw new Error('这个地址是版本清单（JSON），不是脚本本身；请打开它指向的发布页复制脚本全文');
    }
    return text;
};

/**
 * Replaces a source's script with `code` after it has been checked, keeping the copy it replaces as
 * a backup. This is the one road to a new script — an online update, a pasted copy, an import from an
 * address — so every one of them is checked and every one of them can be rolled back.
 */
export const replaceLxSourceScript = async (
    meta: LxSourceMeta,
    code: string,
    address?: string,
): Promise<LxUpdateApplied> => {
    const checked = await inspectScript(meta, code);
    const previous = await readLxSourceScript(meta.id);
    if (previous && previous.trim() === code.trim()) {
        throw new Error(`${meta.name}: 内容与当前脚本相同`);
    }
    if (previous) {
        await writeLxSourceBackup(meta.id, {
            code: previous,
            version: meta.version,
            at: Date.now(),
        });
    }
    const trimmed = code.replace(/^\uFEFF/u, '').trim();
    await writeLxSourceScript(meta.id, trimmed);
    useLxSourceStore.getState().adoptScript(meta.id, {
        name: checked.header.name || meta.name,
        version: checked.header.version,
        description: checked.header.description,
        author: checked.header.author,
        homepage: checked.header.homepage ?? meta.homepage,
        platforms: checked.platforms,
        updateUrl: address ?? meta.updateUrl,
        updateVersion: checked.header.version,
        updatedAt: Date.now(),
    });
    fetched.delete(meta.id);
    console.log(`[LxSource] ${meta.name} 脚本已替换为 ${checked.header.version || '(无版本号)'}${address ? `（来源 ${address}）` : ''}`);
    return {
        id: meta.id,
        name: checked.header.name || meta.name,
        version: checked.header.version,
        address: address ?? meta.updateUrl ?? '',
    };
};

/**
 * Replaces a source's script with the copy last read by a check. The copy being replaced is kept as
 * a backup (see `restoreLxSourceBackup`), and the source's own settings — enabled, order, its place
 * in the chain — are left as they were.
 */
export const applyLxSourceUpdate = async (meta: LxSourceMeta, check?: LxUpdateCheck): Promise<LxUpdateApplied> => {
    const answer = check ?? await checkLxSourceUpdate(meta);
    if (answer.status === 'manifest') {
        throw new Error(
            `${meta.name}: 远端已发布 ${answer.remoteVersion || '新版本'}，但发布页只提供人工获取；`
            + `请打开 ${answer.releaseUrl ?? answer.address ?? ''} 复制脚本后「粘贴覆盖」`,
        );
    }
    const held = fetched.get(meta.id);
    if (answer.status !== 'update' || !held) {
        const notice = held ? 'no newer copy was found' : answer.reason || 'nothing was fetched';
        throw new Error(`${meta.name}: ${notice}`);
    }
    return replaceLxSourceScript(meta, held.code, held.address);
};

/** Puts back the copy the last update replaced. */
export const restoreLxSourceBackup = async (meta: LxSourceMeta): Promise<LxUpdateApplied | null> => {
    const backup = await readLxSourceBackup(meta.id);
    if (!backup) return null;
    const current = await readLxSourceScript(meta.id);
    await writeLxSourceScript(meta.id, backup.code);
    const header = readLxScriptHeader(backup.code);
    useLxSourceStore.getState().adoptScript(meta.id, {
        version: header.version,
        description: header.description,
        author: header.author,
        homepage: header.homepage ?? meta.homepage,
        updatedAt: backup.at,
    });
    // The copy that was just rolled back becomes the backup, so a second click rolls forward.
    if (current) await writeLxSourceBackup(meta.id, { code: current, version: meta.version, at: Date.now() });
    console.log(`[LxSource] ${meta.name} rolled back to ${header.version || '(no version)'}`);
    return { id: meta.id, name: meta.name, version: header.version, address: meta.updateUrl ?? '' };
};

/** Forgets what a check read, for a source that is gone. */
export const forgetLxSourceUpdate = (id: string): void => {
    fetched.delete(id);
};
