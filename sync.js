/**
 * Sincronización con Google Drive.
 * - Sube fotos y fragmentos de audio a medida que existen (si hay conexión y acceso).
 * - Reintenta sola; nunca crea duplicados (búsqueda previa por vwId).
 * - Al terminar una sesión: sube los audios completos, comprueba en Drive que cada archivo existe con el
 *   tamaño correcto y solo entonces libera el espacio local. NUNCA borra nada de Drive.
 */
import { CONFIG } from './config.js';
import { db } from './db.js';
import { drive, DriveError } from './drive.js';
import { auth } from './auth.js';
import { allSessions, saveSession, photosOf, addIncident } from './store.js';
import { buildManifest, buildSummaryText } from './manifest.js';
import { extFor, fmtDuration, log } from './util.js';

const N = () => CONFIG.AUDIO_CHUNKS_PER_PART;
const tStr = ms => fmtDuration(ms).replace(/:/g, '-') + '.' + String(ms % 1000).padStart(3, '0');

class SyncEngine {
  constructor() {
    this.timer = null; this.queued = null; this.lockP = null;
    this.listeners = new Set();
    this.status = { pendingPhotos: 0, pendingAudio: 0, lastError: null, lastOk: null, paused: null };
    this.manifestThrottle = new Map();
  }
  onStatus(fn) { this.listeners.add(fn); }
  emit() { this.listeners.forEach(fn => { try { fn(this.status); } catch (e) { console.error(e); } }); }

  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.kick(), CONFIG.SYNC_INTERVAL_MS);
    window.addEventListener('online', () => this.kick());
    this.kick();
  }

  /** Ejecuta fn en exclusiva (nunca dos subidas en paralelo → sin duplicados). */
  exclusive(fn) {
    const p = (this.lockP || Promise.resolve()).then(fn);
    this.lockP = p.catch(() => {});
    return p;
  }

  /** Programa una ronda de sincronización (como mucho una en cola). */
  kick() {
    if (this.queued) return this.queued;
    this.queued = this.exclusive(async () => { this.queued = null; await this.runOnce(); });
    return this.queued;
  }

  async runOnce() {
    await this.computePending();
    if (!navigator.onLine) { this.status.paused = 'Sin conexión: se subirá al volver la cobertura'; return this.emit(); }
    if (!auth.isValid()) { this.status.paused = 'Acceso a Drive caducado: toca para reconectar'; return this.emit(); }
    this.status.paused = null;
    for (const s of allSessions()) {
      if ((s.status === 'finished' && s.verified) || s.status === 'failed') continue;
      try {
        await this.syncSession(s);
        this.status.lastError = null; this.status.lastOk = Date.now();
      } catch (e) {
        this.status.lastError = e.message;
        log('sync error', e);
        if (e instanceof DriveError && e.status === 401) break;
      }
    }
    await this.computePending();
    this.emit();
  }

  async computePending() {
    let pp = 0, pa = 0;
    for (const s of allSessions()) {
      if ((s.status === 'finished' && s.verified) || s.status === 'failed') continue;
      pp += (await photosOf(s.id)).filter(p => p.status !== 'deleted' && !p.driveId).length;
      for (const g of s.segments) {
        pa += this.completeParts(g).filter(p => !g.parts.some(x => x.part === p)).length;
        if (g.endMs != null && !g.full?.driveId) pa += 1;
      }
    }
    this.status.pendingPhotos = pp; this.status.pendingAudio = pa;
    this.emit();
  }

  async ensureFolders(s) {
    const d = s.drive;
    if (!d.rootId) {
      d.rootId = await db.kvGet('rootFolderId');
      if (!d.rootId) {
        d.rootId = await drive.ensureFolder(CONFIG.ROOT_FOLDER_NAME, null, 'VW_ROOT');
        await db.kvSet('rootFolderId', d.rootId);
      }
    }
    if (!d.folderId) d.folderId = await drive.ensureFolder(s.folderName, d.rootId, `${s.id}_DIR`);
    if (!d.fotosId) d.fotosId = await drive.ensureFolder('FOTOS', d.folderId, `${s.id}_FOTOS`);
    if (!d.audioId) d.audioId = await drive.ensureFolder('AUDIO', d.folderId, `${s.id}_AUDIO`);
    if (!d.partsId) d.partsId = await drive.ensureFolder('fragmentos', d.audioId, `${s.id}_PARTS`);
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

  async syncSession(s) {
    await this.ensureFolders(s);
    const photos = await photosOf(s.id);

    // 1) Fotos
    for (const p of photos) {
      if (p.status === 'deleted') {
        if (p.driveId && !p.movedToDeleted) {
          if (!s.drive.deletedId) { s.drive.deletedId = await drive.ensureFolder('_ELIMINADAS', s.drive.fotosId, `${s.id}_DEL`); await saveSession(s); }
          await drive.move(p.driveId, s.drive.deletedId, s.drive.fotosId);
          p.movedToDeleted = true; await db.put('photos', p);
        }
        continue;
      }
      if (p.driveId) continue;
      const rec = await db.get('blobs', p.id);
      if (!rec?.blob) { addIncident(s, null, 'foto_sin_datos_locales', p.fileName); continue; }
      const r = await drive.upload({ blob: rec.blob, name: p.fileName, parentId: s.drive.fotosId, mimeType: p.mime, vwId: p.id,
        props: { sessionId: s.id, elapsedMs: String(p.elapsedMs) } });
      p.driveId = r.id; p.driveSize = r.size;
      await db.put('photos', p);
      s.manifestDirty = true;
    }

    // 2) Fragmentos de audio
    for (const g of s.segments) {
      g.parts = g.parts || [];
      for (const part of this.completeParts(g)) {
        if (g.parts.some(x => x.part === part && x.driveId)) continue;
        const from = part * N(), to = Math.min((part + 1) * N(), g.chunkCount) - 1;
        const chunks = await db.chunksRange(s.id, g.seg, from, to);
        if (chunks.length !== to - from + 1) { addIncident(s, null, 'trozos_de_audio_incompletos', `seg ${g.seg} parte ${part + 1}`); continue; }
        const blob = new Blob(chunks.map(c => c.blob), { type: g.mimeType });
        const fileName = `seg${String(g.seg).padStart(2, '0')}_parte${String(part + 1).padStart(4, '0')}_t${tStr(chunks[0].startMs)}.${extFor(g.mimeType)}`;
        const r = await drive.upload({ blob, name: fileName, parentId: s.drive.partsId, mimeType: g.mimeType.split(';')[0],
          vwId: `${s.id}_S${g.seg}_P${part}` });
        g.parts = g.parts.filter(x => x.part !== part);
        g.parts.push({ part: part + 0, fromSeq: from, toSeq: to, startMs: chunks[0].startMs, endMs: chunks[chunks.length - 1].endMs,
          size: blob.size, fileName, driveId: r.id, driveSize: r.size });
        g.parts.sort((a, b) => a.part - b.part);
        s.manifestDirty = true;
        await saveSession(s);
      }
      // 3) Audio completo del segmento (cuando el segmento ha terminado)
      if (g.endMs != null && !g.full?.driveId && g.chunkCount > 0) {
        const chunks = await db.chunksRange(s.id, g.seg, 0, g.chunkCount - 1);
        if (chunks.length !== g.chunkCount) { addIncident(s, null, 'audio_completo_incompleto', `seg ${g.seg}: ${chunks.length}/${g.chunkCount}`); }
        const blob = new Blob(chunks.map(c => c.blob), { type: g.mimeType });
        const fileName = `audio_seg${String(g.seg).padStart(2, '0')}_completo_t${tStr(g.startMs)}.${extFor(g.mimeType)}`;
        const r = await drive.upload({ blob, name: fileName, parentId: s.drive.audioId, mimeType: g.mimeType.split(';')[0], vwId: `${s.id}_S${g.seg}_FULL` });
        g.full = { fileName, driveId: r.id, size: blob.size, driveSize: r.size, chunks: chunks.length };
        s.manifestDirty = true;
        await saveSession(s);
      } else if (g.endMs != null && g.chunkCount === 0 && !g.full) {
        g.full = { fileName: null, driveId: null, size: 0, empty: true };
        await saveSession(s);
      }
    }

    // 4) Manifiesto (durante la sesión, como mucho una vez por minuto)
    const last = this.manifestThrottle.get(s.id) || 0;
    if (s.manifestDirty && (s.status !== 'active' || Date.now() - last > 60000)) {
      await this.writeManifest(s);
      this.manifestThrottle.set(s.id, Date.now());
    }
  }

  async writeManifest(s) {
    const photos = await photosOf(s.id);
    s.manifestDirty = false;
    const blob = new Blob([JSON.stringify(buildManifest(s, photos), null, 2)], { type: 'application/json' });
    try {
      if (s.drive.manifestId) await drive.updateContent(s.drive.manifestId, blob, 'application/json');
      else s.drive.manifestId = (await drive.upload({ blob, name: 'manifest.json', parentId: s.drive.folderId, mimeType: 'application/json', vwId: `${s.id}_MANIFEST` })).id;
      await saveSession(s);
    } catch (e) { s.manifestDirty = true; throw e; }
  }

  /**
   * Cierre de una sesión terminada: sube todo, comprueba en Drive y genera el resumen.
   * Devuelve un informe con cada comprobación.
   */
  finalize(s) { return this.exclusive(() => this._finalize(s)); }

  async _finalize(s) {
    const report = { ok: false, checks: [] };
    const add = (ok, label, detail = '') => report.checks.push({ ok, label, detail });
    if (!navigator.onLine) { add(false, 'Conexión a Internet', 'Sin conexión. Todo sigue guardado en el móvil; pulsa Reintentar cuando tengas cobertura.'); return report; }
    if (!auth.isValid()) { add(false, 'Acceso a Google Drive', 'Ha caducado. Pulsa Reintentar para volver a entrar (no se pierde nada).'); return report; }

    try { await this.syncSession(s); }
    catch (e) { add(false, 'Subida a Drive', e.message); return report; }

    const photos = await photosOf(s.id);
    const valid = photos.filter(p => p.status !== 'deleted');

    // Comprobación real contra Drive
    let photosOk = 0; const missing = [];
    for (const p of valid) {
      const blob = (await db.get('blobs', p.id))?.blob;
      const ok = await verifyFile(p.driveId, blob?.size ?? p.size);
      if (ok) photosOk++; else missing.push(p.fileName);
    }
    add(missing.length === 0, `Fotos válidas en Drive: ${photosOk}/${valid.length}`, missing.length ? 'Faltan: ' + missing.join(', ') : '');

    let audioOk = true; const audioDetail = [];
    for (const g of s.segments) {
      if (g.full?.empty) { audioDetail.push(`Segmento ${g.seg}: sin datos (interrumpido al instante)`); continue; }
      const fullOk = await verifyFile(g.full?.driveId, g.full?.size);
      let partsOk = 0;
      for (const pt of g.parts || []) if (await verifyFile(pt.driveId, pt.size)) partsOk++;
      const expectedParts = this.completeParts(g).length;
      if (!fullOk || partsOk !== expectedParts) audioOk = false;
      audioDetail.push(`Segmento ${g.seg} (${fmtDuration(g.endMs - g.startMs)}): completo ${fullOk ? '✓' : '✗'}, fragmentos ${partsOk}/${expectedParts}`);
    }
    add(audioOk, `Audio en Drive: ${s.segments.length} segmento(s)`, audioDetail.join(' · '));
    if (s.gaps.length) add(true, `Huecos sin audio: ${s.gaps.length}`, s.gaps.map(g => `${fmtDuration(g.fromMs)}→${fmtDuration(g.toMs)} (${g.reason})`).join(' · '));

    const allOk = missing.length === 0 && audioOk;
    if (allOk) { s.status = 'finished'; s.verified = true; }
    s.manifestDirty = true;
    try {
      await this.writeManifest(s);
      const txt = new Blob([buildSummaryText(s, photos)], { type: 'text/plain' });
      if (s.drive.summaryId) await drive.updateContent(s.drive.summaryId, txt, 'text/plain');
      else s.drive.summaryId = (await drive.upload({ blob: txt, name: 'resumen_sesion.txt', parentId: s.drive.folderId, mimeType: 'text/plain', vwId: `${s.id}_SUMMARY` })).id;
      const mOk = await verifyFile(s.drive.manifestId);
      add(mOk, 'Manifiesto (manifest.json) y resumen_sesion.txt', '');
      if (!mOk) { s.status = 'finishing'; s.verified = false; }
    } catch (e) {
      s.status = 'finishing'; s.verified = false;
      add(false, 'Manifiesto', e.message);
    }
    await saveSession(s);

    report.ok = s.verified;
    if (report.ok) await freeLocalSpace(s, photos);
    this.computePending();
    return report;
  }
}

async function verifyFile(id, expectedSize) {
  if (!id) return false;
  try {
    const f = await drive.getFile(id, 'id,size,trashed');
    if (f.trashed) return false;
    if (expectedSize != null && Number(f.size) !== Number(expectedSize)) return false;
    return true;
  } catch { return false; }
}

/** Solo tras la comprobación en Drive: libera fotos grandes y trozos de audio del móvil (se conservan miniaturas). */
async function freeLocalSpace(s, photos) {
  for (const p of photos) { if (p.driveId || p.status === 'deleted') await db.del('blobs', p.id); }
  for (const g of s.segments) for (let i = 0; i < (g.chunkCount || 0); i++) await db.del('chunks', [s.id, g.seg, i]);
  s.localFreed = true;
  await saveSession(s);
}

export const sync = new SyncEngine();
