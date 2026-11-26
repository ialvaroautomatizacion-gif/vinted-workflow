/**
 * Acceso a Google con Google Identity Services (biblioteca oficial).
 * Se pide solo el permiso drive.file. El token dura ~1 hora; se guarda en sessionStorage
 * (solo esta pestaña) para sobrevivir a una recarga durante la sesión.
 */
import { CONFIG } from './config.js';

const KEY = 'vw_token';
let tokenClient = null;
let token = null; // { access_token, expiresAt, email }
const listeners = new Set();

export const auth = {
  onChange(fn) { listeners.add(fn); },
  get token() { return token && token.expiresAt > Date.now() + 30000 ? token.access_token : null; },
  get email() { return token?.email || null; },
  minutesLeft() { return token ? Math.max(0, Math.floor((token.expiresAt - Date.now()) / 60000)) : 0; },
  isValid() { return !!auth.token; },
  init, signIn, signOut, setEmail,
};

function emit() { listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }

function save() {
  if (token) sessionStorage.setItem(KEY, JSON.stringify(token)); else sessionStorage.removeItem(KEY);
}

async function waitForGis(timeoutMs = 15000) {
  const t0 = Date.now();
  while (!window.google?.accounts?.oauth2) {
    if (Date.now() - t0 > timeoutMs) throw new Error('No se pudo cargar el inicio de sesión de Google. Revisa la conexión.');
    await new Promise(r => setTimeout(r, 100));
  }
}

async function init() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (saved && saved.expiresAt > Date.now() + 60000) token = saved;
  } catch { /* nada */ }
  emit();
  await waitForGis();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPE,
    callback: () => {}, // se sustituye en cada petición
  });
}

/**
 * Abre la ventana de Google. DEBE llamarse directamente desde un toque del usuario
 * (Safari bloquea ventanas emergentes que no salen de un toque).
 */
function signIn() {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error('Google todavía no está listo, espera un segundo.'));
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, CONFIG.SCOPE)) {
        return reject(new Error('No se concedió el permiso de Google Drive.'));
      }
      token = {
        access_token: resp.access_token,
        expiresAt: Date.now() + (Number(resp.expires_in) || 3599) * 1000,
        email: token?.email || null,
      };
      save(); emit(); resolve(token);
    };
    tokenClient.error_callback = (err) => reject(new Error(err?.message || err?.type || 'Inicio de sesión cancelado'));
    const hint = CONFIG.ALLOWED_EMAILS[0];
    tokenClient.requestAccessToken({ prompt: token ? '' : 'select_account', ...(hint ? { login_hint: hint } : {}) });
  });
}

function setEmail(email) {
  if (token) { token.email = email; save(); emit(); }
}

function signOut() {
  if (token?.access_token && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(token.access_token, () => {});
  }
  token = null; save(); emit();
}

/** Marca el token como caducado (p.ej. si Drive responde 401). */
export function invalidateToken() {
  if (token) { token.expiresAt = 0; save(); emit(); }
}
