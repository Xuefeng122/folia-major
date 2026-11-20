// src/mods/web/platform.ts
// Where the Web mods host is allowed to run.
//
// On desktop the mod system is the main process's: it reads mods from disk, gates their
// Node entries and hands the clients out as folia-mod:// URLs through the preload bridge
// (window.electron.mods). A Capacitor build has no main process at all, so the panel used
// to show a desktop-only hint. This host fills the same bridge from inside the page instead:
// mods are stored in IndexedDB, unpacked from the official catalogue's zip, and handed to
// the unmodified client loader as blob: module URLs.
//
// Nothing here touches the desktop path: if window.electron.mods already exists, the host
// stays out of the way and every Electron behaviour is the one the main process implements.

type CapacitorLike = {
    isNativePlatform?: () => boolean;
    getPlatform?: () => string;
};

const capacitor = (): CapacitorLike | undefined => (globalThis as { Capacitor?: CapacitorLike }).Capacitor;

/** true inside the iOS/Android container (capacitor://localhost), false in a plain browser tab. */
export const isNativeShell = (): boolean => {
    const shell = capacitor();
    if (shell && typeof shell.isNativePlatform === 'function') {
        try {
            if (shell.isNativePlatform()) {
                return true;
            }
        } catch {
            // Fall through to the URL check: a shell whose probe throws is still a shell.
        }
    }
    if (typeof location === 'undefined') {
        return false;
    }
    return location.protocol === 'capacitor:' || location.protocol === 'ionic:' || location.protocol === 'app:';
};

/** The platform Capacitor reports ('ios' / 'android' / 'web'), or null when it is not loaded. */
export const nativePlatform = (): string | null => {
    const shell = capacitor();
    if (!shell || typeof shell.getPlatform !== 'function') {
        return null;
    }
    try {
        return shell.getPlatform() ?? null;
    } catch {
        return null;
    }
};

/** true when the preload bridge of the desktop build is present. */
export const hasDesktopModsBridge = (): boolean => {
    if (typeof window === 'undefined') {
        return false;
    }
    const electron = (window as { electron?: { mods?: unknown } }).electron;
    return Boolean(electron?.mods);
};

/** The Web host installs itself only where there is no desktop bridge and a container to live in. */
export const shouldInstallWebModsHost = (): boolean => !hasDesktopModsBridge() && isNativeShell();
