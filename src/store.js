/**
 * Tiny IndexedDB wrapper.
 *
 * Identity private keys are stored as structured-cloned `CryptoKey` objects
 * rather than as exported bytes. The key is created non-extractable, so the
 * private scalar never exists in a form any script — including this one — can
 * read back out of storage.
 */

const DB_NAME = 'p2pchat';
const DB_VERSION = 4;
const STORES = ['keys', 'profile', 'peers', 'log', 'chats', 'media', 'transfers', 'chunks'];

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener('upgradeneeded', () => {
      const db = request.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    });
    request.addEventListener('success', () => resolve(request.result));
    request.addEventListener('error', () => reject(request.error));
  });
  return dbPromise;
}

async function withStore(store, mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = action(transaction.objectStore(store));
    transaction.addEventListener('complete', () => resolve(request?.result));
    transaction.addEventListener('abort', () => reject(transaction.error));
    transaction.addEventListener('error', () => reject(transaction.error));
  });
}

export const idbGet = (store, key) => withStore(store, 'readonly', (s) => s.get(key));
export const idbSet = (store, key, value) => withStore(store, 'readwrite', (s) => s.put(value, key));
export const idbDelete = (store, key) => withStore(store, 'readwrite', (s) => s.delete(key));
export const idbAll = (store) => withStore(store, 'readonly', (s) => s.getAll());
export const idbKeys = (store) => withStore(store, 'readonly', (s) => s.getAllKeys());

/** All keys under a prefix, used to enumerate the chunks of one transfer. */
export const idbKeysFrom = (store, prefix) =>
  withStore(store, 'readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`)));
