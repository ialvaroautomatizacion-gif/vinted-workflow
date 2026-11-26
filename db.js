/**
 * Almacenamiento local (IndexedDB). Todo lo que se captura se guarda aquí ANTES de subirse,
 * y no se borra del móvil hasta que Drive confirma que el archivo existe con el mismo tamaño.
 */
const DB_NAME = 'vinted-workflow';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      const photos = db.createObjectStore('photos', { keyPath: 'id' });
      photos.createIndex('bySession', 'sessionId');
      const chunks = db.createObjectStore('chunks', { keyPath: ['sessionId', 'seg', 'seq'] });
      chunks.createIndex('bySession', 'sessionId');
      // Fotos a tamaño completo, separadas de los metadatos para no cargarlas en memoria al listar
      db.createObjectStore('blobs', { keyPath: 'id' });
      db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción abortada'));
  }));
}

const reqP = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const db = {
  put: (store, obj) => tx(store, 'readwrite', s => { s.put(obj); return obj; }),
  get: (store, key) => tx(store, 'readonly', s => reqP(s.get(key))),
  del: (store, key) => tx(store, 'readwrite', s => { s.delete(key); }),
  all: (store) => tx(store, 'readonly', s => reqP(s.getAll())),
  bySession: (store, sessionId) => tx(store, 'readonly', s => reqP(s.index('bySession').getAll(sessionId))),
  chunksRange: (sessionId, seg, fromSeq, toSeq) => tx('chunks', 'readonly',
    s => reqP(s.getAll(IDBKeyRange.bound([sessionId, seg, fromSeq], [sessionId, seg, toSeq])))),
  kvGet: async (k) => (await db.get('kv', k))?.v,
  kvSet: (k, v) => db.put('kv', { k, v }),
};

/** Pide a Safari que no borre los datos locales por falta de espacio (si lo permite). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* no soportado */ }
  return false;
}

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
