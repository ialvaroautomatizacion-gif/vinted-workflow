/** Utilidades comunes: reloj de sesión, formatos y registro de eventos. */

/**
 * Reloj de sesión.
 * elapsed() = milisegundos desde el inicio de la sesión.
 * Dentro de una misma carga de página usa performance.now() (monotónico: no salta si cambia la hora del sistema).
 * Al reanudar tras recargar la página, se re-ancla con Date.now() - inicio de sesión.
 */
export class SessionClock {
  constructor(startEpoch) {
    this.startEpoch = startEpoch;
    this.base = Date.now() - startEpoch;
    this.perf0 = performance.now();
  }
  elapsed() { return Math.round(this.base + (performance.now() - this.perf0)); }
  /** Hora absoluta coherente con elapsed() */
  epochAt(elapsedMs) { return this.startEpoch + elapsedMs; }
}

export const pad = (n, w = 2) => String(n).padStart(w, '0');

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** ISO 8601 con desfase local, p.ej. 2026-11-25T11:30:00.123+01:00 */
export function isoLocal(epoch) {
  const d = new Date(epoch);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function fmtDateTime(epoch) {
  const d = new Date(epoch);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function folderNameFor(epoch) {
  const d = new Date(epoch);
  return `SESION_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function randomId(len = 6) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}

export function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Extensión de archivo para un tipo MIME de audio/imagen */
export function extFor(mime) {
  if (!mime) return 'bin';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('heic')) return 'heic';
  return 'bin';
}

/** Registro de eventos en consola (las incidencias de sesión se guardan aparte, en la sesión). */
export function log(...args) { console.log('[VW]', ...args); }
