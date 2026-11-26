/**
 * Gestión de la sesión: inicio, fotos, audio continuo, interrupciones, reanudación y cierre.
 *
 * Regla de oro de la sincronización: dentro de un segmento de audio, el archivo avanza al mismo ritmo que
 * el reloj de la sesión. Si algo rompe esa relación (micrófono silenciado por iOS, grabador parado, página
 * congelada), el segmento se cierra y se abre otro, con su propio instante de inicio. Así las fotos y el
 * audio siguen cuadrando aunque haya cortes.
 */
import { CONFIG } from './config.js';
import { db } from './db.js';
import { Capture, LevelMeter, makeThumb } from './capture.js';
import { SegmentRecorder } from './audio.js';
import { saveSession, addIncident, photosOf, updatePhoto } from './store.js';
import { sync } from './sync.js';
import { SessionClock, folderNameFor, randomId, pad, fmtStamp, extFor, sleep, log } from './util.js';

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
    appVersion: CONFIG.APP_VERSION,
    userAgent: navigator.userAgent,
  };
}

/**
 * Deja coherente una sesión que quedó a medias (página cerrada, Safari suspendido...):
 * recupera de la base de datos local los últimos trozos de audio y fotos que llegaron a guardarse
 * y cierra el segmento que estaba abierto.
 */
export async function reconcileOrphan(s, reason = 'cierre_inesperado') {
  let changed = false;
  for (const g of s.segments) {
    if (g.endMs != null) continue;
    const last = await db.lastChunk(s.id, g.seg);
    if (last) { g.chunkCount = last.seq + 1; g.lastEndMs = last.endMs; }
    g.nextSeq = g.chunkCount || 0;
    g.endMs = g.lastEndMs ?? g.startMs;
    g.endReason = reason;
    changed = true;
  }
  const maxSeq = (await photosOf(s.id)).reduce((m, p) => Math.max(m, p.seq), 0);
  if (maxSeq > (s.photoSeq || 0)) { s.photoSeq = maxSeq; changed = true; }
  if (changed) {
    addIncident(s, s.heartbeatMs, 'sesion_interrumpida', 'la página se cerró o se recargó durante la grabación');
    await saveSession(s);
  }
  return changed;
}

export class SessionController {
  constructor(videoEl, ui) {
    this.video = videoEl;
    this.ui = ui; // { onTick, onLevel, onPhoto, onInterrupted(msg), onRecovered(msg), onWarn(msg), onCamera(info) }
    this.opts = { photoMode: 'auto', quality: 'high', deviceId: '', audioFormat: 'auto' };
    this.reset();
    this._onVis = () => this.onVisibility();
    this._onUnload = (e) => { if (this.active) { e.preventDefault(); e.returnValue = ''; } };
    this._onHide = () => { if (this.s && this.clock) { this.s.heartbeatMs = this.clock.elapsed(); saveSession(this.s); } };
  }

  reset() {
    this.s = null; this.clock = null; this.capture = null; this.recorder = null; this.meter = null;
    this.seg = null;
    this.chunkQ = Promise.resolve(); this.photoQ = Promise.resolve(); this.segQ = Promise.resolve();
    this.interrupting = false; this.recovering = false; this.previewBlocked = false; this.audioMuted = false;
    this.muteTimers = {}; this.lastVisibleAt = performance.now(); this.lastReason = '';
  }

  get active() { return !!this.s && this.s.status === 'active'; }
  get elapsed() { return this.clock ? this.clock.elapsed() : 0; }
  /** true si ahora mismo se puede hacer una foto */
  get canShoot() { return this.active && !this.interrupting && !!this.capture?.stream; }

  /** Encadena operaciones sobre segmentos para que nunca se solapen. */
  serial(fn) {
    const p = this.segQ.then(fn);
    this.segQ = p.catch(e => log('segQ', e));
    return p;
  }

  // ---------- Inicio / reanudación ----------
  async startNew(opts) {
    this.reset();
    Object.assign(this.opts, opts);
    const s = newSessionRecord(Date.now());
    this.s = s; this.clock = new SessionClock(s.startEpoch);
    await saveSession(s);
    try {
      await this.startCapture('inicio');
    } catch (e) {
      // Sin cámara/micrófono no hay sesión: queda registrada como fallida y no se sube nada
      addIncident(s, this.clock, 'error_al_iniciar', e?.message || e);
      s.status = 'failed'; s.endEpoch = Date.now();
      await saveSession(s);
      this.teardown();
      throw e;
    }
    this.attachListeners();
    sync.kick();
    return s;
  }

  async resume(s, opts) {
    this.reset();
    Object.assign(this.opts, opts);
    await reconcileOrphan(s);
    this.s = s; this.clock = new SessionClock(s.startEpoch);
    try {
      await this.startCapture('reanudacion');
    } catch (e) {
      addIncident(s, this.clock, 'error_al_reanudar', e?.message || e);
      await saveSession(s);
      this.teardown();
      throw e;
    }
    s.status = 'active';
    addIncident(s, this.clock, 'sesion_reanudada');
    await saveSession(s);
    this.attachListeners();
    sync.kick();
    return s;
  }

  /** Para todo lo que esté en marcha y suelta la sesión (sin cambiar su estado). */
  teardown() {
    this.teardownListeners();
    this.meter?.stop(); this.meter = null;
    try { if (this.recorder?.state !== 'inactive') this.recorder?.rec?.stop(); } catch { /* */ }
    this.recorder = null;
    this.capture?.stop(); this.capture = null;
    this.releaseWakeLock();
    this.s = null;
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
    this.tick = setInterval(() => { this.ui.onTick?.(this.clock.elapsed()); this.watchdog(); }, 500);
  }

  teardownListeners() {
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('beforeunload', this._onUnload);
    window.removeEventListener('pagehide', this._onHide);
    clearInterval(this.hb); clearInterval(this.tick);
    Object.values(this.muteTimers).forEach(clearTimeout);
  }

  /** Arranca cámara + micrófono y abre un segmento de audio nuevo. */
  async startCapture(reason) {
    const s = this.s;
    const cap = new Capture(this.video, {
      photoMode: this.opts.photoMode, quality: this.opts.quality, deviceId: this.opts.deviceId,
      onTrackEvent: (k, ev) => { if (this.capture === cap) this.onTrackEvent(k, ev); },
    });
    await cap.start();
    if (this.s !== s || s.status !== 'active') { cap.stop(); throw new Error('La sesión ya había terminado'); } // se terminó mientras iOS abría la cámara
    this.capture = cap;
    this.audioMuted = !!cap.audioTrack.muted;
    this.previewBlocked = false;
    s.captureInfo = cap.info();
    addIncident(s, this.clock, 'captura_iniciada', `${reason}; fotos=${s.captureInfo.mode} ${s.captureInfo.width}x${s.captureInfo.height}; cámara=${s.captureInfo.camera || '?'}`);
    try {
      this.openSegment(reason);
    } catch (e) {
      cap.stop(); this.capture = null;
      throw new Error('No se pudo iniciar la grabación de audio: ' + (e?.message || e));
    }
    await saveSession(s);

    this.meter?.stop();
    this.meter = new LevelMeter(cap.audioTrack, lvl => this.ui.onLevel?.(lvl));
    this.acquireWakeLock();
    this.ui.onCamera?.({ zoom: cap.zoomLabel, torch: cap.hasTorch, torchOn: false, info: s.captureInfo });
  }

  /** Abre un segmento de audio sobre la pista de micrófono actual. */
  openSegment(reason) {
    const s = this.s;
    const prev = s.segments[s.segments.length - 1];
    const g = { seg: (prev?.seg || 0) + 1, startMs: this.clock.elapsed(), endMs: null, endReason: null, chunkCount: 0, nextSeq: 0, parts: [], mimeType: null, openReason: reason };
    const recorder = new SegmentRecorder(this.capture.audioTrack, {
      clock: this.clock, prefer: this.opts.audioFormat,
      onChunk: (blob, start, end) => this.onChunk(s, g, blob, start, end),
      onError: (msg) => { addIncident(s, this.clock, 'error_grabador', msg); this.interrupt('Error del grabador de audio'); },
    });
    g.mimeType = recorder.start(); // puede lanzar: en ese caso no se registra el segmento
    if (prev) {
      g.gapIndex = s.gaps.length;
      s.gaps.push({ fromMs: prev.endMs ?? prev.lastEndMs ?? prev.startMs, toMs: g.startMs, reason: prev.endReason || reason });
    }
    s.segments.push(g);
    s.manifestDirty = true;
    this.seg = g; this.recorder = recorder;
    log('segmento abierto', g.seg, reason, g.mimeType);
  }

  /** Guarda un trozo de audio en el móvil. s y g quedan fijados al crear el grabador (no dependen de la sesión actual). */
  onChunk(s, g, blob, startMs, endMs) {
    const seq = g.nextSeq++;
    this.chunkQ = this.chunkQ.then(async () => {
      await db.put('chunks', { sessionId: s.id, seg: g.seg, seq, blob, startMs, endMs, size: blob.size });
      if (seq === 0) {
        g.startMs = startMs; // hora real de arranque del grabador
        if (g.gapIndex != null && s.gaps[g.gapIndex]) s.gaps[g.gapIndex].toMs = startMs;
      }
      g.chunkCount = seq + 1;
      g.lastEndMs = endMs;
      if (g.endMs != null) { g.endMs = endMs; s.manifestDirty = true; } // trozo rezagado tras cerrar el segmento
      g.bytes = (g.bytes || 0) + blob.size;
      await saveSession(s);
    }).catch(e => {
      addIncident(s, this.clock, 'error_guardando_audio', e?.message || e);
      this.ui.onWarn?.('No se pudo guardar audio en el móvil (¿sin espacio?). Termina la sesión para no perder más.');
    });
    if ((seq + 1) % CONFIG.AUDIO_CHUNKS_PER_PART === 0) this.chunkQ.then(() => sync.kick());
  }

  async closeSegment(reason) {
    const g = this.seg;
    if (!g || g.endMs != null) return;
    const rec = this.recorder;
    this.recorder = null; this.seg = null;
    if (rec) await rec.stop();
    await this.chunkQ;
    g.endMs = g.lastEndMs ?? g.startMs;
    g.endReason = reason;
    this.s.manifestDirty = true;
    await saveSession(this.s);
  }

  /** Cierra el segmento y abre otro sobre la misma pista (sin reiniciar la cámara). */
  rotateSegment(reason) {
    return this.serial(async () => {
      if (!this.active || this.interrupting) return;
      await this.closeSegment(reason);
      const a = this.capture?.audioTrack;
      if (a && a.readyState === 'live' && !a.muted) {
        try { this.openSegment(reason); await saveSession(this.s); }
        catch (e) { addIncident(this.s, this.clock, 'error_grabador', e?.message || e); this.interrupt('No se pudo reabrir la grabación'); }
      }
    });
  }

  async acquireWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { this.wakeLock = await navigator.wakeLock.request('screen'); }
    catch (e) {
      if (!this.wakeWarned) { this.wakeWarned = true; if (this.s) addIncident(this.s, this.clock, 'pantalla_activa_no_disponible', e?.message || e); }
    }
  }
  releaseWakeLock() { try { this.wakeLock?.release(); } catch { /* */ } this.wakeLock = null; }

  /** Llamar dentro de cualquier toque: reactiva el medidor de nivel y la vista previa si iOS los pausó. */
  nudge() {
    this.meter?.nudge();
    if (this.capture?.stream && this.video.paused) this.capture.ensurePlaying();
  }

  // ---------- Fotos ----------
  takePhoto() {
    const s = this.s;
    if (!this.canShoot) return Promise.reject(new Error('La cámara no está activa'));
    const elapsedMs = this.clock.elapsed(); // instante del toque
    const wallEpoch = Date.now();
    const seq = ++s.photoSeq;
    const run = async () => {
      if (!this.capture?.stream) throw new Error('La cámara se interrumpió antes de capturar');
      const shot = await this.capture.takePhoto();
      const mime = shot.blob.type || 'image/jpeg';
      const id = `${s.id}_F${pad(seq, 4)}`;
      const thumb = await makeThumb(shot.blob);
      const photo = {
        id, sessionId: s.id, seq, elapsedMs, epoch: s.startEpoch + elapsedMs, wallEpoch,
        fileName: `foto_${pad(seq, 4)}_t${fmtStamp(elapsedMs)}.${extFor(mime)}`,
        mime, size: shot.blob.size, width: shot.width, height: shot.height, method: shot.method,
        status: 'pending', driveId: null,
      };
      await db.put('blobs', { id, blob: shot.blob });
      if (thumb) await db.put('thumbs', { id, blob: thumb });
      await db.put('photos', photo);
      s.manifestDirty = true;
      await saveSession(s);
      this.ui.onPhoto?.(photo, thumb);
      sync.kick();
      return photo;
    };
    // Fotos en serie para no saturar la cámara del iPhone
    const p = this.photoQ.then(run);
    this.photoQ = p.catch(e => { addIncident(s, this.clock, 'error_foto', `foto ${seq}: ${e?.message || e}`); saveSession(s); });
    return p;
  }

  async deletePhoto(photo) {
    const saved = await updatePhoto(photo.id, x => { x.status = 'deleted'; x.deletedAt = Date.now(); });
    if (this.s) {
      this.s.manifestDirty = true;
      addIncident(this.s, this.clock, 'foto_eliminada', photo.fileName);
      await saveSession(this.s);
    }
    sync.kick();
    return saved;
  }

  async cycleZoom() { return this.capture ? this.capture.cycleZoom() : null; }
  async toggleTorch() { return this.capture ? this.capture.toggleTorch() : false; }

  // ---------- Interrupciones ----------
  onTrackEvent(kind, ev) {
    if (!this.active) return;
    addIncident(this.s, this.clock, `pista_${kind}_${ev}`);
    if (this.interrupting) return;
    if (ev === 'ended') return this.interrupt(kind === 'audio' ? 'iOS ha cortado el micrófono' : 'iOS ha cortado la cámara');

    if (kind === 'audio' && ev === 'mute') {
      this.audioMuted = true;
      clearTimeout(this.muteTimers.audioRotate); clearTimeout(this.muteTimers.audio);
      // Un silencio de iOS detiene la entrada de audio: se cierra el segmento para no desajustar los tiempos
      this.muteTimers.audioRotate = setTimeout(() => {
        if (this.capture?.audioTrack?.muted) this.serial(() => this.closeSegment('microfono_silenciado_por_ios'));
      }, 600);
      this.muteTimers.audio = setTimeout(() => {
        if (this.capture?.audioTrack?.muted && document.visibilityState === 'visible') this.interrupt('El micrófono se ha silenciado');
      }, 4000);
    }
    if (kind === 'audio' && ev === 'unmute') {
      this.audioMuted = false;
      clearTimeout(this.muteTimers.audioRotate); clearTimeout(this.muteTimers.audio);
      this.serial(async () => {
        if (!this.active || this.interrupting || this.seg) return;
        try { this.openSegment('microfono_reactivado'); await saveSession(this.s); }
        catch (e) { this.interrupt('No se pudo reabrir la grabación'); }
      });
    }
    if (kind === 'video' && ev === 'mute') {
      clearTimeout(this.muteTimers.video);
      this.muteTimers.video = setTimeout(() => {
        if (this.capture?.videoTrack?.muted && document.visibilityState === 'visible') this.interrupt('La cámara se ha pausado');
      }, 3000);
    }
    if (kind === 'video' && ev === 'unmute') clearTimeout(this.muteTimers.video);
  }

  onVisibility() {
    if (!this.active) return;
    const vis = document.visibilityState;
    addIncident(this.s, this.clock, vis === 'visible' ? 'app_visible' : 'app_en_segundo_plano');
    if (vis !== 'visible') { this.s.heartbeatMs = this.clock.elapsed(); saveSession(this.s); return; }
    this.lastVisibleAt = performance.now();
    this.acquireWakeLock();

    // Si iOS congeló la página, el reloj monotónico se quedó atrás: re-anclar y empezar segmento nuevo
    const drift = this.clock.resyncIfDrifted();
    if (drift) {
      addIncident(this.s, this.clock, 'reloj_reanclado', `${Math.round(drift)} ms de desfase tras volver a la app`);
      if (!this.interrupting) this.rotateSegment('pagina_congelada_por_ios');
    }

    setTimeout(() => this.healthCheck(), 2000);
  }

  async healthCheck() {
    if (!this.active || document.visibilityState !== 'visible') return;
    if (this.interrupting) return this.tryAutoRecover();
    await this.segQ;
    if (!this.active || this.interrupting) return;
    const h = this.capture?.healthy() || {};
    if (!h.audio || !h.video) {
      return this.interrupt(`Al volver a la app: micrófono ${h.audio ? 'ok' : 'parado'}, cámara ${h.video ? 'ok' : 'parada'}`);
    }
    if (!this.seg || this.recorder?.state !== 'recording') {
      addIncident(this.s, this.clock, 'grabador_parado_al_volver');
      await this.rotateSegment('grabador_parado');
    }
    if (!(await this.capture.ensurePlaying())) {
      this.previewBlocked = true;
      this.ui.onInterrupted?.('La imagen de la cámara está en pausa. El audio sigue grabando', true);
    }
  }

  /** Detecta un grabador que ha dejado de entregar audio sin avisar. */
  watchdog() {
    if (!this.active || this.interrupting || this.recovering || this.audioMuted) return;
    if (document.visibilityState !== 'visible' || performance.now() - this.lastVisibleAt < 8000) return;
    if (this.recorder && this.recorder.silenceMs > CONFIG.AUDIO_WATCHDOG_MS) {
      addIncident(this.s, this.clock, 'grabador_sin_datos', `${Math.round(this.recorder.silenceMs / 1000)} s sin recibir audio`);
      this.interrupt('El grabador de audio se había parado');
    }
  }

  interrupt(reason) {
    if (this.interrupting || !this.active) return Promise.resolve();
    this.interrupting = true;
    this.lastReason = reason;
    addIncident(this.s, this.clock, 'interrupcion', reason);
    return this.serial(async () => {
      this.meter?.stop(); this.meter = null;
      await this.closeSegment('interrupcion');
      this.capture?.stop(); this.capture = null;
      this.releaseWakeLock();
      sync.kick();
      if (this.active && document.visibilityState === 'visible') await this.tryAutoRecover();
    });
  }

  /** Intenta reanudar solo. Si iOS exige un toque, muestra el botón REANUDAR GRABACIÓN. */
  async tryAutoRecover() {
    if (this.recovering || !this.interrupting || !this.active) return;
    this.recovering = true;
    try {
      await this.startCapture('reanudacion_automatica');
      this.interrupting = false;
      await sleep(600);
      if (this.capture && !this.capture.previewPlaying && !(await this.capture.ensurePlaying())) {
        this.previewBlocked = true;
        this.ui.onInterrupted?.('El audio ya vuelve a grabarse, pero la cámara necesita un toque para reactivarse', true);
      } else {
        this.ui.onRecovered?.('Grabación reanudada. El corte queda anotado.');
      }
    } catch (e) {
      if (this.active) {
        addIncident(this.s, this.clock, 'reanudacion_automatica_fallida', e?.message || e);
        this.ui.onInterrupted?.(this.lastReason || 'Grabación interrumpida', false);
      }
    } finally { this.recovering = false; }
  }

  /** Reanudación manual (desde el botón): cuenta como gesto del usuario. */
  async recoverManual() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      // Caso leve: todo sigue grabando y solo hay que volver a reproducir la vista previa
      if (!this.interrupting && this.capture?.healthy().audio && this.capture.healthy().video) {
        if (await this.capture.ensurePlaying()) { this.previewBlocked = false; this.ui.onRecovered?.('Cámara reactivada.'); return; }
      }
      this.interrupting = true;
      await this.serial(async () => {
        this.meter?.stop(); this.meter = null;
        await this.closeSegment('reinicio_manual');
        this.capture?.stop(); this.capture = null;
      });
      await this.startCapture('reanudacion_manual');
      this.interrupting = false;
      this.previewBlocked = false;
      this.ui.onRecovered?.('Grabación reanudada. El corte queda anotado.');
    } finally { this.recovering = false; }
  }

  // ---------- Fin ----------
  async finish() {
    const s = this.s;
    if (!s) return null;
    this.teardownListeners();
    s.status = 'finishing'; // desde aquí se ignoran los avisos de las pistas
    // Espera (con límite) a lo que estuviera en marcha: una foto guardándose o una reanudación a medias
    await Promise.race([Promise.all([this.photoQ, this.segQ]), sleep(6000)]);
    await this.closeSegment('fin');
    this.meter?.stop(); this.meter = null;
    this.capture?.stop(); this.capture = null;
    this.releaseWakeLock();
    await this.chunkQ;
    s.endEpoch = s.startEpoch + this.clock.elapsed();
    s.heartbeatMs = this.clock.elapsed();
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
  await reconcileOrphan(s);
  const lastMs = Math.max(s.heartbeatMs || 0, ...s.segments.map(g => g.endMs || 0), ...(await photosOf(s.id)).map(p => p.elapsedMs || 0));
  s.endEpoch = s.startEpoch + lastMs;
  s.status = 'finishing';
  addIncident(s, lastMs, 'sesion_terminada_sin_reanudar');
  s.manifestDirty = true;
  await saveSession(s);
  return s;
}
