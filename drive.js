/**
 * Cliente mínimo de la API de Google Drive v3 (llamadas directas desde el navegador con el token del usuario).
 * Cada archivo/carpeta creado lleva appProperties.vwId = identificador estable. Antes de crear algo se busca
 * por ese identificador: así un reintento nunca crea duplicados.
 */
import { auth, invalidateToken } from './auth.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MULTIPART_MAX = 4 * 1024 * 1024;

export class DriveError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function request(method, url, { json, body, headers = {} } = {}) {
  const tok = auth.token;
  if (!tok) throw new DriveError('Sin acceso a Drive (hay que volver a entrar con Google)', 401);
  const h = { Authorization: `Bearer ${tok}`, ...headers };
  if (json !== undefined) { h['Content-Type'] = 'application/json; charset=UTF-8'; body = JSON.stringify(json); }
  let res;
  try {
    res = await fetch(url, { method, headers: h, body });
  } catch (e) {
    throw new DriveError('Sin conexión con Drive', 0);
  }
  if (res.status === 401) { invalidateToken(); throw new DriveError('El acceso a Drive ha caducado', 401); }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* */ }
    throw new DriveError(`Drive ${res.status}: ${detail}`.trim(), res.status);
  }
  return res;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const transient = e => e instanceof DriveError && (e.status === 429 || e.status >= 500 || (e.status === 0 && navigator.onLine));

/** Repite la operación ante fallos pasajeros de Drive (errores 5xx, límite de peticiones, microcortes de red). */
async function retrying(fn, delays = [800, 2500]) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= delays.length || !transient(e)) throw e;
      await wait(delays[i]);
    }
  }
}

const q = s => encodeURIComponent(s);
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export const drive = {
  folderUrl: id => `https://drive.google.com/drive/folders/${id}`,

  async whoAmI() {
    const r = await retrying(() => request('GET', `${API}/about?fields=user(emailAddress,displayName)`));
    return (await r.json()).user;
  },

  async findByVwId(vwId) {
    const query = `appProperties has { key='vwId' and value='${esc(vwId)}' } and trashed=false`;
    const r = await retrying(() => request('GET', `${API}/files?q=${q(query)}&fields=files(id,name,size,parents)&spaces=drive&pageSize=10`));
    const files = (await r.json()).files || [];
    return files[0] || null;
  },

  async getFile(id, fields = 'id,name,size,trashed,parents') {
    const r = await retrying(() => request('GET', `${API}/files/${id}?fields=${q(fields)}`));
    return r.json();
  },

  /** true si la carpeta existe y no está en la papelera */
  async folderAlive(id) {
    try { const f = await drive.getFile(id, 'id,trashed'); return !f.trashed; }
    catch (e) { if (e.status === 404) return false; throw e; }
  },

  async ensureFolder(name, parentId, vwId) {
    const found = await drive.findByVwId(vwId);
    if (found) return found.id;
    const meta = { name, mimeType: FOLDER_MIME, appProperties: { vwId, vwApp: '1' } };
    if (parentId) meta.parents = [parentId];
    const r = await request('POST', `${API}/files?fields=id`, { json: meta });
    return (await r.json()).id;
  },

  /** Sube un archivo nuevo. Devuelve { id, size }. Cada reintento vuelve a comprobar si ya existe (sin duplicados). */
  upload(args) { return retrying(() => drive.uploadOnce(args)); },

  async uploadOnce({ blob, name, parentId, mimeType, vwId, props = {} }) {
    const existing = await drive.findByVwId(vwId);
    if (existing && Number(existing.size || 0) === blob.size) return { id: existing.id, size: blob.size, reused: true };
    if (existing) {
      // Quedó una copia incompleta de un intento anterior: se sustituye su contenido
      const j = await drive.updateContent(existing.id, blob, mimeType);
      return { id: j.id, size: Number(j.size) };
    }
    const meta = { name, parents: [parentId], mimeType, appProperties: { vwId, vwApp: '1', ...props } };
    if (blob.size > MULTIPART_MAX) {
      // Archivos grandes: subida reanudable en una sola petición PUT
      const init = await request('POST', `${UPLOAD}/files?uploadType=resumable&fields=id,size`, {
        json: meta, headers: { 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(blob.size) },
      });
      let location = init.headers.get('Location');
      const uploadId = init.headers.get('X-GUploader-UploadID');
      if (!location && uploadId) location = `${UPLOAD}/files?uploadType=resumable&fields=id,size&upload_id=${q(uploadId)}`;
      if (location) {
        let res;
        try { res = await fetch(location, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob }); }
        catch { throw new DriveError('Subida interrumpida (sin conexión)', 0); }
        if (!res.ok) throw new DriveError(`Drive ${res.status} al subir ${name}`, res.status);
        const j = await res.json();
        return { id: j.id, size: Number(j.size) };
      }
      // Si el navegador no deja leer la URL de subida, se intenta en una sola pieza
    }
    const boundary = 'vw' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, blob, `\r\n--${boundary}--`,
    ]);
    const r = await request('POST', `${UPLOAD}/files?uploadType=multipart&fields=id,size`, {
      body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    });
    const j = await r.json();
    return { id: j.id, size: Number(j.size) };
  },

  /** Reemplaza el contenido de un archivo existente (manifiesto, resumen). */
  async updateContent(fileId, blob, mimeType) {
    const r = await retrying(() => request('PATCH', `${UPLOAD}/files/${fileId}?uploadType=media&fields=id,size`, {
      body: blob, headers: { 'Content-Type': mimeType },
    }));
    return r.json();
  },

  async move(fileId, addParent, removeParent) {
    const r = await retrying(() => request('PATCH',
      `${API}/files/${fileId}?addParents=${q(addParent)}&removeParents=${q(removeParent)}&fields=id,parents`, { json: {} }));
    return r.json();
  },

  /**
   * Envía una carpeta de sesión a la PAPELERA de Drive (recuperable 30 días).
   * Solo actúa si la carpeta lleva la marca de esa sesión.
   */
  async trashSessionFolder(folderId, sessionId) {
    const f = await drive.getFile(folderId, 'id,trashed,mimeType,appProperties');
    if (f.mimeType !== FOLDER_MIME || f.appProperties?.vwId !== `${sessionId}_DIR`) {
      throw new DriveError('La carpeta no corresponde a esta sesión; no se toca.', 409);
    }
    if (f.trashed) return true;
    await request('PATCH', `${API}/files/${folderId}?fields=id,trashed`, { json: { trashed: true } });
    return true;
  },
};
