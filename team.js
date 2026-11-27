/**
 * Equipo: varias personas suben a la MISMA carpeta de Drive (la de la cuenta dueña).
 *
 * - La cuenta dueña (CONFIG.OWNER_EMAIL) trabaja como siempre: VINTED_WORKFLOW/AAAA-MM-DD/PRENDA_…
 * - Un colaborador entra con su propia cuenta de Google. La primera vez elige, con el selector oficial de
 *   Google (Picker), la carpeta VINTED_WORKFLOW que la dueña le ha compartido. Con el permiso drive.file,
 *   elegirla da a la app permiso para crear carpetas y archivos dentro de ella (y nada más del Drive de nadie).
 *   Sus prendas van a VINTED_WORKFLOW/<Nombre>/AAAA-MM-DD/PRENDA_…
 */
import { CONFIG } from './config.js';
import { db } from './db.js';
import { auth } from './auth.js';
import { drive } from './drive.js';

const lc = s => (s || '').toLowerCase();

export const team = {
  /** true si la cuenta conectada es la dueña de la carpeta (o si no hay equipo configurado). */
  isOwner(email = auth.email) { return !CONFIG.OWNER_EMAIL || lc(email) === lc(CONFIG.OWNER_EMAIL); },
  /** Nombre de la subcarpeta del colaborador dentro de la carpeta compartida. */
  userDir(email = auth.email) {
    const e = lc(email);
    const named = Object.entries(CONFIG.TEAM_NAMES || {}).find(([k]) => lc(k) === e);
    return named ? named[1] : (e.split('@')[0] || 'colaborador').replace(/[^\w.-]+/g, '_');
  },
  key(email = auth.email) { return `sharedRoot:${lc(email)}`; },
  async sharedRoot(email = auth.email) { return (await db.kvGet(team.key(email))) || null; },
  async setSharedRoot(id, email = auth.email) { await db.kvSet(team.key(email), id); },
  /** Colaborador conectado que aún no ha elegido la carpeta compartida. */
  async needsSetup() {
    if (!auth.isValid() || !auth.email || team.isOwner()) return false;
    return !(await team.sharedRoot());
  },
};

// ---------------- Selector de carpetas de Google (Picker) ----------------
let pickerReady = null;

/** Carga la biblioteca del selector (se llama al entrar un colaborador, antes del toque). */
export function loadPicker() {
  if (pickerReady) return pickerReady;
  pickerReady = new Promise((resolve, reject) => {
    const done = () => window.gapi.load('picker', { callback: () => resolve(true), onerror: () => reject(new Error('No se pudo cargar el selector de Google')) });
    if (window.gapi?.load) return done();
    const sc = document.createElement('script');
    sc.src = 'https://apis.google.com/js/api.js';
    sc.async = true;
    sc.onload = done;
    sc.onerror = () => reject(new Error('No se pudo cargar el selector de Google (revisa la conexión)'));
    document.head.appendChild(sc);
  });
  pickerReady.catch(() => { pickerReady = null; });
  return pickerReady;
}

/**
 * Abre el selector para que el colaborador elija la carpeta compartida.
 * Devuelve { id, name } o null si cancela.
 */
export async function pickSharedFolder() {
  await loadPicker();
  const P = window.google.picker;
  return new Promise((resolve) => {
    const shared = new P.DocsView(P.ViewId.FOLDERS)
      .setIncludeFolders(true).setSelectFolderEnabled(true)
      .setMimeTypes('application/vnd.google-apps.folder')
      ;
    if (typeof shared.setOwnedByMe === 'function') shared.setOwnedByMe(false);
    if (CONFIG.SHARED_ROOT_ID && typeof shared.setFileIds === 'function') shared.setFileIds(CONFIG.SHARED_ROOT_ID);
    const builder = new P.PickerBuilder()
      .setAppId(CONFIG.GCP_PROJECT_NUMBER)
      .setDeveloperKey(CONFIG.PICKER_API_KEY)
      .setOAuthToken(auth.token)
      .addView(shared)
      .setTitle('Elige la carpeta VINTED_WORKFLOW compartida')
      .setLocale('es')
      .setCallback((data) => {
        const action = data[P.Response.ACTION];
        if (action === P.Action.PICKED) {
          const doc = data[P.Response.DOCUMENTS]?.[0];
          resolve(doc ? { id: doc[P.Document.ID], name: doc[P.Document.NAME] } : null);
        } else if (action === P.Action.CANCEL) resolve(null);
      });
    if (P.Feature?.SUPPORT_DRIVES) builder.enableFeature(P.Feature.SUPPORT_DRIVES);
    builder.build().setVisible(true);
  });
}

/**
 * Comprueba que la carpeta elegida es la correcta y que la app puede escribir en ella
 * (crea y deja la subcarpeta del colaborador). Devuelve el id de la carpeta raíz.
 */
export async function confirmSharedFolder(picked) {
  if (CONFIG.SHARED_ROOT_ID && picked.id !== CONFIG.SHARED_ROOT_ID) {
    throw new Error(`Esa no es la carpeta del equipo. Elige «${CONFIG.ROOT_FOLDER_NAME}» (compartida por ${CONFIG.OWNER_EMAIL}).`);
  }
  // Prueba real de escritura: crear (o reutilizar) la subcarpeta del colaborador
  await drive.ensureFolder(team.userDir(), picked.id, `VW_USER_${lc(auth.email)}`);
  await team.setSharedRoot(picked.id);
  return picked.id;
}
