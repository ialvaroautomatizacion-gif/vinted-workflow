/**
 * Almacenamiento local (IndexedDB). Todo lo que se captura se guarda aquí ANTES de subirse,
 * y no se borra del móvil hasta que Drive confirma que el archivo existe con el mismo tamaño.
 *
 * Almacenes:
 *   sessions  estado de cada sesión
 *   photos    metadatos de cada foto (ligeros)
 *   thumbs    miniaturas para la galería
 *   blobs     fotos a tamaño completo (hasta confirmar la subida)
 *   chunks    trozos de audio de 5 s (hasta confirmar la subida)
 *   kv        ajustes internos
 */
const DB_NAME = 'vinted-workflow';
const DB_VERSION = 2;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { return reject(e); }
    req.onupgradeneeded = () => {
      const d = req.result;
      const has = n => d.objectStoreNames.contains(n);
      if (!has('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
      if (!has('photos')) d.createObjectStore('photos', { keyPath: 'id' }).createIndex('bySession', 'sessionId');
      if (!has('chunks')) d.createObjectStore('chunks', { keyPath: ['sessionId', 'seg', 'seq'] }).createIndex('bySession', 'sessionId');
      if (!has('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      if (!has('thumbs')) d.createObjectStore('thumbs', { keyPath: 'id' });
      if (!has('kv')) d.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => d.close(); // otra pestaña con versión nueva
      resolve(d);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Cierra las demás pestañas de Vinted Workflow y recarga'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

const reqP = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

function tx(store, mode, fn) {
  return open().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    let result;
    try { Promise.resolve(fn(t.objectStore(store))).then(r => { result = r; }, e => { try { t.abort(); } catch { /* */ } reject(e); }); }
    catch (e) { return reject(e); }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('No se pudo guardar en el móvil (¿sin espacio?)'));
  }));
}

export const db = {
  /** Comprueba que el almacenamiento local funciona (falla en algunos modos privados). */
  check: () => open().then(() => true),
  put: (store, obj) => tx(store, 'readwrite', s => { s.put(obj); return obj; }),
  get: (store, key) => tx(store, 'readonly', s => reqP(s.get(key))),
  del: (store, key) => tx(store, 'readwrite', s => { s.delete(key); }),
  all: (store) => tx(store, 'readonly', s => reqP(s.getAll())),
  bySession: (store, sessionId) => tx(store, 'readonly', s => reqP(s.index('bySession').getAll(sessionId))),

  /**
   * Leer-modificar-escribir en UNA transacción (atómico). fn recibe el objeto actual y lo modifica.
   * Evita que dos partes de la app se pisen cambios (p. ej. borrar una foto mientras se está subiendo).
   */
  update: (store, key, fn) => tx(store, 'readwrite', async s => {
    const cur = await reqP(s.get(key));
    if (!cur) return null;
    fn(cur);
    s.put(cur);
    return cur;
  }),

  chunksRange: (sessionId, seg, fromSeq, toSeq) => tx('chunks', 'readonly',
    s => reqP(s.getAll(IDBKeyRange.bound([sessionId, seg, fromSeq], [sessionId, seg, toSeq])))),

  /** Último trozo de audio guardado de un segmento (para reconstruir tras un cierre inesperado). */
  lastChunk: (sessionId, seg) => tx('chunks', 'readonly', s => new Promise((res, rej) => {
    const r = s.openCursor(IDBKeyRange.bound([sessionId, seg, 0], [sessionId, seg, Number.MAX_SAFE_INTEGER]), 'prev');
    r.onsuccess = () => { const c = r.result; res(c ? { seq: c.value.seq, endMs: c.value.endMs, startMs: c.value.startMs } : null); };
    r.onerror = () => rej(r.error);
  })),

  delChunks: (sessionId, seg) => tx('chunks', 'readwrite',
    s => { s.delete(IDBKeyRange.bound([sessionId, seg, 0], [sessionId, seg, Number.MAX_SAFE_INTEGER])); }),

  kvGet: async (k) => (await db.get('kv', k))?.v,
  kvSet: (k, v) => db.put('kv', { k, v }),
};

/** Pide a Safari que no borre los datos locales por falta de espacio (si lo permite). */
export async function requestPersistence() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch { /* no soportado */ }
  return false;
}

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
