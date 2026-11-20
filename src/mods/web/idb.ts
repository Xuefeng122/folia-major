// src/mods/web/idb.ts
// The store the Web mods host keeps mods and their settings in.
//
// IndexedDB rather than localStorage: a mod's tree is Uint8Array files (52Hz alone ships an
// 800 KB pixi bundle), and localStorage would base64 them and cap out at a few MB. WKWebView
// keeps IndexedDB per app bundle id, so an installed mod survives a restart and an app update.
// A reinstall of the app starts from an empty sandbox - that is iOS, not this layer, and the
// market is one tap per mod below.

const DB_NAME = 'folia-web-mods';
const DB_VERSION = 1;

export const STORE_MODS = 'mods';
export const STORE_KV = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
    if (dbPromise) {
        return dbPromise;
    }
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_MODS)) {
                db.createObjectStore(STORE_MODS, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORE_KV)) {
                db.createObjectStore(STORE_KV);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexeddb-open-failed'));
        request.onblocked = () => reject(new Error('indexeddb-blocked'));
    });
    // A failed open must not be cached: the next call retries instead of failing forever.
    dbPromise.catch(() => {
        dbPromise = null;
    });
    return dbPromise;
};

const run = <T>(store: string, mode: IDBTransactionMode, run_: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    openDb().then((db) => new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = run_(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexeddb-request-failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('indexeddb-aborted'));
    }));

export const idbGet = <T>(store: string, key: IDBValidKey): Promise<T | undefined> =>
    run<T | undefined>(store, 'readonly', (objectStore) => objectStore.get(key) as IDBRequest<T | undefined>);

export const idbGetAll = <T>(store: string): Promise<T[]> =>
    run<T[]>(store, 'readonly', (objectStore) => objectStore.getAll() as IDBRequest<T[]>);

export const idbPut = <T>(store: string, value: T, key?: IDBValidKey): Promise<IDBValidKey> =>
    run<IDBValidKey>(store, 'readwrite', (objectStore) => (key === undefined
        ? objectStore.put(value as unknown as object)
        : objectStore.put(value as unknown as object, key)));

export const idbDelete = (store: string, key: IDBValidKey): Promise<undefined> =>
    run<undefined>(store, 'readwrite', (objectStore) => objectStore.delete(key) as IDBRequest<undefined>);

export const idbClear = (store: string): Promise<undefined> =>
    run<undefined>(store, 'readwrite', (objectStore) => objectStore.clear() as IDBRequest<undefined>);

/** kv: one row per key, used for the enabled set, the catalogue cache and mod settings. */
export const kvGet = <T>(key: string): Promise<T | undefined> => idbGet<T>(STORE_KV, key);
export const kvSet = <T>(key: string, value: T): Promise<IDBValidKey> => idbPut<T>(STORE_KV, value, key);
export const kvDelete = (key: string): Promise<undefined> => idbDelete(STORE_KV, key);
