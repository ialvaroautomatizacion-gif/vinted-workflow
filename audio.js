/**
 * Grabación continua del micrófono.
 * Un "segmento" = una grabación ininterrumpida con un único MediaRecorder.
 * Solo se abre un segmento nuevo si iOS interrumpe la grabación (llamada, bloqueo, recarga...).
 * El grabador entrega un trozo cada CONFIG.AUDIO_TIMESLICE_MS; cada trozo se guarda en el móvil al instante,
 * así que un cierre inesperado pierde como mucho esos últimos segundos.
 * Unir los trozos (o los fragmentos subidos a Drive) en orden, byte a byte, da el archivo completo del segmento.
 */
import { CONFIG } from './config.js';

const WEBM = ['audio/webm;codecs=opus', 'audio/webm'];
const MP4 = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'];

/** @param {'auto'|'mp4'|'webm'} prefer */
export function pickAudioMime(prefer = 'auto') {
  if (typeof MediaRecorder === 'undefined') return null;
  const order = prefer === 'mp4' ? [...MP4, ...WEBM] : [...WEBM, ...MP4];
  for (const m of order) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* */ } }
  return '';
}

export function supportedAudioFormats() {
  const ok = list => list.some(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
  if (typeof MediaRecorder === 'undefined') return { webm: false, mp4: false };
  return { webm: ok(WEBM), mp4: ok(MP4) };
}

export class SegmentRecorder {
  /**
   * @param {MediaStreamTrack} track pista de audio
   * @param {object} o { clock, prefer, onChunk(blob, startMs, endMs), onError(msg) }
   */
  constructor(track, { clock, prefer = 'auto', onChunk, onError }) {
    this.track = track; this.clock = clock; this.prefer = prefer; this.onChunk = onChunk; this.onError = onError;
    this.rec = null; this.startMs = null; this.lastEnd = null; this.stopping = null;
    this.lastChunkAt = 0;
  }

  start() {
    const mime = pickAudioMime(this.prefer);
    const opts = { audioBitsPerSecond: CONFIG.AUDIO_BITRATE };
    if (mime) opts.mimeType = mime;
    try { this.rec = new MediaRecorder(new MediaStream([this.track]), opts); }
    catch { this.rec = new MediaRecorder(new MediaStream([this.track])); } // sin opciones, por si el navegador las rechaza
    this.mimeType = this.rec.mimeType || mime || 'audio/mp4';
    this.startMs = this.clock.elapsed();
    this.lastEnd = this.startMs;
    this.lastChunkAt = performance.now();
    this.rec.addEventListener('start', () => {
      // Hora real de arranque (más precisa que la del momento de la llamada)
      const t = this.clock.elapsed();
      this.startMs = t; this.lastEnd = t;
      this.lastChunkAt = performance.now();
    });
    this.rec.addEventListener('dataavailable', (e) => {
      const end = this.clock.elapsed();
      if (e.data && e.data.size > 0) {
        const start = this.lastEnd;
        this.lastEnd = end;
        this.lastChunkAt = performance.now();
        this.onChunk(e.data, start, end);
      }
    });
    this.rec.addEventListener('error', (e) => this.onError?.('MediaRecorder: ' + (e.error?.message || e.error?.name || 'error')));
    this.rec.start(CONFIG.AUDIO_TIMESLICE_MS);
    return this.mimeType;
  }

  get state() { return this.rec?.state || 'inactive'; }

  /** Milisegundos desde el último trozo recibido (para detectar un grabador parado). */
  get silenceMs() { return performance.now() - this.lastChunkAt; }

  /** Detiene y espera al último trozo. */
  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = new Promise(resolve => {
      // Si ya se paró solo (iOS cortó la pista), su último trozo puede estar todavía de camino
      if (!this.rec || this.rec.state === 'inactive') return setTimeout(() => resolve(this.lastEnd), 250);
      const done = () => setTimeout(() => resolve(this.lastEnd), 80); // el último dataavailable llega antes de 'stop'
      this.rec.addEventListener('stop', done, { once: true });
      try { this.rec.stop(); } catch { done(); }
      setTimeout(() => resolve(this.lastEnd), 4000); // seguridad
    });
    return this.stopping;
  }
}
