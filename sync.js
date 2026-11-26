/**
 * Sincronización con Google Drive.
 * - Sube fotos y fragmentos de audio a medida que existen (si hay conexión y acceso).
 * - Reintenta sola; nunca crea duplicados (búsqueda previa por vwId) y nunca sube dos cosas a la vez.
 * - Al terminar una sesión: sube los audios completos, comprueba en Drive que cada archivo existe con el
 *   tamaño correcto, vuelve a subir lo que falte y solo entonces libera el espacio local.
 * - NUNCA borra nada de Drive por su cuenta. Lo único que elimina algo es deleteSession(), que el usuario
 *   lanza a mano y que envía la carpeta de esa sesión a la papelera de Drive.
 */
import { CONFIG } from './config.js';
import { db } from './db.js';
import { drive, DriveError } from './drive.js';
import { auth } from './auth.js';
import { allSessions, saveSession, forgetSession, photosOf, updatePhoto, addIncident, validPhotos } from './store.js';
import { buildManifest, buildPrendaManifest, buildSummaryText, pendingAudioSegments } from './manifest.js';
import { extFor, fmtDuration, fmtStamp, measureAudioDurationMs, log } from './util.js';

const N = () => CONFIG.AUDIO_CHUNKS_PER_PART;
const p2 = n => String(n).padStart(2, '0');
const p4 = n => String(n).padStart(4, '0');
// Sesiones que la sincronización no toca: fallidas, ya comprobadas y prendas aún en preparación (borrador)
const isDone = s => s.status === 'failed' || s.status === 'draft' || (s.status === 'finished' && (s.verified || s.lossy));

class SyncEngine {
  constructor() {
    this.timer = null; this.queued = null; this.lockP = null;
    this.listeners = new Set();
    this.status = { pendingPhotos: 0, pendingAudio: 0, lastError: null, lastOk: null, paused: null, working: null };
    this.manifestThrottle = new Map();
    this.foldersChecked = new Set();
    this.backoff = new Map(); // sesión → { fails, until } para no insistir cada 5 s si algo falla de forma persistente
  }
  onStatus(fn) { this.listeners.add(fn); }
  emit() { this.listeners.forEach(fn => { try { fn(this.status); } catch (e) { console.error(e); } }); }
  working(txt) { this.status.working = txt; this.emit(); }

  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.kick(), CONFIG.SYNC_INTERVAL_MS);
    window.addEventListener('online', () => { this.resetBackoff(); this.kick(); });
    this.kick();
  }

  /** Olvida las esperas por fallos anteriores (tras entrar con Google, volver la conexión o guardar algo nuevo). */
  resetBackoff() { this.backoff.clear(); }

  /** Ejecuta fn en exclusiva (nunca dos subidas en paralelo → sin duplicados). */
  exclusive(fn) {
    const p = (this.lockP || Promise.resolve()).then(fn);
    this.lockP = p.catch(() => {});
    return p;
  }

  /** Programa una ronda de sincronización (como mucho una en cola). */
  kick() {
    if (this.queued) return this.queued;
    this.queued = this.exclusive(async () => { this.queued = null; await this.runOnce(); }).catch(e => log('sync', e));
    return this.queued;
  }

  blockedReason() {
    if (!navigator.onLine) return 'Sin conexión: se subirá al volver la cobertura';
    if (!auth.isValid()) return 'Subida a Drive en pausa (acceso caducado). Todo se sigue guardando en el móvil';
    return null;
  }

  async runOnce() {
    await this.computePending();
    this.status.paused = this.blockedReason();
    if (this.status.paused) return this.emit();
    let hadError = false;
    for (const s of allSessions()) {
      if (isDone(s)) continue;
      if (this.wrongAccount(s)) { this.status.lastError = `La sesión del ${new Date(s.startEpoch).toLocaleDateString()} pertenece a ${s.accountEmail}: entra con esa cuenta para subirla`; hadError = true; continue; }
      const bo = this.backoff.get(s.id);
      if (bo && Date.now() < bo.until) { hadError = true; continue; }
      try {
        if (s.status === 'finishing') {
          // Sesión o prenda ya cerrada: completar subida y comprobación en segundo plano
          const r = await this._finalize(s);
          if (!r.ok) throw new DriveError(r.checks.find(c => !c.ok)?.label || 'Guardado incompleto', r.needsLogin ? 401 : r.offline ? 0 : 500);
          this.listeners.forEach(fn => { try { fn(this.status, s); } catch { /* */ } });
        } else {
          await this.syncSession(s);
        }
        this.status.lastOk = Date.now();
        this.backoff.delete(s.id);
      } catch (e) {
        hadError = true;
        this.status.lastError = e.message;
        log('sync error', e);
        if (e instanceof DriveError && (e.status === 401 || e.status === 0)) break;
        const fails = (bo?.fails || 0) + 1;
        this.backoff.set(s.id, { fails, until: Date.now() + Math.min(120000, 5000 * 2 ** fails) });
      }
    }
    if (!hadError) this.status.lastError = null;
    this.status.paused = this.blockedReason();
    this.status.working = null;
    await this.computePending();
  }

  wrongAccount(s) {
    return !!(s.accountEmail && auth.email && s.accountEmail.toLowerCase() !== auth.email.toLowerCase());
  }

  /** Fragmentos de audio listos para subir que aún no están en Drive */
  pendingParts(g) {
    if (g.noParts) return []; // audios cortos de una prenda: solo se sube el archivo completo
    return this.completeParts(g).filter(p => !(g.parts || []).some(x => x.part === p && (x.driveId || x.empty)));
  }

  async computePending() {
    let pp = 0, pa = 0;
    for (const s of allSessions()) {
      if (isDone(s)) continue;
      pp += validPhotos(await photosOf(s.id)).filter(p => !p.driveId && !p.lost).length;
      for (const g of s.segments) pa += this.pendingParts(g).length;
      pa += pendingAudioSegments(s).length;
    }
    this.status.pendingPhotos = pp; this.status.pendingAudio = pa;
    this.emit();
  }

  /** Crea (o localiza) las carpetas de la sesión. Si alguien las borró o envió a la papelera, las vuelve a crear. */
  async ensureFolders(s, forceCheck = false) {
    const d = s.drive;
    const email = (auth.email || '').toLowerCase();
    if (!s.accountEmail && email) s.accountEmail = email;
    const rootKey = `rootFolderId:${email}`;

    if (forceCheck || !this.foldersChecked.has(s.id)) {
      if (d.rootId && !(await drive.folderAlive(d.rootId))) { d.rootId = null; await db.kvSet(rootKey, null); }
      if (d.folderId && !(await drive.folderAlive(d.folderId))) {
        addIncident(s, null, 'carpeta_de_drive_no_encontrada', 'se vuelve a crear y se suben de nuevo los archivos');
        s.drive = { rootId: d.rootId };
      }
      this.foldersChecked.add(s.id);
    }
    const dd = s.drive;
    if (!dd.rootId) {
      dd.rootId = await db.kvGet(rootKey);
      if (dd.rootId && !(await drive.folderAlive(dd.rootId))) dd.rootId = null;
      if (!dd.rootId) {
        dd.rootId = await drive.ensureFolder(CONFIG.ROOT_FOLDER_NAME, null, 'VW_ROOT');
        await db.kvSet(rootKey, dd.rootId);
      }
    }
    if (s.kind === 'prenda') {
      // VINTED_WORKFLOW/AAAA-MM-DD/PRENDA_NN_HHhMM/  (fotos y audios juntos en la misma carpeta)
      if (!dd.dayId) dd.dayId = await drive.ensureFolder(s.dayFolder, dd.rootId, `VW_DAY_${s.dayFolder}`);
      if (!dd.folderId) dd.folderId = await drive.ensureFolder(s.folderName, dd.dayId, `${s.id}_DIR`);
      dd.fotosId = dd.audioId = dd.folderId;
      await saveSession(s);
      return;
    }
    if (!dd.folderId) dd.folderId = await drive.ensureFolder(s.folderName, dd.rootId, `${s.id}_DIR`);
    if (!dd.fotosId) dd.fotosId = await drive.ensureFolder('FOTOS', dd.folderId, `${s.id}_FOTOS`);
    if (!dd.audioId) dd.audioId = await drive.ensureFolder('AUDIO', dd.folderId, `${s.id}_AUDIO`);
    if (!dd.partsId) dd.partsId = await drive.ensureFolder('fragmentos', dd.audioId, `${s.id}_PARTS`);
    await saveSession(s);
  }

  /** Índices de fragmento completos (listos para subir) de un segmento */
  completeParts(g) {
    const n = N(), out = [];
    const total = g.chunkCount || 0;
    const ended = g.endMs != null;
    for (let p = 0; p * n < total; p++) {
      if ((p + 1) * n <= total || ended) out.push(p);
    }
    return out;
  }

  async syncSession(s, { forceCheck = false } = {}) {
    await this.ensureFolders(s, forceCheck);

    // 1) Fotos
    for (const p of await photosOf(s.id)) {
      if (p.status === 'deleted') {
        if (p.driveId && !p.movedToDeleted) {
          if (!s.drive.deletedId) { s.drive.deletedId = await drive.ensureFolder('_ELIMINADAS', s.drive.fotosId, `${s.id}_DEL`); await saveSession(s); }
          try { await drive.move(p.driveId, s.drive.deletedId, s.drive.fotosId); }
          catch (e) { if (e.status !== 404) throw e; }
          await updatePhoto(p.id, x => { x.movedToDeleted = true; });
          s.manifestDirty = true;
        }
        continue;
      }
      if (p.driveId || p.lost) continue;
      const rec = await db.get('blobs', p.id);
      if (!rec?.blob) {
        await updatePhoto(p.id, x => { x.lost = true; });
        addIncident(s, null, 'foto_sin_copia_local', p.fileName);
        continue;
      }
      this.working(`Subiendo foto ${p.seq}…`);
      const r = await drive.upload({ blob: rec.blob, name: p.fileName, parentId: s.drive.fotosId, mimeType: p.mime, vwId: p.id,
        props: { sessionId: s.id, elapsedMs: String(p.elapsedMs) } });
      // Atómico: si mientras tanto el usuario borró la foto, se conserva el borrado y se moverá en la siguiente ronda
      const saved = await updatePhoto(p.id, x => { x.driveId = r.id; x.driveSize = r.size; });
      s.manifestDirty = true;
      if (saved?.status === 'deleted') this.kickSoon = true;
    }

    // 2) Fragmentos de audio
    for (const g of s.segments) {
      g.parts = g.parts || [];
      for (const part of this.pendingParts(g)) {
        const from = part * N(), to = Math.min((part + 1) * N(), g.chunkCount) - 1;
        const chunks = await db.chunksRange(s.id, g.seg, from, to);
        g.parts = g.parts.filter(x => x.part !== part);
        if (!chunks.length) {
          addIncident(s, null, 'fragmento_de_audio_sin_copia_local', `segmento ${g.seg}, fragmento ${part + 1}`);
          g.parts.push({ part, fromSeq: from, toSeq: to, empty: true });
        } else {
          if (chunks.length !== to - from + 1) addIncident(s, null, 'fragmento_de_audio_incompleto', `segmento ${g.seg}, fragmento ${part + 1}: ${chunks.length}/${to - from + 1} trozos`);
          const blob = new Blob(chunks.map(c => c.blob), { type: g.mimeType });
          const fileName = `seg${p2(g.seg)}_parte${p4(part + 1)}_t${fmtStamp(chunks[0].startMs)}.${extFor(g.mimeType)}`;
          this.working(`Subiendo audio (minuto ${Math.floor(chunks[0].startMs / 60000)})…`);
          const r = await drive.upload({ blob, name: fileName, parentId: s.drive.partsId, mimeType: g.mimeType.split(';')[0],
            vwId: `${s.id}_S${g.seg}_P${part}` });
          g.parts.push({ part, fromSeq: from, toSeq: to, startMs: chunks[0].startMs, endMs: chunks[chunks.length - 1].endMs,
            size: blob.size, fileName, driveId: r.id, driveSize: r.size });
        }
        g.parts.sort((a, b) => a.part - b.part);
        s.manifestDirty = true;
        await saveSession(s);
      }
      // 3) Audio completo del segmento (cuando el segmento ha terminado)
      if (g.endMs != null && !g.full?.driveId && !g.full?.empty) {
        const chunks = g.chunkCount > 0 ? await db.chunksRange(s.id, g.seg, 0, g.chunkCount - 1) : [];
        if (!chunks.length) {
          g.full = { empty: true };
        } else {
          if (chunks.length !== g.chunkCount) addIncident(s, null, 'audio_completo_con_trozos_perdidos', `segmento ${g.seg}: ${chunks.length}/${g.chunkCount}`);
          const blob = new Blob(chunks.map(c => c.blob), { type: g.mimeType });
          if (g.measuredMs == null) {
            const m = await measureAudioDurationMs(blob);
            if (m != null) g.measuredMs = m;
          }
          const fileName = g.fileName || `audio_seg${p2(g.seg)}_completo_t${fmtStamp(g.startMs)}.${extFor(g.mimeType)}`;
          this.working(`Subiendo audio completo del segmento ${g.seg}…`);
          const r = await drive.upload({ blob, name: fileName, parentId: s.drive.audioId, mimeType: g.mimeType.split(';')[0], vwId: `${s.id}_S${g.seg}_FULL` });
          g.full = { fileName, driveId: r.id, size: blob.size, driveSize: r.size, chunks: chunks.length };
        }
        s.manifestDirty = true;
        await saveSession(s);
      }
    }

    // 4) Manifiesto (durante la sesión, como mucho una vez por minuto)
    const last = this.manifestThrottle.get(s.id) || 0;
    if (s.manifestDirty && (s.status !== 'active' || Date.now() - last > 60000)) {
      await this.writeManifest(s);
      this.manifestThrottle.set(s.id, Date.now());
    }
    if (this.kickSoon) { this.kickSoon = false; setTimeout(() => this.kick(), 200); }
  }

  async writeManifest(s) {
    const photos = await photosOf(s.id);
    s.manifestDirty = false;
    const data = s.kind === 'prenda' ? buildPrendaManifest(s, photos) : buildManifest(s, photos);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    try {
      if (s.drive.manifestId) {
        try { await drive.updateContent(s.drive.manifestId, blob, 'application/json'); }
        catch (e) { if (e.status !== 404) throw e; s.drive.manifestId = null; }
      }
      if (!s.drive.manifestId) s.drive.manifestId = (await drive.upload({ blob, name: 'manifest.json', parentId: s.drive.folderId, mimeType: 'application/json', vwId: `${s.id}_MANIFEST` })).id;
      await saveSession(s);
    } catch (e) { s.manifestDirty = true; throw e; }
  }

  /**
   * Cierre de una sesión terminada: sube todo, comprueba en Drive y genera el resumen.
   * Devuelve { ok, needsLogin, offline, checks:[{ok, warn, label, detail}] }.
   */
  finalize(s) { return this.exclusive(() => this._finalize(s)).finally(() => { this.status.working = null; this.computePending(); }); }

  async _finalize(s) {
    const report = { ok: false, checks: [] };
    const add = (ok, label, detail = '', warn = false) => report.checks.push({ ok, label, detail, warn });
    if (!navigator.onLine) { report.offline = true; add(false, 'Sin conexión a Internet', 'Todo sigue guardado en el móvil. Se reintentará solo al volver la cobertura.'); return report; }
    if (!auth.isValid()) { report.needsLogin = true; add(false, 'Hay que volver a conectar con Google', 'El acceso dura 1 hora por seguridad. No se ha perdido nada: pulsa el botón para subir lo que falta.'); return report; }
    if (this.wrongAccount(s)) { report.needsLogin = true; add(false, 'Cuenta de Google distinta', `Esta sesión empezó a guardarse en ${s.accountEmail}. Entra con esa cuenta.`); return report; }

    let photos, valid, missing = [], audioBad = [], lost = [];
    // Hasta 2 pasadas: si la comprobación detecta que falta algo y hay copia local, se vuelve a subir
    try {
      for (let pass = 1; pass <= 2; pass++) {
        await this.syncSession(s, { forceCheck: true });
        this.working('Comprobando archivos en Drive…');
        photos = await photosOf(s.id);
        valid = validPhotos(photos);
        missing = []; audioBad = []; lost = valid.filter(p => p.lost);
        let healed = 0;

        for (const p of valid) {
          if (p.lost) continue;
          const local = (await db.get('blobs', p.id))?.blob;
          if (await verifyFile(p.driveId, local?.size ?? p.size)) continue;
          missing.push(p.fileName);
          if (local) { await updatePhoto(p.id, x => { x.driveId = null; }); healed++; }
          else { await updatePhoto(p.id, x => { x.lost = true; }); lost.push(p); }
        }
        for (const g of s.segments) {
          if (g.full?.empty) continue;
          if (!(await verifyFile(g.full?.driveId, g.full?.size))) { audioBad.push(`segmento ${g.seg} (completo)`); if (g.full) g.full.driveId = null; healed++; }
          for (const pt of g.parts || []) {
            if (pt.empty) continue;
            if (!(await verifyFile(pt.driveId, pt.size))) { audioBad.push(`segmento ${g.seg}, fragmento ${pt.part + 1}`); pt.driveId = null; healed++; }
          }
        }
        await saveSession(s);
        if (!healed) break;
        if (pass === 1) addIncident(s, null, 'archivos_resubidos_tras_comprobacion', `${missing.length} foto(s), ${audioBad.length} audio(s)`);
      }
    } catch (e) {
      if (e.status === 401) report.needsLogin = true;
      if (e.status === 0) report.offline = true;
      add(false, 'Subida a Drive interrumpida', (e.message || e) + '. No se ha perdido nada; se puede reintentar.');
      await saveSession(s);
      return report;
    }

    const okPhotos = valid.length - missing.length - lost.filter(p => !missing.includes(p.fileName)).length;
    add(missing.length === 0 && lost.length === 0, `Fotos válidas en Drive: ${okPhotos}/${valid.length}`,
      [missing.length ? 'Faltan: ' + missing.join(', ') : '', lost.length ? `Sin copia local (no recuperables): ${lost.map(p => p.fileName).join(', ')}` : ''].filter(Boolean).join(' · '));

    const audioDetail = [], durWarn = [];
    for (const g of s.segments) {
      if (g.full?.empty) { audioDetail.push(`Segmento ${g.seg}: sin datos (cortado al instante)`); continue; }
      const wall = g.endMs - g.startMs;
      let line = s.kind === 'prenda' ? `${g.fileName || 'audio'}: ${fmtDuration(wall)}` : `Segmento ${g.seg}: ${fmtDuration(wall)}, ${(g.parts || []).filter(x => x.driveId).length} fragmento(s)`;
      if (g.measuredMs != null) {
        const diff = g.measuredMs - wall;
        line += `, duración real ${fmtDuration(g.measuredMs)}`;
        if (Math.abs(diff) > Math.max(4000, wall * 0.01)) durWarn.push(`Segmento ${g.seg}: el archivo dura ${fmtDuration(g.measuredMs)} pero se grabó durante ${fmtDuration(wall)} (${diff > 0 ? '+' : '−'}${Math.round(Math.abs(diff) / 1000)} s)`);
      }
      audioDetail.push(line);
    }
    const audioOk = audioBad.length === 0;
    add(audioOk, `Audio en Drive: ${s.segments.filter(g => !g.full?.empty).length} archivo(s) completo(s)`, audioOk ? audioDetail.join(' · ') : 'Faltan: ' + audioBad.join(', '));
    if (durWarn.length) add(true, 'Aviso: la duración del audio no coincide con el tiempo grabado', durWarn.join(' · ') + '. Los archivos están guardados, pero avísame: puede ser un fallo de grabación de iOS.', true);
    else if (s.segments.some(g => g.measuredMs != null)) add(true, 'Duración real del audio comprobada', '');
    if (s.gaps.length) add(true, `Cortes de audio durante la sesión: ${s.gaps.length}`, s.gaps.map(g => `${fmtDuration(g.fromMs)} → ${fmtDuration(g.toMs)} (${g.reason})`).join(' · '), s.gaps.some(g => g.toMs - g.fromMs > 3000));

    const allUploaded = missing.length === 0 && audioOk;
    if (allUploaded) { s.status = 'finished'; s.verified = lost.length === 0; s.lossy = lost.length > 0; }
    s.manifestDirty = true;
    try {
      await this.writeManifest(s);
      const prenda = s.kind === 'prenda';
      if (!prenda) {
        const txt = new Blob([buildSummaryText(s, photos)], { type: 'text/plain' });
        if (s.drive.summaryId) {
          try { await drive.updateContent(s.drive.summaryId, txt, 'text/plain'); }
          catch (e) { if (e.status !== 404) throw e; s.drive.summaryId = null; }
        }
        if (!s.drive.summaryId) s.drive.summaryId = (await drive.upload({ blob: txt, name: 'resumen_sesion.txt', parentId: s.drive.folderId, mimeType: 'text/plain', vwId: `${s.id}_SUMMARY` })).id;
      }
      const mOk = (await verifyFile(s.drive.manifestId)) && (prenda || await verifyFile(s.drive.summaryId));
      add(mOk, prenda ? 'Ficha de la prenda (manifest.json)' : 'Manifiesto (manifest.json) y resumen_sesion.txt', '');
      if (!mOk) { s.status = 'finishing'; s.verified = false; s.lossy = false; s.drive.manifestId = null; s.drive.summaryId = null; }
    } catch (e) {
      s.status = 'finishing'; s.verified = false; s.lossy = false;
      add(false, 'Manifiesto', e.message);
    }
    await saveSession(s);

    report.ok = s.status === 'finished';
    report.lossy = !!s.lossy;
    if (report.ok) await freeLocalSpace(s, photos);
    return report;
  }

  /**
   * Eliminación MANUAL de una sesión completa (la pide el usuario, con confirmación en la interfaz).
   * Envía a la papelera de Drive únicamente la carpeta de esa sesión y borra sus datos del móvil.
   */
  deleteSession(s) {
    return this.exclusive(async () => {
      if (s.drive?.folderId) {
        if (!navigator.onLine) throw new Error('Sin conexión: no se puede eliminar la carpeta de Drive ahora.');
        if (!auth.isValid()) throw new DriveError('Hay que entrar con Google para eliminar la carpeta de Drive.', 401);
        if (this.wrongAccount(s)) throw new Error(`Esta sesión está en la cuenta ${s.accountEmail}. Entra con ella para eliminarla.`);
        try { await drive.trashSessionFolder(s.drive.folderId, s.id); }
        catch (e) { if (e.status !== 404) throw e; } // ya no existe en Drive
      }
      for (const p of await photosOf(s.id)) {
        await db.del('blobs', p.id); await db.del('thumbs', p.id); await db.del('photos', p.id);
      }
      for (const g of s.segments) await db.delChunks(s.id, g.seg);
      this.backoff.delete(s.id);
      await forgetSession(s.id);
      this.foldersChecked.delete(s.id);
      await this.computePending();
    });
  }
}

async function verifyFile(id, expectedSize) {
  if (!id) return false;
  try {
    const f = await drive.getFile(id, 'id,size,trashed');
    if (f.trashed) return false;
    if (expectedSize != null && Number(f.size) !== Number(expectedSize)) return false;
    return true;
  } catch (e) {
    if (e.status === 404) return false;
    throw e; // sin conexión / acceso caducado: no es que falte el archivo
  }
}

/** Solo tras la comprobación en Drive: libera fotos grandes y trozos de audio del móvil (se conservan miniaturas). */
async function freeLocalSpace(s, photos) {
  for (const p of photos) { if (p.driveId || p.status === 'deleted' || p.lost) await db.del('blobs', p.id); }
  for (const g of s.segments) await db.delChunks(s.id, g.seg);
  s.localFreed = true;
  await saveSession(s);
}

export const sync = new SyncEngine();
