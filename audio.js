/**
 * Grabación continua del micrófono.
 * Un "segmento" = una grabación ininterrumpida con un único MediaRecorder.
 * Solo se abre un segmento nuevo si iOS interrumpe la grabación (llamada, bloqueo, recarga...).
 * El grabador entrega un trozo cada CONFIG.AUDIO_TIMESLICE_MS; cada trozo se guarda en el móvil al instante,
 * así que un cierre inesperado pierde como mucho esos últimos segundos.
 * Unir los trozos (o los fragmentos subidos a Drive) en orden, byte a byte, da el archivo completo del segmento.
 */
import { CONFIG } from './config.js';

const CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'];

export function pickAudioMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of CANDIDATES) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* */ } }
  return '';
}

export class SegmentRecorder {
  /**
   * @param {MediaStreamTrack} track pista de audio
   * @param {object} o { clock, onChunk(blob, startMs, endMs), onError(msg) }
   */
  constructor(track, { clock, onChunk, onError }) {
    this.track = track; this.clock = clock; this.onChunk = onChunk; this.onError = onError;
    this.rec = null; this.startMs = null; this.lastEnd = null; this.stopping = null;
  }

  start() {
    const mime = pickAudioMime();
    const opts = { audioBitsPerSecond: CONFIG.AUDIO_BITRATE };
    if (mime) opts.mimeType = mime;
    this.rec = new MediaRecorder(new MediaStream([this.track]), opts);
    this.mimeType = this.rec.mimeType || mime || 'audio/mp4';
    this.startMs = this.clock.elapsed();
    this.lastEnd = this.startMs;
    this.rec.addEventListener('start', () => {
      // Hora real de arranque (más precisa que la del momento de la llamada)
      const t = this.clock.elapsed();
      this.startMs = t; this.lastEnd = t;
    });
    this.rec.addEventListener('dataavailable', (e) => {
      const end = this.clock.elapsed();
      if (e.data && e.data.size > 0) {
        const start = this.lastEnd;
        this.lastEnd = end;
        this.onChunk(e.data, start, end);
      }
    });
    this.rec.addEventListener('error', (e) => this.onError?.('MediaRecorder: ' + (e.error?.message || e.error?.name || 'error')));
    this.rec.start(CONFIG.AUDIO_TIMESLICE_MS);
    return this.mimeType;
  }

  get state() { return this.rec?.state || 'inactive'; }

  /** Detiene y espera al último trozo. */
  stop() {
    if (!this.rec || this.rec.state === 'inactive') return Promise.resolve(this.lastEnd);
    if (this.stopping) return this.stopping;
    this.stopping = new Promise(resolve => {
      const done = () => setTimeout(() => resolve(this.lastEnd), 50); // el último dataavailable llega antes de 'stop'
      this.rec.addEventListener('stop', done, { once: true });
      try { this.rec.stop(); } catch { done(); }
      setTimeout(() => resolve(this.lastEnd), 4000); // seguridad
    });
    return this.stopping;
  }
}
