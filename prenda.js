/**
 * Modo "prenda": el flujo sencillo.
 *   1) Se eligen fotos ya hechas con la cámara del iPhone (calidad nativa).
 *   2) Se graba uno o varios audios explicando la prenda.
 *   3) Se guarda: todo va a UNA carpeta de Drive  VINTED_WORKFLOW/AAAA-MM-DD/PRENDA_NN_HHhMM/
 *
 * Una prenda en preparación ("borrador") se guarda en el móvil en cuanto se añade algo,
 * así que cerrar Safari no pierde nada: al volver se continúa donde estaba.
 */
import { CONFIG } from './config.js';
import { db } from './db.js';
import { LevelMeter, makeThumb, imageSize } from './capture.js';
import { SegmentRecorder } from './audio.js';
import { saveSession, forgetSession, allSessions, addIncident, photosOf } from './store.js';
import { SessionClock, randomId, pad, extFor, isoLocal, log } from './util.js';

const dayOf = epoch => { const d = new Date(epoch); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** tipo: 'nueva' (prenda que nunca se ha subido) o 'resubida' (ya existe y se vuelve a publicar). */
export const TIPOS = ['nueva', 'resubida'];
export function newPrendaRecord(tipo = 'nueva') {
  const now = Date.now(), d = new Date(now);
  return {
    id: `P${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${randomId(4)}`,
    kind: 'prenda',
    tipo: TIPOS.includes(tipo) ? tipo : 'nueva',
    status: 'draft',
    startEpoch: now,
    endEpoch: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'desconocida',
    utcOffsetMin: -d.getTimezoneOffset(),
    dayFolder: null, folderName: null, number: null,   // se asignan al guardar
    photoSeq: 0, segSeq: 0,
    segments: [], gaps: [], incidents: [],
    drive: {},
    heartbeatMs: 0,
    manifestDirty: true,
    verified: false,
    appVersion: CONFIG.APP_VERSION,
    userAgent: navigator.userAgent,
  };
}

export const currentDraft = () => allSessions().find(s => s.kind === 'prenda' && s.status === 'draft') || null;

/** Fotos del borrador en el orden en que quedarán guardadas (por fecha de la foto si se conoce; si no, por orden de selección). */
export function orderPhotos(list) {
  const all = list.every(p => p.takenAt);
  return [...list].sort((a, b) => all ? (a.takenAt - b.takenAt) || (a.seq - b.seq) : a.seq - b.seq);
}

// ---------- Lectura mínima de la fecha EXIF (DateTimeOriginal) de un JPEG ----------
export async function exifDate(blob) {
  try {
    const buf = new DataView(await blob.slice(0, 256 * 1024).arrayBuffer());
    if (buf.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 4 < buf.byteLength) {
      const marker = buf.getUint16(off), size = buf.getUint16(off + 2);
      if (marker === 0xFFE1 && buf.getUint32(off + 4) === 0x45786966) return parseExif(buf, off + 10);
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
      off += 2 + size;
    }
  } catch { /* sin EXIF legible */ }
  return null;
}

function parseExif(v, tiff) {
  const le = v.getUint16(tiff) === 0x4949;
  const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
  const str = (o, n) => { let s = ''; for (let i = 0; i < n && o + i < v.byteLength; i++) { const c = v.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); } return s; };
  const readIfd = (o, wanted) => {
    const out = {}; const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12, tag = u16(e);
      if (!wanted.includes(tag)) continue;
      const type = u16(e + 2), count = u32(e + 4);
      if (type === 2) out[tag] = str(count > 4 ? tiff + u32(e + 8) : e + 8, count);
      else out[tag] = u32(e + 8);
    }
    return out;
  };
  const ifd0 = readIfd(tiff + u32(tiff + 4), [0x8769, 0x0132]);
  let text = ifd0[0x0132], sub = '';
  if (ifd0[0x8769]) {
    const ex = readIfd(tiff + ifd0[0x8769], [0x9003, 0x9291]);
    if (ex[0x9003]) text = ex[0x9003];
    if (ex[0x9291]) sub = ex[0x9291];
  }
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text || '');
  if (!m) return null;
  const ms = sub ? Math.round(Number('0.' + sub.replace(/\D/g, '')) * 1000) || 0 : 0;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Si el iPhone entrega HEIC, se convierte a JPEG (lo que acepta Vinted). Si no se puede, se deja como está. */
async function toJpegIfHeic(blob) {
  if (!/heic|heif/i.test(blob.type)) return blob;
  try {
    const url = URL.createObjectURL(blob);
    const img = new Image(); img.src = url; await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const out = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.95));
    c.width = c.height = 0;
    return out && out.size ? out : blob;
  } catch { return blob; }
}

export class PrendaController {
  constructor(ui) {
    this.ui = ui; // { onChange(), onLevel(lvl), onRecTick(ms), onRecStopped(reason), onWarn(msg) }
    this.s = null;
    this.rec = null;       // { stream, recorder, meter, seg, clock, timer }
    this.chunkQ = Promise.resolve();
    this._onVis = () => this.onVisibility();
  }

  get recording() { return !!this.rec; }
  get recordingMs() { return this.rec ? this.rec.clock.elapsed() : 0; }

  /** Abre el borrador existente o crea uno nuevo. */
  async open(tipo) {
    let s = currentDraft();
    if (s) await this.reconcile(s);
    else { s = newPrendaRecord(tipo); await saveSession(s); }
    if (!TIPOS.includes(s.tipo)) { s.tipo = TIPOS.includes(tipo) ? tipo : 'nueva'; await saveSession(s); }
    this.s = s;
    return s;
  }

  /** Cierra audios que quedaron a medias por un cierre inesperado. */
  async reconcile(s) {
    let changed = false;
    for (const g of s.segments) {
      if (g.endMs != null) continue;
      const last = await db.lastChunk(s.id, g.seg);
      if (last) { g.chunkCount = last.seq + 1; g.lastEndMs = last.endMs; }
      g.endMs = g.lastEndMs ?? g.startMs; g.endReason = 'cierre_inesperado';
      changed = true;
    }
    const before = s.segments.length;
    s.segments = s.segments.filter(g => (g.chunkCount || 0) > 0);
    const maxSeq = (await photosOf(s.id)).reduce((m, p) => Math.max(m, p.seq), 0);
    if (maxSeq > (s.photoSeq || 0)) { s.photoSeq = maxSeq; changed = true; }
    if (changed || before !== s.segments.length) await saveSession(s);
  }

  async photos() { return this.s ? orderPhotos((await photosOf(this.s.id)).filter(p => p.status !== 'deleted')) : []; }
  audios() { return this.s ? this.s.segments.filter(g => g.endMs != null && (g.chunkCount || 0) > 0) : []; }

  async setTipo(tipo) {
    if (!this.s || !TIPOS.includes(tipo)) return;
    this.s.tipo = tipo;
    await saveSession(this.s);
  }

  // ---------- Fotos ----------
  /** Añade las fotos elegidas en la galería del iPhone. Devuelve { added, skipped }. */
  async addFiles(files, onProgress) {
    const s = this.s; let added = 0, skipped = 0, i = 0;
    for (const f of files) {
      onProgress?.(++i, files.length);
      try {
        if (!/^image\//.test(f.type) && !/\.(jpe?g|png|heic|heif|webp)$/i.test(f.name || '')) { skipped++; continue; }
        // Copia propia de los datos: el archivo temporal del selector de iOS puede desaparecer
        let blob = new Blob([await f.arrayBuffer()], { type: f.type || 'image/jpeg' });
        if (!blob.size) { skipped++; continue; }
        blob = await toJpegIfHeic(blob);
        const dims = await imageSize(blob);
        const seq = ++s.photoSeq;
        const id = `${s.id}_F${pad(seq, 4)}`;
        const photo = {
          id, sessionId: s.id, seq, elapsedMs: 0, epoch: Date.now(),
          takenAt: await exifDate(blob), originalName: f.name || null,
          fileName: null, mime: blob.type || 'image/jpeg', size: blob.size, width: dims.width, height: dims.height,
          method: 'camara_iphone', status: 'pending', driveId: null,
        };
        const thumb = await makeThumb(blob);
        await db.put('blobs', { id, blob });
        if (thumb) await db.put('thumbs', { id, blob: thumb });
        await db.put('photos', photo);
        added++;
      } catch (e) {
        skipped++;
        addIncident(s, null, 'foto_no_importada', `${f.name || ''}: ${e?.message || e}`);
      }
    }
    await saveSession(s);
    this.ui.onChange?.();
    return { added, skipped };
  }

  async removePhoto(id) {
    await db.del('blobs', id); await db.del('thumbs', id); await db.del('photos', id);
    this.ui.onChange?.();
  }

  // ---------- Audio ----------
  /** Debe llamarse dentro de un toque (iOS pide el permiso del micrófono). */
  async startRecording(prefer) {
    if (this.rec) return;
    const s = this.s;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const track = stream.getAudioTracks()[0];
    const clock = new SessionClock(Date.now());
    const g = { seg: ++s.segSeq, startMs: 0, endMs: null, endReason: null, chunkCount: 0, nextSeq: 0, parts: [], noParts: true, mimeType: null, recordedAt: clock.startEpoch };
    const recorder = new SegmentRecorder(track, {
      clock, prefer,
      onChunk: (blob, start, end) => this.onChunk(s, g, blob, start, end),
      onError: (msg) => { addIncident(s, null, 'error_grabador', msg); this.stopRecording('error_grabador'); },
    });
    try { g.mimeType = recorder.start(); }
    catch (e) { stream.getTracks().forEach(t => t.stop()); throw new Error('No se pudo iniciar la grabación: ' + (e?.message || e)); }
    s.segments.push(g);
    await saveSession(s);
    const rec = { stream, recorder, seg: g, clock, track };
    rec.meter = new LevelMeter(track, lvl => this.ui.onLevel?.(lvl));
    rec.timer = setInterval(() => {
      this.ui.onRecTick?.(clock.elapsed());
      if (document.visibilityState === 'visible' && recorder.silenceMs > CONFIG.AUDIO_WATCHDOG_MS) this.stopRecording('grabador_sin_datos');
    }, 300);
    track.addEventListener('ended', () => this.stopRecording('microfono_cortado_por_ios'));
    track.addEventListener('mute', () => { rec.muteTimer = setTimeout(() => { if (track.muted) this.stopRecording('microfono_silenciado_por_ios'); }, 1500); });
    track.addEventListener('unmute', () => clearTimeout(rec.muteTimer));
    document.addEventListener('visibilitychange', this._onVis);
    try { if ('wakeLock' in navigator) rec.wake = await navigator.wakeLock.request('screen'); } catch { /* */ }
    this.rec = rec;
    log('grabando audio', g.seg, g.mimeType);
  }

  onVisibility() {
    // Si al volver a Safari el micrófono ya no está activo, se cierra el audio con lo grabado hasta entonces
    if (document.visibilityState !== 'visible' || !this.rec) return;
    setTimeout(() => {
      const r = this.rec;
      if (r && (r.track.readyState !== 'live' || r.track.muted || r.recorder.state !== 'recording')) this.stopRecording('interrumpido_al_salir_de_safari');
    }, 1200);
  }

  onChunk(s, g, blob, startMs, endMs) {
    const seq = g.nextSeq++;
    this.chunkQ = this.chunkQ.then(async () => {
      await db.put('chunks', { sessionId: s.id, seg: g.seg, seq, blob, startMs, endMs, size: blob.size });
      if (seq === 0) g.startMs = startMs;
      g.chunkCount = seq + 1; g.lastEndMs = endMs; g.bytes = (g.bytes || 0) + blob.size;
      if (g.endMs != null) g.endMs = endMs;
      await saveSession(s);
    }).catch(e => { addIncident(s, null, 'error_guardando_audio', e?.message || e); this.ui.onWarn?.('No se pudo guardar el audio en el móvil (¿sin espacio?).'); });
  }

  /** Detiene la grabación. reason distinto de 'usuario' = se cortó sola. */
  stopRecording(reason = 'usuario') {
    if (this.stopping) return this.stopping;       // ya se está deteniendo: esperar a que termine
    if (!this.rec) return Promise.resolve();
    this.stopping = this._stop(reason).finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async _stop(reason) {
    const r = this.rec;
    this.rec = null;
    clearInterval(r.timer); clearTimeout(r.muteTimer);
    document.removeEventListener('visibilitychange', this._onVis);
    r.meter?.stop();
    await r.recorder.stop();
    await this.chunkQ;
    r.stream.getTracks().forEach(t => { try { t.stop(); } catch { /* */ } });
    try { r.wake?.release(); } catch { /* */ }
    const g = r.seg, s = this.s;
    g.endMs = g.lastEndMs ?? g.startMs;
    g.endReason = reason;
    if (!(g.chunkCount > 0)) s.segments = s.segments.filter(x => x !== g); // no llegó a grabarse nada
    if (reason !== 'usuario') addIncident(s, null, 'audio_interrumpido', reason);
    await saveSession(s);
    this.ui.onRecStopped?.(reason, g.chunkCount > 0);
    this.ui.onChange?.();
  }

  async audioBlob(g) {
    const chunks = await db.chunksRange(this.s.id, g.seg, 0, Math.max(0, (g.chunkCount || 1) - 1));
    return new Blob(chunks.map(c => c.blob), { type: (g.mimeType || 'audio/mp4').split(';')[0] });
  }

  async removeAudio(g) {
    await db.delChunks(this.s.id, g.seg);
    this.s.segments = this.s.segments.filter(x => x !== g);
    await saveSession(this.s);
    this.ui.onChange?.();
  }

  // ---------- Guardar / descartar ----------
  /** Cierra la prenda y la deja lista para subir. Devuelve el registro. */
  async save() {
    const s = this.s;
    if (this.rec) await this.stopRecording('usuario');
    const now = Date.now(), d = new Date(now);
    s.dayFolder = dayOf(now);
    const key = `prendaCount:${s.dayFolder}`;
    s.number = ((await db.kvGet(key)) || 0) + 1;
    await db.kvSet(key, s.number);
    s.folderName = `PRENDA_${pad(s.number)}_${pad(d.getHours())}h${pad(d.getMinutes())}_${s.tipo === 'resubida' ? 'RESUBIDA' : 'NUEVA'}`;
    const photos = await this.photos();
    const w = Math.max(2, String(photos.length).length);
    let n = 0;
    for (const p of photos) {
      n++;
      await db.update('photos', p.id, x => { x.order = n; x.fileName = `foto_${pad(n, w)}.${extFor(x.mime)}`; });
    }
    this.audios().forEach((g, i) => { g.order = i + 1; g.fileName = `audio_${pad(i + 1)}.${extFor(g.mimeType)}`; });
    s.endEpoch = now;
    s.heartbeatMs = now - s.startEpoch;
    s.status = 'finishing';
    s.manifestDirty = true;
    await saveSession(s);
    this.s = null;
    return s;
  }

  async discard() {
    const s = this.s;
    if (!s) return;
    if (this.rec) await this.stopRecording('usuario');
    for (const p of await photosOf(s.id)) { await db.del('blobs', p.id); await db.del('thumbs', p.id); await db.del('photos', p.id); }
    for (let i = 1; i <= (s.segSeq || 0); i++) await db.delChunks(s.id, i);
    await forgetSession(s.id);
    this.s = null;
  }

  /** Deja de usar el borrador en pantalla (sigue guardado en el móvil). */
  async leave() {
    if (this.rec) await this.stopRecording('usuario');
    this.s = null;
  }
}

/** Datos de la prenda para el manifiesto (fecha legible de cada foto y audio). */
export const prendaLabel = s => s.number ? `Prenda ${pad(s.number)} · ${isoLocal(s.endEpoch || s.startEpoch).slice(0, 16).replace('T', ' ')}` : 'Prenda sin guardar';
