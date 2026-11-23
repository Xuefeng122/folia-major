// src/services/onlineMusic/quality/iosCompatQuality.ts
//
// The quality ceiling the iOS container needs.
//
// WKWebView's <audio> element does not decode the flac container, and the lossless / Hi-Res presets
// are exactly the ones whose addresses answer a flac file (LX levels `flac` and `flac24bit`). The
// result on device was a track that stayed on "loading" for ever with no error event: the element
// accepted the source, never produced a frame, and never failed.
//
// So inside the iOS shell the ask is capped to 320k (mp3 first, which is what the providers answer
// at the `high` preset) unless the listener turns the cap off in settings. Everywhere else - desktop,
// web, Android - nothing changes: the preference is used exactly as it is stored.

import type { AudioQualityPreference } from '../../../types/onlineMusic';
import { isIosNativePlatform } from '../webLogin/nativeLoginBridge';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';

/** The highest level the iOS container plays reliably: 320k, served as mp3 by the providers. */
export const IOS_SAFE_QUALITY: AudioQualityPreference = 'high';

/** The levels WKWebView cannot decode, whatever address they come from. */
const FLAC_LEVELS: ReadonlySet<AudioQualityPreference> = new Set<AudioQualityPreference>(['lossless', 'hires']);

/**
 * Whether the cap applies right now: only in the iOS container, and only while the listener has the
 * "iOS compatible quality first" switch on (on by default, see useAudioSettingsStore).
 */
export const isIosQualityCapOn = (): boolean => {
    if (!isIosNativePlatform()) return false;
    try {
        return useAudioSettingsStore.getState().iosCompatQuality !== false;
    } catch {
        // A store that cannot be read never costs the listener a playable track.
        return true;
    }
};

/**
 * The level a play should actually ask for. Anything below lossless is passed through untouched (a
 * 320k or 128k address answers mp3), and so is every level outside the iOS container.
 */
export const effectiveAudioQuality = (asked: AudioQualityPreference): AudioQualityPreference => {
    if (!FLAC_LEVELS.has(asked)) return asked;
    if (!isIosQualityCapOn()) return asked;
    console.log(`[AudioQuality] iOS container: ${asked} cannot be decoded by <audio>, asking ${IOS_SAFE_QUALITY} (mp3) instead`);
    return IOS_SAFE_QUALITY;
};

/** Whether an address points at a flac file, for the message a failed flac play deserves. */
export const isFlacAddress = (address: string | null | undefined): boolean => Boolean(
    address && /\.flac(?:$|\?)|[?&](?:type|format)=flac(?:&|$)|flac24bit/iu.test(address),
);
