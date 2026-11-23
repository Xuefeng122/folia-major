// src/services/playbackRecovery/usePlayableAudioSources.ts
//
// The one door every <audio> source goes through in the phone container.
//
// Until now only the online-source chain of App called `toPlayableAudioAddress`, and the device log
// showed not one `[AudioProxy]` line: the decks were being handed their addresses by the automix
// deck resolver instead, so the proxy was never on the play path at all. A hook cannot await before
// a render, so the addresses are resolved here and the element is given the resolved value:
//
//   - not a remote address (blob:, file:, http(s) on the app's own origin) -> as it came;
//   - remote -> the address the proxy answers with, which is a `blob:` URL of the bytes fetched
//     through the native bridge (what actually plays in a secure `capacitor://localhost` page);
//   - while it is being fetched the element is given nothing at all, so WebKit is never asked to
//     load the address it would have refused;
//   - a fetch that failed hands the raw address back, so the element fails loudly and the existing
//     failure handling (refresh, next level, skip) takes over instead of a silent hole.
//
// Every step logs `[AudioProxy]`, and so does every address that is skipped, which is what makes the
// next device log say whether this door was reached at all.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toPlayableAudioAddress } from './nativeAudioProxy';

/** An address this element would have to fetch itself: anything that is not a local or app URL. */
const REMOTE_ADDRESS = /^https?:\/\//iu;

/** The page's own origin: `capacitor://localhost` in the shell, the dev server on the web. */
const appOrigins = (): string[] => {
    if (typeof window === 'undefined') return [];
    const origins = [window.location.origin];
    try {
        origins.push(window.location.href);
    } catch {
        // Nothing to add: the origin alone is enough to tell the app's own files apart.
    }
    return origins.filter(Boolean);
};

/** true where the element would have to make the request itself, which is what the proxy is for. */
export const needsAudioProxy = (address: string | null | undefined): boolean => {
    const trimmed = address?.trim();
    if (!trimmed) return false;
    if (!REMOTE_ADDRESS.test(trimmed)) return false;
    // A file the app itself serves (a bundled sample, a dev-server asset) is already same-origin.
    return !appOrigins().some(origin => trimmed.startsWith(origin));
};

type Resolved = { url: string; throughNative: boolean } | 'failed';

/**
 * Resolves the addresses an `<audio>` element is about to be given, and answers the one it should
 * actually use. The answer is synchronous by design: a source is either in hand or still coming.
 */
export const usePlayableAudioSources = (addresses: readonly (string | undefined)[]): (address?: string) => string | undefined => {
    const [resolved, setResolved] = useState<Record<string, Resolved>>({});
    // Addresses being fetched right now. A ref, so a second render during a fetch starts nothing new.
    const inFlight = useRef<Set<string>>(new Set());
    const wanted = addresses.filter((address): address is string => needsAudioProxy(address));

    useEffect(() => {
        let live = true;
        for (const address of wanted) {
            if (inFlight.current.has(address)) continue;
            inFlight.current.add(address);
            console.log(`[AudioProxy] start <audio> source ${address.slice(0, 120)}`);
            void toPlayableAudioAddress(address)
                .then(answer => {
                    if (!live) return;
                    inFlight.current.delete(address);
                    // Null means the proxy refused it for this session (dead address): hand the raw
                    // one over so the element's own error takes the play on to the next source.
                    setResolved(previous => ({ ...previous, [address]: answer ? { url: answer.url, throughNative: answer.throughNative } : 'failed' }));
                })
                .catch(error => {
                    if (!live) return;
                    inFlight.current.delete(address);
                    const reason = error instanceof Error ? error.message : String(error);
                    console.warn(`[AudioProxy] failed <audio> source ${address.slice(0, 120)}: ${reason}`);
                    setResolved(previous => ({ ...previous, [address]: 'failed' }));
                });
        }
        return () => {
            live = false;
        };
    }, [wanted.join('\n')]);

    return useCallback((address?: string) => {
        if (!address) return undefined;
        if (!needsAudioProxy(address)) return address;
        const answer = resolved[address];
        if (!answer) {
            console.log(`[AudioProxy] waiting for the bytes of ${address.slice(0, 120)}: no src on the element yet`);
            return undefined;
        }
        if (answer === 'failed') {
            console.log(`[AudioProxy] skip: ${address.slice(0, 120)} is handed to the element as it came`);
            return address;
        }
        console.log(`[AudioProxy] play ${answer.throughNative ? 'blob' : 'address'}: ${address.slice(0, 80)}`);
        return answer.url;
    }, [resolved]);
};

/**
 * An address as a log line can afford it: a blob keeps only its prefix (the bytes came through the
 * bridge, the extension is gone), a remote address its host, path and the query keys that name the
 * level - never a full signed URL with its token in it.
 */
export const describeAudioSource = (address: string | null | undefined): string => {
    if (!address) return 'none';
    if (address.startsWith('blob:')) return address.slice(0, 24);
    if (address.startsWith('data:')) return `data:${address.slice(5, 25)}`;
    try {
        const parsed = new URL(address);
        const level = parsed.searchParams.get('level') ?? parsed.searchParams.get('br') ?? parsed.searchParams.get('quality');
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}${level ? `?level=${level}` : ''}`;
    } catch {
        return address.slice(0, 100);
    }
};
