/**
 * Acceso a Google con Google Identity Services (biblioteca oficial).
 * Se pide solo el permiso drive.file. El token dura ~1 hora (límite de Google); se guarda en sessionStorage
 * (solo esta pestaña) para sobrevivir a una recarga durante la sesión.
 */
import { CONFIG } from './config.js';

const KEY = 'vw_token';
let tokenClient = null;
let token = null; // { access_token, expiresAt, email }
let expiryTimer = null;
const listeners = new Set();

export const auth = {
  onChange(fn) { listeners.add(fn); },
  get token() { return token && token.expiresAt > Date.now() + 30000 ? token.access_token : null; },
  get email() { return token?.email || null; },
  minutesLeft() { return token ? Math.max(0, Math.floor((token.expiresAt - Date.now()) / 60000)) : 0; },
  isValid() { return !!auth.token; },
  get ready() { return !!tokenClient; },
  init, signIn, signOut, setEmail,
};

function emit() { listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }

function save() {
  try { if (token) sessionStorage.setItem(KEY, JSON.stringify(token)); else sessionStorage.removeItem(KEY); } catch { /* */ }
  clearTimeout(expiryTimer);
  // Avisar a la interfaz justo cuando caduque
  if (token && token.expiresAt > Date.now()) expiryTimer = setTimeout(emit, Math.max(1000, token.expiresAt - Date.now() - 29000));
}

async function waitForGis(timeoutMs = 15000) {
  const t0 = Date.now();
  while (!window.google?.accounts?.oauth2) {
    if (Date.now() - t0 > timeoutMs) throw new Error('No se pudo cargar el inicio de sesión de Google. Revisa la conexión o desactiva los bloqueadores de contenido para esta página.');
    await new Promise(r => setTimeout(r, 100));
  }
}

async function init() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (saved && saved.expiresAt > Date.now() + 60000) { token = saved; save(); }
  } catch { /* nada */ }
  emit();
  await waitForGis();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPE,
    callback: () => {}, // se sustituye en cada petición
  });
  emit();
}

const ERRORS = {
  popup_closed: 'Se cerró la ventana de Google antes de terminar.',
  popup_failed_to_open: 'Safari ha bloqueado la ventana de Google. Vuelve a pulsar el botón; si sigue igual, desactiva "Bloquear ventanas" en Ajustes › Apps › Safari.',
  access_denied: 'No se concedió el permiso. Si Google dice que la app está bloqueada, esa cuenta no está en la lista de usuarios de prueba.',
};

/**
 * Abre la ventana de Google. DEBE llamarse directamente desde un toque del usuario
 * (Safari bloquea ventanas emergentes que no salen de un toque).
 */
function signIn({ switchAccount = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error('Google todavía se está cargando. Espera un par de segundos y vuelve a pulsar.'));
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(ERRORS[resp.error] || resp.error_description || resp.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, CONFIG.SCOPE)) {
        return reject(new Error('No se concedió el permiso de Google Drive (hay que dejar marcada la casilla de acceso a archivos).'));
      }
      token = {
        access_token: resp.access_token,
        expiresAt: Date.now() + (Number(resp.expires_in) || 3599) * 1000,
        email: switchAccount ? null : (token?.email || null),
      };
      save(); emit(); resolve(token);
    };
    tokenClient.error_callback = (err) => reject(new Error(ERRORS[err?.type] || err?.message || 'Inicio de sesión cancelado'));
    const hint = token?.email || CONFIG.ALLOWED_EMAILS[0];
    const opts = { prompt: (switchAccount || !token) ? 'select_account' : '' };
    if (hint && !switchAccount) opts.login_hint = hint;
    tokenClient.requestAccessToken(opts);
  });
}

function setEmail(email) {
  if (token) { token.email = email; save(); emit(); }
}

/** Olvida el acceso en este navegador (no revoca el permiso en Google: eso se hace en myaccount.google.com/permissions). */
function signOut() {
  token = null; save(); emit();
}

/** Marca el token como caducado (p.ej. si Drive responde 401). */
export function invalidateToken() {
  if (token) { token.expiresAt = 0; save(); emit(); }
}
