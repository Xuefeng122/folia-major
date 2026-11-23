import { useEffect } from 'react';
import i18n from '../i18n/config';
import { omni } from '../services/onlineMusic/omni';
import { useAppViewStore } from '../stores/useAppViewStore';
import { useCollectionNavigationStore } from '../stores/useCollectionNavigationStore';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';
import type { SongResult } from '../types';

// src/hooks/useAccountReads.ts
//
// Tells omni of the moments at which an account is read from its platform. It only listens: what
// is asked of the platform then, and how often, is decided in
// src/services/onlineMusic/account/ (accountRead.ts, readMoments.ts, likedChecks.ts).
//
// - The app has started: the account of every platform that has accounts is read.
// - The home screen is entered (home with no collection open on top of it: the lists behind an
//   open collection are not what is being looked at): the playlists of the platform shown are read
//   again, and its liked songs where their count has moved.
// - Folia's window is returned to: the liked songs, where their count has moved. The page's own
//   `focus` (the desktop window keeps counting as visible while it is hidden or minimised, so
//   there it is the only sign) and its turning visible again (a browser tab).
// - The song playing or the queue changes: the hearts of those songs, where a platform's liked
//   list was not read to the end. Heard from the store, so the app is not drawn again for it.
// (A completed sign-in, a platform switch and the sync button: useOnlineProviderPlatform.ts.)

// A read that fails is already reported by account/ (the platform is marked, the account stays as it
// is shown). Nothing here needs its failure: what must not happen is the rejection escaping as an
// unhandled one at every start, which is what a bare `void` on these promises did.
const carryOn = (what: string) => (error: unknown) => {
    console.warn(`[Account] ${what} failed, the account stays as it is shown: ${error instanceof Error ? error.message : String(error)}`);
};

export const useAccountReads = () => {
    const isHome = useAppViewStore(state => state.view === 'home');
    const hasCollection = useCollectionNavigationStore(state => Boolean(state.snapshot?.stack.length));
    const atHome = isHome && !hasCollection;

    useEffect(() => {
        omni.getProviderSummaries().forEach(provider => {
            if (provider.requiresAccount) void omni.readAccount(provider.providerId, 'start').catch(carryOn(`${provider.providerId}: start`));
        });
    }, []);

    useEffect(() => {
        if (!atHome) return;
        // The platform shown when the home screen is entered: the one whose playlists are asked for.
        const providerId = omni.getActiveProviderSummary()?.providerId;
        void omni.accountMoment('home-entered').then(playlists => {
            // The platform refused the sign-in and named nobody: the account has left the screen.
            // Said once, with that platform's mark.
            if (playlists === 'ran out') setStatusMessage({ type: 'error', text: i18n.t('login.signInRanOut'), providerId });
        }).catch(carryOn('home-entered'));
    }, [atHome]);

    useEffect(() => {
        const returned = () => {
            if (document.visibilityState === 'visible') void omni.accountMoment('window-returned').catch(carryOn('window-returned'));
        };
        window.addEventListener('focus', returned);
        document.addEventListener('visibilitychange', returned);
        return () => {
            window.removeEventListener('focus', returned);
            document.removeEventListener('visibilitychange', returned);
        };
    }, []);

    useEffect(() => {
        const tell = ({ currentSong, playQueue }: { currentSong: SongResult | null; playQueue: SongResult[] }) => {
            // Bookkeeping only: a platform that cannot answer must not take the screen down with it.
            try {
                omni.songsInPlay(currentSong ? [currentSong, ...playQueue] : playQueue);
            } catch (error) {
                carryOn('songs in play')(error);
            }
        };
        tell(usePlaybackStore.getState());
        return usePlaybackStore.subscribe((state, previous) => {
            if (state.currentSong !== previous.currentSong || state.playQueue !== previous.playQueue) tell(state);
        });
    }, []);
};
