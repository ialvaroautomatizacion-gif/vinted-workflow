/**
 * Gestión de la sesión: inicio, fotos, audio continuo, interrupciones, reanudación y cierre.
 */
import { CONFIG } from './config.js';
import { db } from './db.js';
import { Capture, LevelMeter, makeThumb } from './capture.js';
import { SegmentRecorder } from './audio.js';
import { saveSession, addIncident, photosOf } from './store.js';
import { sync } from './sync.js';
import { SessionClock, folderNameFor, randomId, pad, fmtDuration, extFor, log } from './util.js';

const tStr = ms => fmtDuration(ms).replace(/:/g, '-') + '.' + String(Math.max(0, ms) % 1000).padStart(3, '0');

export function newSessionRecord(startEpoch) {
  const d = new Date(startEpoch);
  return {
    id: `S${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${randomId(4)}`,
    folderName: folderNameFor(startEpoch),
    startEpoch,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'desconocida',
    utcOffsetMin: -d.getTimezoneOffset(),
    endEpoch: null,
    status: 'active',
    photoSeq: 0,
    segments: [],
    gaps: [],
    incidents: [],
    drive: {},
    heartbeatMs: 0,
    manifestDirty: true,
    verified: false,
    userAgent: navigator.userAgent,
  };
}

/** Cierra el segmento abierto de una sesión que quedó a medias (página cerrada, Safari suspendido...). */
export function closeOrphanSegments(s, reason = 'cierre_inesperado') {
  let changed = false;
  for (const g of s.segments) {
    if (g.endMs == null) {
      g.endMs = g.lastEndMs ?? g.startMs;
      g.endReason = reason;
      changed = true;
    }
  }
  if (changed) { addIncident(s, s.heartbeatMs, 'sesion_interrumpida', 'la página se cerró o se recargó durante la grabación'); }
  return changed;
}

export class SessionController {
  constructor(videoEl, ui) {
    this.video = videoEl;
    this.ui = ui; // { onTick, onLevel, onPhoto, onInterrupted(msg), onRecovered(), onWarn(msg) }
    this.s = null; this.clock = null; this.capture = null; this.recorder = null; this.meter = null;
    this.seg = null; this.chunkQ = Promise.resolve(); this.photoQ = Promise.resolve();
    this.interrupting = false; this.recovering = false; this.muteTimers = {};
    this.photoMode = 'auto';
    this._onVis = () => this.onVisibility();
    this._onUnload = (e) => { if (this.s?.status === 'active') { e.preventDefault(); e.returnValue = ''; } };
    this._onHide = () => { if (this.s) { this.s.heartbeatMs = this.clock.elapsed(); saveSession(this.s); } };
  }

  get active() { return !!this.s && this.s.status === 'active'; }
  get elapsed() { return this.clock ? this.clock.elapsed() : 0; }

  // ---------- Inicio / reanudación ----------
  async startNew(photoMode) {
    this.photoMode = photoMode;
    const s = newSessionRecord(Date.now());
    this.s = s; this.clock = new SessionClock(s.startEpoch);
    await saveSession(s);
    try {
      await this.startCapture('inicio');
    } catch (e) {
      // Sin cámara/micrófono no hay sesión: se deja registrada como fallida
      addIncident(s, this.clock, 'error_permisos', e.message);
      s.status = 'failed'; s.endEpoch = Date.now();
      await saveSession(s);
      this.capture?.stop(); this.capture = null;
      this.s = null;
      throw e;
    }
    this.attachListeners();
    sync.kick();
    return s;
  }

  async resume(s, photoMode) {
    this.photoMode = photoMode;
    closeOrphanSegments(s);
    s.status = 'active';
    this.s = s; this.clock = new SessionClock(s.startEpoch);
    addIncident(s, this.clock, 'sesion_reanudada');
    await saveSession(s);
    await this.startCapture('reanudacion');
    this.attachListeners();
    sync.kick();
    return s;
  }

  attachListeners() {
    document.addEventListener('visibilitychange', this._onVis);
    window.addEventListener('beforeunload', this._onUnload);
    window.addEventListener('pagehide', this._onHide);
    clearInterval(this.hb);
    this.hb = setInterval(() => {
      if (!this.s) return;
      this.s.heartbeatMs = this.clock.elapsed();
      saveSession(this.s);
    }, 5000);
    clearInterval(this.tick);
    this.tick = setInterval(() => this.ui.onTick?.(this.clock.elapsed()), 500);
  }

  teardownListeners() {
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('beforeunload', this._onUnload);
    window.removeEventListener('pagehide', this._onHide);
    clearInterval(this.hb); clearInterval(this.tick);
  }

  /** Arranca cámara + micrófono + un segmento de audio nuevo. */
  async startCapture(reason) {
    const s = this.s;
    this.capture = new Capture(this.video, { photoMode: this.photoMode, onTrackEvent: (k, ev) => this.onTrackEvent(k, ev) });
    await this.capture.start();
    s.captureInfo = this.capture.info();
    addIncident(s, this.clock, 'captura_iniciada', `${reason}; foto=${s.captureInfo.mode} ${s.captureInfo.width}x${s.captureInfo.height}`);

    const prev = s.segments[s.segments.length - 1];
    const g = { seg: (prev?.seg || 0) + 1, startMs: this.clock.elapsed(), endMs: null, endReason: null, chunkCount: 0, nextSeq: 0, parts: [], mimeType: null };
    if (prev) {
      g.gapIndex = s.gaps.length;
      s.gaps.push({ fromMs: prev.endMs ?? prev.lastEndMs ?? prev.startMs, toMs: g.startMs, reason: prev.endReason || reason });
    }
    s.segments.push(g);
    this.seg = g;

    this.recorder = new SegmentRecorder(this.capture.audioTrack, {
      clock: this.clock,
      onChunk: (blob, start, end) => this.onChunk(g, blob, start, end),
      onError: (msg) => { addIncident(s, this.clock, 'error_grabador', msg); this.interrupt('Error del grabador de audio'); },
    });
    g.mimeType = this.recorder.start();
    await saveSession(s);

    this.meter?.stop();
    this.meter = new LevelMeter(this.capture.audioTrack, lvl => this.ui.onLevel?.(lvl));
    await this.acquireWakeLock();
    log('captura iniciada', reason, g);
  }

  onChunk(g, blob, startMs, endMs) {
    const s = this.s;
    const seq = g.nextSeq++;
    this.chunkQ = this.chunkQ.then(async () => {
      await db.put('chunks', { sessionId: s.id, seg: g.seg, seq, blob, startMs, endMs, size: blob.size });
      if (seq === 0) {
        g.startMs = startMs; // hora real de arranque del grabador
        if (g.gapIndex != null) s.gaps[g.gapIndex].toMs = startMs;
      }
      g.chunkCount = seq + 1;
      g.lastEndMs = endMs;
      g.bytes = (g.bytes || 0) + blob.size;
      await saveSession(s);
    }).catch(e => {
      addIncident(s, this.clock, 'error_guardando_audio', e.message);
      this.ui.onWarn?.('No se pudo guardar audio en el móvil (¿sin espacio?)');
    });
    if ((seq + 1) % CONFIG.AUDIO_CHUNKS_PER_PART === 0) this.chunkQ.then(() => sync.kick());
  }

  async closeSegment(reason) {
    const g = this.seg;
    if (!g || g.endMs != null) return;
    const rec = this.recorder; this.recorder = null;
    if (rec) await rec.stop();
    await this.chunkQ;
    g.endMs = g.lastEndMs ?? this.clock.elapsed();
    g.endReason = reason;
    this.seg = null;
    await saveSession(this.s);
  }

  async acquireWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { addIncident(this.s, this.clock, 'pantalla_activa_no_disponible', e.message); }
  }

  // ---------- Fotos ----------
  takePhoto() {
    const s = this.s;
    if (!this.capture?.stream) return Promise.reject(new Error('La cámara no está activa'));
    const elapsedMs = this.clock.elapsed(); // instante del toque
    const seq = ++s.photoSeq;
    const run = async () => {
      const shot = await this.capture.takePhoto();
      const mime = shot.blob.type || 'image/jpeg';
      const id = `${s.id}_F${pad(seq, 4)}`;
      const photo = {
        id, sessionId: s.id, seq, elapsedMs, epoch: s.startEpoch + elapsedMs,
        fileName: `foto_${pad(seq, 4)}_t${tStr(elapsedMs)}.${extFor(mime)}`,
        mime, size: shot.blob.size, width: shot.width, height: shot.height, method: shot.method,
        status: 'pending', driveId: null, thumb: await makeThumb(shot.blob),
      };
      await db.put('blobs', { id, blob: shot.blob });
      await db.put('photos', photo);
      s.manifestDirty = true;
      await saveSession(s);
      this.ui.onPhoto?.(photo);
      sync.kick();
      return photo;
    };
    // Fotos en serie para no saturar la cámara del iPhone
    const p = this.photoQ.then(run);
    this.photoQ = p.catch(e => { addIncident(s, this.clock, 'error_foto', e.message); });
    return p;
  }

  async deletePhoto(photo) {
    photo.status = 'deleted';
    photo.deletedAt = Date.now();
    await db.put('photos', photo);
    this.s.manifestDirty = true;
    addIncident(this.s, this.clock, 'foto_eliminada', photo.fileName);
    await saveSession(this.s);
    sync.kick();
  }

  // ---------- Interrupciones ----------
  onTrackEvent(kind, ev) {
    if (!this.s) return;
    addIncident(this.s, this.clock, `pista_${kind}_${ev}`);
    if (this.interrupting) return;
    if (ev === 'ended') return this.interrupt(kind === 'audio' ? 'iOS ha cortado el micrófono' : 'iOS ha cortado la cámara');
    if (ev === 'mute') {
      clearTimeout(this.muteTimers[kind]);
      this.muteTimers[kind] = setTimeout(() => {
        const t = kind === 'audio' ? this.capture?.audioTrack : this.capture?.videoTrack;
        if (t?.muted && document.visibilityState === 'visible') {
          this.interrupt(kind === 'audio' ? 'El micrófono se ha silenciado' : 'La cámara se ha pausado');
        }
      }, 3000);
    }
    if (ev === 'unmute') clearTimeout(this.muteTimers[kind]);
  }

  onVisibility() {
    if (!this.s) return;
    const vis = document.visibilityState;
    addIncident(this.s, this.clock, vis === 'visible' ? 'app_visible' : 'app_en_segundo_plano');
    if (vis !== 'visible') return;
    this.acquireWakeLock();
    setTimeout(() => {
      if (!this.active) return;
      if (this.interrupting) { this.tryAutoRecover(); return; }
      const h = this.capture?.healthy() || {};
      const recOk = this.recorder?.state === 'recording';
      if (!h.audio || !h.video || !recOk) {
        this.interrupt(`Al volver a la app: micro ${h.audio ? 'ok' : 'parado'}, cámara ${h.video ? 'ok' : 'parada'}, grabador ${this.recorder?.state || 'parado'}`);
      }
    }, 1500);
  }

  async interrupt(reason) {
    if (this.interrupting || !this.active) return;
    this.interrupting = true;
    addIncident(this.s, this.clock, 'interrupcion', reason);
    this.meter?.stop(); this.meter = null;
    await this.closeSegment('interrupcion');
    this.capture?.stop(); this.capture = null;
    try { await this.wakeLock?.release(); } catch { /* */ }
    sync.kick();
    this.lastReason = reason;
    if (document.visibilityState === 'visible') await this.tryAutoRecover();
  }

  /** Intenta reanudar solo. Si iOS exige un toque, muestra el botón REANUDAR GRABACIÓN. */
  async tryAutoRecover() {
    if (this.recovering || !this.interrupting) return;
    this.recovering = true;
    try {
      await this.startCapture('reanudacion_automatica');
      this.interrupting = false;
      this.ui.onRecovered?.();
    } catch (e) {
      addIncident(this.s, this.clock, 'reanudacion_automatica_fallida', e.message);
      this.ui.onInterrupted?.(this.lastReason || 'Grabación interrumpida');
    } finally { this.recovering = false; }
  }

  /** Reanudación manual (desde el botón): cuenta como gesto del usuario. */
  async recoverManual() {
    this.recovering = true;
    try {
      this.capture?.stop();
      await this.startCapture('reanudacion_manual');
      this.interrupting = false;
      this.ui.onRecovered?.();
    } finally { this.recovering = false; }
  }

  // ---------- Fin ----------
  async finish() {
    const s = this.s;
    this.teardownListeners();
    await this.photoQ;
    await this.closeSegment('fin');
    this.meter?.stop(); this.meter = null;
    this.capture?.stop(); this.capture = null;
    try { await this.wakeLock?.release(); } catch { /* */ }
    s.endEpoch = s.startEpoch + this.clock.elapsed();
    s.heartbeatMs = this.clock.elapsed();
    s.status = 'finishing';
    addIncident(s, this.clock, 'sesion_terminada');
    s.manifestDirty = true;
    await saveSession(s);
    this.s = null;
    return s;
  }

  async photos() { return this.s ? photosOf(this.s.id) : []; }
}

/** Termina (sin reanudar) una sesión que quedó a medias. */
export async function finishOrphan(s) {
  closeOrphanSegments(s);
  s.endEpoch = s.startEpoch + (s.heartbeatMs || Math.max(0, ...s.segments.map(g => g.endMs || 0)));
  s.status = 'finishing';
  addIncident(s, s.heartbeatMs, 'sesion_terminada_sin_reanudar');
  s.manifestDirty = true;
  await saveSession(s);
  return s;
}
