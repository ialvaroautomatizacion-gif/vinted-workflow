/**
 * Estado de las sesiones: caché en memoria respaldada por IndexedDB.
 * Todos los módulos modifican el MISMO objeto de sesión y llaman a saveSession() para persistirlo.
 * Las fotos se leen siempre frescas y se modifican con updatePhoto() (atómico).
 */
import { db } from './db.js';

const cache = new Map();

export async function loadSessions() {
  const all = await db.all('sessions');
  for (const s of all) if (!cache.has(s.id)) cache.set(s.id, s);
  return allSessions();
}

export function getSession(id) { return cache.get(id) || null; }

export function allSessions() { return [...cache.values()].sort((a, b) => b.startEpoch - a.startEpoch); }

// Escrituras en serie por sesión para no pisar datos
const queues = new Map();
export function saveSession(s) {
  cache.set(s.id, s);
  const prev = queues.get(s.id) || Promise.resolve();
  const next = prev.then(() => db.put('sessions', JSON.parse(JSON.stringify(s)))).catch(e => console.error('saveSession', e));
  queues.set(s.id, next);
  return next;
}

export async function forgetSession(id) {
  await (queues.get(id) || Promise.resolve());
  cache.delete(id); queues.delete(id);
  await db.del('sessions', id);
}

export function addIncident(s, clockOrMs, type, detail = '') {
  const ms = typeof clockOrMs === 'number' ? clockOrMs : clockOrMs?.elapsed?.() ?? null;
  s.incidents.push({ elapsed_ms: ms, epoch_ms: Date.now(), type, detail: String(detail ?? '').slice(0, 300) });
  if (s.incidents.length > 2000) s.incidents.splice(0, s.incidents.length - 2000);
  s.manifestDirty = true;
}

/** Metadatos de las fotos de una sesión, ordenadas. */
export async function photosOf(sessionId) {
  const list = await db.bySession('photos', sessionId);
  return list.sort((a, b) => a.seq - b.seq);
}

/** Modifica una foto de forma atómica y devuelve la versión guardada. */
export const updatePhoto = (id, fn) => db.update('photos', id, fn);

export async function thumbOf(photo) {
  const t = await db.get('thumbs', photo.id);
  return t?.blob || photo.thumb || null; // photo.thumb: formato de la versión 0.1
}

export const validPhotos = list => list.filter(p => p.status !== 'deleted');
