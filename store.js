/**
 * Caché en memoria de las sesiones, respaldada por IndexedDB.
 * Todos los módulos modifican el MISMO objeto de sesión y llaman a saveSession() para persistirlo.
 */
import { db } from './db.js';

const cache = new Map();

export async function loadSessions() {
  const all = await db.all('sessions');
  for (const s of all) if (!cache.has(s.id)) cache.set(s.id, s);
  return [...cache.values()].sort((a, b) => b.startEpoch - a.startEpoch);
}

export function getSession(id) { return cache.get(id) || null; }

export function allSessions() { return [...cache.values()].sort((a, b) => b.startEpoch - a.startEpoch); }

// Escrituras en serie por sesión para no pisar datos
const queues = new Map();
export function saveSession(s) {
  cache.set(s.id, s);
  const prev = queues.get(s.id) || Promise.resolve();
  const next = prev.then(() => db.put('sessions', structuredCloneSafe(s))).catch(e => console.error('saveSession', e));
  queues.set(s.id, next);
  return next;
}

function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }

export function addIncident(s, clockOrMs, type, detail = '') {
  const ms = typeof clockOrMs === 'number' ? clockOrMs : clockOrMs?.elapsed?.() ?? null;
  const epoch = ms != null ? s.startEpoch + ms : Date.now();
  s.incidents.push({ elapsed_ms: ms, epoch_ms: epoch, type, detail: String(detail).slice(0, 300) });
  s.manifestDirty = true;
}

/** Datos de fotos de una sesión (sin blobs para la lista; los blobs se leen bajo demanda). */
export async function photosOf(sessionId) {
  const list = await db.bySession('photos', sessionId);
  return list.sort((a, b) => a.seq - b.seq);
}
