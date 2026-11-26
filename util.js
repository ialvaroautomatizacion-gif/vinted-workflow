/** Utilidades comunes: reloj de sesión, formatos y ajustes. */

/**
 * Reloj de sesión.
 * elapsed() = milisegundos desde el inicio de la sesión.
 * Dentro de una misma carga de página usa performance.now() (monotónico: no salta si cambia la hora del sistema).
 * Se re-ancla con la hora del sistema al reanudar tras recargar, o si iOS congeló la página
 * (resyncIfDrifted), y en ese caso la sesión abre un segmento de audio nuevo para seguir cuadrando.
 */
export class SessionClock {
  constructor(startEpoch) {
    this.startEpoch = startEpoch;
    this.anchor();
  }
  anchor() {
    this.base = Date.now() - this.startEpoch;
    this.perf0 = performance.now();
  }
  elapsed() { return Math.max(0, Math.round(this.base + (performance.now() - this.perf0))); }
  /** Diferencia (ms) entre el reloj monotónico y la hora del sistema. */
  drift() { return (Date.now() - this.startEpoch) - this.elapsed(); }
  /** Si el reloj monotónico se quedó atrás (página congelada), lo re-ancla. Devuelve el desfase corregido o 0. */
  resyncIfDrifted(toleranceMs = 2000) {
    const d = this.drift();
    if (Math.abs(d) <= toleranceMs) return 0;
    this.anchor();
    return d;
  }
}

export const pad = (n, w = 2) => String(n).padStart(w, '0');

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** 00-01-23.456 (para nombres de archivo) */
export const fmtStamp = ms => fmtDuration(ms).replace(/:/g, '-') + '.' + pad(Math.max(0, Math.round(ms)) % 1000, 3);

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
  if (mime.includes('heic') || mime.includes('heif')) return 'heic';
  return 'bin';
}

export const escapeHtml = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Ajustes del usuario (se recuerdan en este navegador). */
export const settings = {
  get(key, def) { try { const v = localStorage.getItem('vw_' + key); return v == null ? def : v; } catch { return def; } },
  set(key, v) { try { localStorage.setItem('vw_' + key, v); } catch { /* */ } },
};

/**
 * Mide la duración real (ms) de un audio grabado, reproduciéndolo en silencio.
 * Sirve para detectar grabaciones cortadas o con huecos. Devuelve null si el navegador no puede medirlo.
 */
export function measureAudioDurationMs(blob, timeoutMs = 6000) {
  return new Promise(resolve => {
    let done = false;
    const a = document.createElement('audio');
    const url = URL.createObjectURL(blob);
    const finish = v => {
      if (done) return; done = true;
      clearTimeout(timer);
      a.removeAttribute('src'); try { a.load(); } catch { /* */ }
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const check = () => {
      const d = a.duration;
      if (Number.isFinite(d) && d > 0) finish(Math.round(d * 1000));
    };
    a.preload = 'metadata';
    a.muted = true;
    a.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(a.duration) && a.duration > 0) return finish(Math.round(a.duration * 1000));
      // Los archivos grabados a trozos no declaran duración: saltar al final obliga al navegador a calcularla
      try { a.currentTime = 1e7; } catch { finish(null); }
    });
    a.addEventListener('durationchange', check);
    a.addEventListener('seeked', check);
    a.addEventListener('timeupdate', check);
    a.addEventListener('error', () => finish(null));
    a.src = url;
    try { a.load(); } catch { /* */ }
  });
}

export function log(...args) { console.log('[VW]', ...args); }
