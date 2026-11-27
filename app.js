/**
 * Interfaz de Vinted Workflow (pantallas, botones y estados).
 */
import { CONFIG } from './config.js';
import { db, requestPersistence, storageEstimate } from './db.js';
import { auth } from './auth.js';
import { drive } from './drive.js';
import { capabilities, listCameras } from './capture.js';
import { pickAudioMime, supportedAudioFormats } from './audio.js';
import { loadSessions, photosOf, thumbOf, validPhotos, addIncident, saveSession } from './store.js';
import { sync } from './sync.js';
import { SessionController, finishOrphan } from './session.js';
import { PrendaController, currentDraft } from './prenda.js';
import { fmtDuration, fmtDateTime, fmtBytes, escapeHtml, settings } from './util.js';

const $ = id => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);

let controller;
let prenda;
let prendaSeq = 0;
let importing = false;
const prendaUrls = new Set();
let orphan = null;
let photoCount = 0;
let viewerPhoto = null;
let renderSeq = 0;
let summaryRun = 0;
let summaryState = null; // { session, report, attempts }
let pauseNoticeShown = false;
let currentScreen = 'home';

// URLs temporales de imágenes (se liberan para no acumular memoria)
let lastThumbUrl = null, viewerUrl = null;
const galleryUrls = new Set();
function setLastThumb(blob) {
  if (lastThumbUrl) URL.revokeObjectURL(lastThumbUrl);
  lastThumbUrl = blob ? URL.createObjectURL(blob) : null;
  if (lastThumbUrl) $('last-thumb').src = lastThumbUrl; else $('last-thumb').removeAttribute('src');
}
function freePrendaUrls() { prendaUrls.forEach(u => URL.revokeObjectURL(u)); prendaUrls.clear(); }
function freeGallery() {
  galleryUrls.forEach(u => URL.revokeObjectURL(u)); galleryUrls.clear();
  if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
  $('gallery-grid').innerHTML = '';
  $('viewer-img').removeAttribute('src');
}

// ---------------- Pantallas ----------------
function go(screen) {
  currentScreen = screen;
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${screen}`));
  if (screen !== 'gallery') { show($('viewer'), false); freeGallery(); }
  if (screen !== 'prenda') freePrendaUrls();
  if (screen === 'home') renderHome();
  window.scrollTo(0, 0);
}

// ---------------- Ajustes ----------------
const radio = name => document.querySelector(`input[name=${name}]:checked`)?.value;
function getOpts() {
  return { photoMode: radio('photomode') || 'auto', quality: radio('quality') || 'high', audioFormat: radio('audiofmt') || 'auto', deviceId: $('camera-select').value || '' };
}
function restoreSettings() {
  for (const name of ['photomode', 'quality', 'audiofmt']) {
    const saved = settings.get(name, null);
    const el = saved && document.querySelector(`input[name=${name}][value="${saved}"]`);
    if (el) el.checked = true;
    document.querySelectorAll(`input[name=${name}]`).forEach(r => { r.onchange = () => settings.set(name, radio(name)); });
  }
  $('camera-select').onchange = () => settings.set('camera', $('camera-select').value);
}
async function refreshCameras() {
  const cams = await listCameras();
  const sel = $('camera-select');
  const saved = settings.get('camera', '');
  sel.innerHTML = '<option value="">Trasera (automática)</option>';
  for (const c of cams) {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.label;
    sel.appendChild(o);
  }
  sel.value = cams.some(c => c.id === saved) ? saved : '';
}

// ---------------- Diálogos ----------------
/**
 * Diálogo propio (no bloquea la grabación como haría alert()).
 * onOk se ejecuta DENTRO del toque: es necesario para abrir la ventana de Google en Safari.
 * Devuelve false si se cancela; si se acepta, el resultado de onOk (o true).
 */
let dialogQueue = Promise.resolve();
function dialog(opts) {
  // Los diálogos se muestran de uno en uno: si llega otro mientras hay uno abierto, espera su turno
  const p = dialogQueue.then(() => showDialog(opts));
  dialogQueue = p.catch(() => {});
  return p;
}
function showDialog({ msg, okText = 'Aceptar', cancelText = 'Cancelar', danger = false, onOk = null }) {
  return new Promise(resolve => {
    $('dialog-msg').textContent = msg;
    $('dialog-ok').textContent = okText;
    $('dialog-ok').className = `btn ${danger ? 'danger' : 'primary'}`;
    $('dialog-cancel').textContent = cancelText || '';
    show($('dialog-cancel'), !!cancelText);
    show($('dialog'));
    const done = (v) => { show($('dialog'), false); $('dialog-ok').onclick = $('dialog-cancel').onclick = null; resolve(v); };
    $('dialog-ok').onclick = () => { let r = true; if (onOk) { try { r = onOk(); } catch (e) { r = false; console.error(e); } } done(r); };
    $('dialog-cancel').onclick = () => done(false);
  });
}
const info = msg => dialog({ msg, okText: 'Entendido', cancelText: null });

function toast(msg, ms = 6000) {
  const b = $('banner');
  b.textContent = msg; show(b);
  clearTimeout(toast.t); toast.t = setTimeout(() => show(b, false), ms);
}

// ---------------- Login ----------------
/** Debe llamarse directamente desde un toque. Devuelve true si se ha entrado con una cuenta autorizada. */
async function login({ switchAccount = false } = {}) {
  try {
    const p = auth.signIn({ switchAccount });   // abre la ventana de Google dentro del toque
    await p;
    const user = await drive.whoAmI();
    const allowed = CONFIG.ALLOWED_EMAILS.map(e => e.toLowerCase());
    if (allowed.length && !allowed.includes(user.emailAddress.toLowerCase())) {
      auth.signOut();
      await info(`La cuenta ${user.emailAddress} no está autorizada en esta app.\n\nEntra con ${CONFIG.ALLOWED_EMAILS.join(' o ')}.`);
      return false;
    }
    auth.setEmail(user.emailAddress);
    pauseNoticeShown = false;
    sync.resetBackoff();
    sync.kick();
    return true;
  } catch (e) {
    await info('No se pudo entrar con Google.\n\n' + (e?.message || e));
    return false;
  }
}

function renderAuth() {
  const ok = auth.isValid();
  const mins = auth.minutesLeft();
  $('auth-status').textContent = ok ? `${auth.email || 'Conectado'} ✓`
    : auth.email ? `${auth.email} · hay que reconectar` : (auth.ready ? 'Google Drive sin conectar' : 'Cargando…');
  $('btn-login').textContent = ok ? 'Renovar' : auth.email ? 'Reconectar' : 'Entrar con Google';
  $('btn-login').disabled = !auth.ready;
  show($('btn-login'), !ok || mins < 10);
  show($('btn-logout'), ok || !!auth.email);
  $('btn-start').disabled = !ok || !!orphan;
  $('start-hint').textContent = !ok ? 'Entra con Google para empezar.' : orphan ? 'Reanuda o termina primero la sesión pendiente.' : '';
  renderDriveAlert();
}

/** Aviso rojo fijo cuando Drive no está conectado: lo capturado se queda solo en el móvil. */
function renderDriveAlert() {
  const ok = auth.isValid();
  const pending = sync.status.pendingPhotos + sync.status.pendingAudio;
  const txt = !auth.ready ? 'Cargando Google…'
    : pending ? `⚠️ ${pending} archivo(s) SIN SUBIR a Drive\nToca aquí para conectar Google Drive`
    : '⚠️ Google Drive NO está conectado\nToca aquí para conectar';
  document.querySelectorAll('.drive-alert').forEach(b => { b.textContent = txt; b.disabled = !auth.ready; show(b, !ok); });
  show($('status-row'), ok);
}

// ---------------- Comprobaciones del dispositivo ----------------
async function environmentWarnings() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const caps = capabilities();
  const warns = [];
  if (isIOS && (/CriOS|FxiOS|EdgiOS|GSA\/|FBAN|FBAV|Instagram|Line\/|WhatsApp|TikTok|Twitter/.test(ua) || !/Safari\//.test(ua))) {
    warns.push('Estás abriendo la app desde otra aplicación o navegador. Ábrela en Safari (copia el enlace y pégalo en Safari): fuera de Safari, la cámara, el micrófono o el acceso a Google pueden fallar.');
  }
  if (navigator.standalone) warns.push('Estás usando la app desde el icono de la pantalla de inicio. De momento es más fiable abrirla desde Safari.');
  if (!caps.getUserMedia || !caps.mediaRecorder) warns.push('Este navegador no permite usar la cámara y grabar audio desde una página web. Actualiza iOS o usa Safari.');
  try { await db.check(); }
  catch { warns.push('No se puede guardar en este navegador (¿navegación privada?). Usa una pestaña normal de Safari: sin almacenamiento local no hay copia de seguridad de la sesión.'); }
  const est = await storageEstimate();
  if (est?.quota && est.quota - (est.usage || 0) < CONFIG.LOW_SPACE_BYTES) {
    warns.push(`Queda poco espacio para guardar la sesión en el móvil (${fmtBytes(est.quota - (est.usage || 0))}). Libera espacio en el iPhone antes de una sesión larga.`);
  }
  const box = $('env-warning');
  box.innerHTML = warns.map(w => `<p>⚠️ ${escapeHtml(w)}</p>`).join('');
  show(box, warns.length > 0);

  const fmts = supportedAudioFormats();
  $('caps-info').textContent = [
    `Versión ${CONFIG.APP_VERSION}`,
    `Cámara y micrófono: ${caps.getUserMedia ? 'sí' : 'NO'}`,
    `Audio: ${caps.mediaRecorder ? (pickAudioMime(radio('audiofmt')) || 'formato por defecto') : 'NO'} (WebM ${fmts.webm ? 'sí' : 'no'}, MP4 ${fmts.mp4 ? 'sí' : 'no'})`,
    `Foto completa (takePhoto): ${caps.imageCapture ? 'sí' : 'no, se usa fotograma'}`,
    `Pantalla siempre activa: ${caps.wakeLock ? 'sí' : 'no'}`,
    est?.quota ? `Espacio local: ${fmtBytes(est.usage || 0)} usados de ${fmtBytes(est.quota)}` : '',
  ].filter(Boolean).join(' · ');
}

// ---------------- Inicio ----------------
const homeUrls = new Set(), homeUrlsOld = new Set();
async function renderHome() {
  const my = ++renderSeq;
  renderAuth();
  const sessions = await loadSessions();
  const data = [];
  for (const s of sessions) {
    if (s.status === 'failed') continue;
    const ph = validPhotos(await photosOf(s.id));
    const first = s.kind === 'prenda' && s.status !== 'draft' ? [...ph].sort((a, b) => (a.order || a.seq) - (b.order || b.seq))[0] : null;
    data.push({ s, photos: ph.length, thumb: first ? await thumbOf(first) : null });
  }
  if (my !== renderSeq) return; // hay un repintado más reciente en marcha
  homeUrls.forEach(u => homeUrlsOld.add(u)); homeUrls.clear();

  orphan = sessions.find(s => s.kind !== 'prenda' && s.status === 'active' && s !== controller?.s) || null;
  show($('resume-card'), !!orphan);
  if (orphan) {
    const n = data.find(d => d.s === orphan)?.photos ?? 0;
    $('resume-info').textContent = `Iniciada el ${fmtDateTime(orphan.startEpoch)} · ${fmtDuration(orphan.heartbeatMs)} de sesión · ${n} fotos`;
    $('more').open = true; $('session-mode').open = true;
  }
  renderAuth();

  // Botón principal: prenda nueva o continuar la que está a medias
  const draft = currentDraft();
  const dn = draft ? (data.find(d => d.s === draft)?.photos ?? 0) : 0;
  const da = draft ? draft.segments.filter(g => g.endMs != null).length : 0;
  const hasDraft = !!draft && (dn > 0 || da > 0);
  $('btn-prenda').textContent = hasDraft ? 'CONTINUAR PRENDA' : 'NUEVA PRENDA';
  $('prenda-hint').textContent = hasDraft ? `A medias: ${dn} foto(s) y ${da} audio(s).` : '';
  show($('prenda-hint'), hasDraft);

  const list = $('session-list');
  const frag = document.createDocumentFragment();
  for (const { s, photos, thumb } of data) {
    if (s === controller?.s || s.status === 'draft') continue;
    const li = document.createElement('li');
    const isPrenda = s.kind === 'prenda';
    const dur = (s.endEpoch || s.startEpoch + (s.heartbeatMs || 0)) - s.startEpoch;
    const audios = s.segments.filter(g => !g.full?.empty && (g.chunkCount || 0) > 0).length;
    const tag = s.verified ? '<span class="tag ok">en Drive ✓</span>'
      : s.lossy ? '<span class="tag pend">guardada con incidencias</span>'
      : s.status === 'active' ? '<span class="tag bad">sin terminar</span>'
      : '<span class="tag pend">pendiente de subir</span>';
    const title = isPrenda ? `Prenda ${String(s.number || '').padStart(2, '0')} · ${fmtDateTime(s.endEpoch || s.startEpoch)}` : `Sesión · ${fmtDateTime(s.startEpoch)}`;
    const detail = isPrenda ? `${photos} foto(s) · ${audios} audio(s)` : `${fmtDuration(dur)} · ${photos} fotos · ${audios} audio(s)`;
    li.innerHTML = `${isPrenda ? '<img class="mini-thumb" alt="">' : ''}<div><div><b>${escapeHtml(title)}</b> ${tag}</div>
      <div class="muted">${escapeHtml(detail)}</div>
      <div class="session-actions"></div></div>`;
    if (isPrenda) {
      li.className = 'with-thumb';
      if (thumb) { const u = URL.createObjectURL(thumb); homeUrls.add(u); li.querySelector('img').src = u; }
    }
    const actions = li.querySelector('.session-actions');
    if (s.drive?.folderId) {
      const a = document.createElement('a');
      a.href = drive.folderUrl(s.drive.folderId); a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Abrir en Drive';
      actions.appendChild(a);
    }
    if (s.status === 'finishing') {
      const b = document.createElement('button');
      b.className = 'btn mini primary'; b.textContent = 'Completar guardado';
      b.onclick = () => openSummary(s);
      actions.appendChild(b);
    }
    if (s.status !== 'active') {
      const d = document.createElement('button');
      d.className = 'btn mini secondary'; d.textContent = 'Eliminar';
      d.onclick = () => deleteSessionFlow(s, photos);
      actions.appendChild(d);
    }
    frag.appendChild(li);
  }
  homeUrlsOld.forEach(u => URL.revokeObjectURL(u)); homeUrlsOld.clear();
  list.innerHTML = '';
  if (frag.childNodes.length) list.appendChild(frag);
  show($('list-card'), frag.childNodes.length > 0 || list.childNodes.length > 0);
}

async function deleteSessionFlow(s, photos) {
  const inDrive = !!s.drive?.folderId;
  const needLogin = inDrive && !auth.isValid();
  const pending = !(s.verified || s.lossy);
  const what = s.kind === 'prenda' ? `la prenda ${String(s.number || '').padStart(2, '0')} del ${fmtDateTime(s.endEpoch || s.startEpoch)}` : `la sesión del ${fmtDateTime(s.startEpoch)}`;
  const msg = `¿Eliminar ${what} (${photos} fotos)?\n\n`
    + (inDrive ? `Su carpeta de Drive (${s.folderName}) se enviará a la papelera de Drive, donde Google la conserva 30 días por si te arrepientes. ` : 'Todavía no se había subido nada a Drive. ')
    + 'También se borrará de la app. No afecta a nada más: ni a otras prendas, ni a las fotos de la galería del iPhone.'
    + (pending ? '\n\n⚠️ ATENCIÓN: tiene archivos que aún NO se han subido a Drive. Si la eliminas, esos archivos se pierden para siempre.' : '')
    + (needLogin ? '\n\nPrimero se abrirá Google para confirmar tu cuenta.' : '');
  const ok = await dialog({ msg, okText: 'Eliminar', danger: true, onOk: () => (needLogin ? login() : true) });
  if (!ok) return;
  try { await sync.deleteSession(s); }
  catch (e) { await info('No se pudo eliminar.\n\n' + (e?.message || e)); }
  renderHome();
}

function renderSync(st, justSaved) {
  renderDriveAlert();
  if (justSaved && currentScreen === 'home') renderHome();
  const pending = st.pendingPhotos + st.pendingAudio;
  $('home-sync').textContent = !pending && !st.lastError ? (auth.isValid() ? 'Todo en Drive' : '')
    : !navigator.onLine ? `Sin conexión · ${pending} archivo(s) por subir`
    : !auth.isValid() ? `${pending} archivo(s) por subir: entra con Google`
    : st.lastError ? `Reintentando la subida…`
    : `Subiendo… quedan ${pending}`;
  $('sync-count').textContent = pending;
  $('sync-pill').classList.toggle('pause', pending > 0 && (!!st.paused || !!st.lastError));
  if (currentScreen === 'summary' && st.working) $('sum-progress').textContent = `${st.working} · quedan ${pending} archivo(s)`;
  // Aviso único cuando la subida se pausa en mitad de una sesión (no es un error: sigue guardándose en el móvil)
  if (controller?.active && st.paused && !pauseNoticeShown && pending > 0) {
    pauseNoticeShown = true;
    toast(navigator.onLine
      ? 'La subida a Drive está en pausa (el acceso de Google dura 1 hora). Sigue trabajando con normalidad: todo se guarda en el móvil y se subirá al terminar.'
      : 'Sin conexión. Sigue trabajando con normalidad: todo se guarda en el móvil y se subirá cuando vuelva la cobertura.', 9000);
  }
  if (!st.paused) pauseNoticeShown = false;
}

// ---------------- Sesión ----------------
let starting = false;
async function startSession() {
  if (controller.s || starting) return;
  starting = true;
  try { await startSessionInner(); } finally { starting = false; }
}
async function startSessionInner() {
  const caps = capabilities();
  if (!caps.getUserMedia || !caps.mediaRecorder) {
    await info('Este navegador no permite usar la cámara y grabar audio desde una página web.\n\nAbre la app en Safari con iOS actualizado.');
    return;
  }
  if (auth.minutesLeft() < CONFIG.TOKEN_MIN_MINUTES_TO_START) {
    const ok = await dialog({
      msg: `Al acceso a Drive le quedan ${auth.minutesLeft()} min. Renuévalo antes de empezar para que las fotos y el audio se vayan subiendo durante la sesión.`,
      okText: 'Renovar acceso', onOk: () => login(),
    });
    if (!ok) return;
  }
  $('btn-start').disabled = true;
  $('start-hint').textContent = 'Activando cámara y micrófono…';
  try {
    await controller.startNew(getOpts());
    enterSessionScreen([]);
    refreshCameras();
  } catch (e) {
    const denied = e?.name === 'NotAllowedError';
    await info((denied ? 'No hay permiso para usar la cámara o el micrófono.' : 'No se pudo activar la cámara o el micrófono: ' + (e?.message || e))
      + '\n\nPara permitirlo: toca el icono de la izquierda de la barra de direcciones de Safari › Ajustes del sitio web › Cámara y Micrófono › Permitir. Después recarga la página.');
    go('home');
  }
}

async function enterSessionScreen(photos) {
  const valid = validPhotos(photos);
  photoCount = valid.length;
  $('photo-count').textContent = photoCount;
  const last = valid[valid.length - 1];
  setLastThumb(last ? await thumbOf(last) : null);
  show($('recover-overlay'), false);
  $('rec-pill').classList.remove('bad');
  $('mic-pill').classList.remove('bad');
  $('timer').textContent = fmtDuration(controller.elapsed);
  pauseNoticeShown = false;
  go('session');
  // Evita que el gesto "atrás" de Safari saque de la página a mitad de sesión
  try { history.pushState({ vw: 'session' }, ''); } catch { /* */ }
}

async function onPhotoTap() {
  controller.nudge();
  if (!controller.canShoot) { toast('La cámara se está reactivando. Espera un segundo y vuelve a pulsar.', 2500); return; }
  const f = $('flash'); f.classList.add('on'); setTimeout(() => f.classList.remove('on'), 60);
  try { await controller.takePhoto(); }
  catch (e) { toast('No se pudo hacer la foto: ' + (e?.message || e)); }
}

const ui = {
  onTick: ms => { $('timer').textContent = fmtDuration(ms); },
  onLevel: lvl => {
    const m = document.querySelector('.meter');
    m.classList.toggle('idle', lvl == null);
    if (lvl != null) $('meter-bar').style.width = `${Math.round(lvl * 100)}%`;
  },
  onPhoto: (photo, thumb) => {
    photoCount++;
    const b = $('photo-count');
    b.textContent = photoCount;
    b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump');
    if (thumb) setLastThumb(thumb);
  },
  onInterrupted: (msg, soft) => {
    $('recover-title').textContent = soft ? 'Toca para reactivar la cámara' : 'Grabación interrumpida';
    $('recover-msg').textContent = msg + (soft ? '.' : '. Lo grabado hasta ahora está a salvo.');
    $('btn-recover').textContent = soft ? 'REACTIVAR CÁMARA' : 'REANUDAR GRABACIÓN';
    $('rec-pill').classList.toggle('bad', !soft);
    $('mic-pill').classList.toggle('bad', !soft);
    if (currentScreen === 'gallery') go('session');
    show($('recover-overlay'));
  },
  onRecovered: (msg) => {
    show($('recover-overlay'), false);
    $('rec-pill').classList.remove('bad');
    $('mic-pill').classList.remove('bad');
    if (msg) toast(msg, 4000);
  },
  onWarn: msg => toast(msg, 10000),
  onCamera: ({ zoom, torch }) => {
    const z = $('btn-zoom');
    show(z, !!zoom); if (zoom) z.textContent = zoom;
    const t = $('btn-torch');
    show(t, !!torch); t.classList.remove('on');
  },
};

// ---------------- Galería ----------------
async function openGallery() {
  controller.nudge();
  go('gallery');
  const photos = validPhotos(await controller.photos());
  $('gal-title').textContent = photos.length === 1 ? '1 foto' : `${photos.length} fotos`;
  const grid = $('gallery-grid');
  grid.innerHTML = photos.length ? '' : '<p class="muted center">Todavía no hay fotos en esta sesión.</p>';
  for (const p of [...photos].reverse()) {
    const fig = document.createElement('figure');
    fig.innerHTML = `<img alt="Foto ${p.seq}" loading="lazy"><figcaption>#${p.seq} · ${fmtDuration(p.elapsedMs)}</figcaption><span class="st">${p.driveId ? '☁︎' : '⏳'}</span>`;
    fig.onclick = () => openViewer(p.id);
    grid.appendChild(fig);
    thumbOf(p).then(t => {
      if (!t || currentScreen !== 'gallery' || !fig.isConnected) return;
      const u = URL.createObjectURL(t); galleryUrls.add(u);
      fig.querySelector('img').src = u;
    });
  }
}

async function openViewer(id) {
  const p = await db.get('photos', id);
  if (!p) return;
  viewerPhoto = p;
  const full = (await db.get('blobs', id))?.blob || await thumbOf(p);
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = full ? URL.createObjectURL(full) : null;
  if (viewerUrl) $('viewer-img').src = viewerUrl;
  $('viewer-info').textContent = `Foto #${p.seq} · minuto ${fmtDuration(p.elapsedMs)} · ${p.width || '?'}×${p.height || '?'} · ${fmtBytes(p.size)} · ${p.driveId ? 'ya está en Drive' : 'pendiente de subir'}`;
  show($('viewer'));
}

async function deleteViewerPhoto() {
  const p = viewerPhoto;
  if (!p) return;
  const ok = await dialog({ msg: `¿Eliminar la foto #${p.seq}?\n\nNo se incluirá en la sesión.${p.driveId ? ' Como ya estaba en Drive, se moverá a la carpeta FOTOS/_ELIMINADAS.' : ''}`, okText: 'Eliminar', danger: true });
  if (!ok) return;
  await controller.deletePhoto(p);
  const remaining = validPhotos(await controller.photos());
  photoCount = remaining.length;
  $('photo-count').textContent = photoCount;
  const last = remaining[remaining.length - 1];
  setLastThumb(last ? await thumbOf(last) : null);
  show($('viewer'), false);
  if (currentScreen === 'gallery') openGallery();
}

// ---------------- Fin y resumen ----------------
async function endSession() {
  if (!controller.s) return;
  const ok = await dialog({ msg: '¿Terminar la sesión?\n\nSe detendrán la cámara y el micrófono y se guardará todo en Drive.', okText: 'Terminar sesión', danger: true });
  if (!ok || !controller.s) return;
  $('btn-end').disabled = true;
  try {
    const s = await controller.finish();
    setLastThumb(null);
    show($('recover-overlay'), false);
    if (s) openSummary(s);
  } finally { $('btn-end').disabled = false; }
}

const incidentText = s => s.incidents.map(i => `${i.elapsed_ms != null ? fmtDuration(i.elapsed_ms) : '--:--:--'}  ${i.type} ${i.detail}`).join('\n');

async function openSummary(s, { auto = false } = {}) {
  const my = ++summaryRun;
  if (!auto || !summaryState || summaryState.session !== s) summaryState = { session: s, attempts: 0 };
  summaryState.attempts++;
  go('summary');
  const isPrenda = s.kind === 'prenda';
  const W = isPrenda ? 'prenda' : 'sesión';
  $('sum-title').textContent = `Guardando ${W}…`;
  $('sum-progress').textContent = isPrenda ? 'Puedes seguir con la siguiente prenda: la subida continúa sola mientras Safari esté abierto.' : 'No cierres Safari hasta que termine.';
  show($('btn-sum-retry'), false);
  show($('btn-sum-drive'), false);
  show($('btn-sum-next'), isPrenda);
  const photos = await photosOf(s.id);
  const valid = validPhotos(photos);
  const audioMs = s.segments.reduce((a, g) => a + ((g.endMs ?? g.startMs) - g.startMs), 0);
  const audios = s.segments.filter(g => (g.chunkCount || 0) > 0).length;
  $('sum-kv').innerHTML = isPrenda ? `
    <dt>Prenda</dt><dd>${String(s.number || '').padStart(2, '0')} · ${fmtDateTime(s.endEpoch || s.startEpoch)}</dd>
    <dt>Fotos</dt><dd>${valid.length}</dd>
    <dt>Audio</dt><dd>${audios ? `${audios} (${fmtDuration(audioMs)})` : 'sin audio'}</dd>
    <dt>Carpeta</dt><dd>${escapeHtml(CONFIG.ROOT_FOLDER_NAME)}/${escapeHtml(s.dayFolder)}/${escapeHtml(s.folderName)}</dd>` : `
    <dt>Inicio</dt><dd>${fmtDateTime(s.startEpoch)}</dd>
    <dt>Fin</dt><dd>${s.endEpoch ? fmtDateTime(s.endEpoch) : '—'}</dd>
    <dt>Duración</dt><dd>${fmtDuration((s.endEpoch || Date.now()) - s.startEpoch)}</dd>
    <dt>Fotos válidas</dt><dd>${valid.length}${photos.length - valid.length ? ` (${photos.length - valid.length} eliminadas)` : ''}</dd>
    <dt>Audio</dt><dd>${fmtDuration(audioMs)}${s.gaps.length ? ` · ${s.gaps.length} corte(s)` : ' · sin cortes'}</dd>
    <dt>Carpeta</dt><dd>${escapeHtml(CONFIG.ROOT_FOLDER_NAME)}/${escapeHtml(s.folderName)}</dd>`;
  $('sum-checks').innerHTML = '<li>⏳ Subiendo y comprobando archivos en Drive…</li>';
  $('sum-incidents').textContent = incidentText(s);

  let report;
  try { report = await sync.finalize(s); }
  catch (e) { report = { ok: false, checks: [{ ok: false, label: 'Error inesperado al guardar', detail: (e?.message || e) + '. No se ha borrado nada del móvil; pulsa Reintentar.' }] }; }
  if (my !== summaryRun) return;
  summaryState.report = report;

  const icon = c => c.warn ? '⚠️' : c.ok ? '✅' : (report.needsLogin || report.offline) ? '⏳' : '❌';
  $('sum-checks').innerHTML = report.checks.map(c =>
    `<li>${icon(c)} ${escapeHtml(c.label)}${c.detail ? `<div class="muted small">${escapeHtml(c.detail)}</div>` : ''}</li>`).join('');
  const G = isPrenda ? 'Prenda guardada' : 'Sesión guardada';
  $('sum-title').textContent = report.ok ? (report.lossy ? `${G} con incidencias` : G)
    : report.needsLogin ? 'Falta subir a Drive' : report.offline ? 'Esperando conexión' : 'Faltan archivos por guardar';
  $('sum-progress').textContent = report.ok ? 'Todo está en tu Google Drive y comprobado.'
    : isPrenda ? 'No se ha perdido nada: sigue guardada en la app y se subirá en cuanto se pueda. Puedes continuar con la siguiente.'
    : 'No se ha perdido nada: lo pendiente sigue guardado en este móvil.';
  $('btn-sum-retry').textContent = report.needsLogin ? 'Conectar con Google y subir' : 'Reintentar ahora';
  show($('btn-sum-retry'), !report.ok);
  if (s.drive?.folderId) { $('btn-sum-drive').href = drive.folderUrl(s.drive.folderId); show($('btn-sum-drive')); }
  $('sum-incidents').textContent = incidentText(s);

  // Reintento automático si el fallo fue de conexión (no si hace falta que el usuario entre con Google)
  clearTimeout(openSummary.timer);
  if (!report.ok && !report.needsLogin && summaryState.attempts < 6) {
    openSummary.timer = setTimeout(() => {
      if (currentScreen === 'summary' && summaryState?.session === s && my === summaryRun && navigator.onLine) openSummary(s, { auto: true });
    }, 20000);
  }
}

// ---------------- Prenda (modo sencillo) ----------------
async function openPrenda({ ask = false } = {}) {
  if (controller.s) return;
  if (ask && !auth.isValid()) {
    const r = await dialog({
      msg: 'Google Drive NO está conectado.\n\nSi sigues sin conectar, las fotos y el audio se quedan solo en este móvil hasta que conectes.',
      okText: 'Conectar ahora', cancelText: 'Seguir sin conectar', onOk: () => (auth.ready ? login() : false),
    });
    if (r) await r;
  }
  await prenda.open();
  go('prenda');
  try { history.pushState({ vw: 'prenda' }, ''); } catch { /* */ }
  await renderPrenda();
}

async function renderPrenda() {
  const my = ++prendaSeq;
  if (!prenda.s) return;
  const photos = await prenda.photos();
  const audios = prenda.audios();
  const thumbs = await Promise.all(photos.map(p => thumbOf(p)));
  const blobs = await Promise.all(audios.map(g => prenda.audioBlob(g)));
  if (my !== prendaSeq || !prenda.s || currentScreen !== 'prenda') return;
  freePrendaUrls();

  $('prenda-photo-count').textContent = photos.length ? `(${photos.length})` : '';
  const grid = $('prenda-grid');
  grid.innerHTML = '';
  photos.forEach((p, i) => {
    const fig = document.createElement('figure');
    fig.innerHTML = `<img alt="Foto ${i + 1}"><figcaption>${i + 1}</figcaption><button class="rm" aria-label="Quitar foto ${i + 1}">✕</button>`;
    if (thumbs[i]) { const u = URL.createObjectURL(thumbs[i]); prendaUrls.add(u); fig.querySelector('img').src = u; }
    fig.querySelector('.rm').onclick = async () => { await prenda.removePhoto(p.id); };
    grid.appendChild(fig);
  });
  $('btn-pick').textContent = importing ? 'Guardando foto…' : photos.length ? '📷 HACER OTRA FOTO' : '📷 HACER FOTO';

  const list = $('audio-list');
  list.innerHTML = '';
  audios.forEach((g, i) => {
    const li = document.createElement('li');
    const u = URL.createObjectURL(blobs[i]); prendaUrls.add(u);
    li.innerHTML = `<audio controls preload="metadata"></audio><span class="dur">${fmtDuration(g.endMs - g.startMs).slice(3)}</span><button class="btn mini secondary">Borrar</button>`;
    li.querySelector('audio').src = u;
    li.querySelector('button').onclick = async () => {
      const ok = await dialog({ msg: `¿Borrar el audio ${i + 1} (${fmtDuration(g.endMs - g.startMs).slice(3)})?`, okText: 'Borrar audio', danger: true });
      if (ok) await prenda.removeAudio(g);
    };
    list.appendChild(li);
  });
  renderRecButton(audios.length);
  $('btn-save').disabled = photos.length === 0 || importing;
  $('prenda-title').textContent = photos.length || audios.length ? `Prenda: ${photos.length} foto(s), ${audios.length} audio(s)` : 'Prenda nueva';
}

function renderRecButton(count = prenda.audios().length) {
  const rec = prenda.recording;
  const b = $('btn-rec');
  b.classList.toggle('recording', rec);
  b.classList.toggle('secondary', !rec);
  b.textContent = rec ? '■ PARAR GRABACIÓN' : count ? '🎙 GRABAR OTRO AUDIO' : '🎙 GRABAR AUDIO';
  show($('rec-live'), rec);
}

async function onPickFiles(e) {
  const files = [...(e.target.files || [])];
  e.target.value = ''; // permite volver a elegir las mismas fotos
  if (!files.length || !prenda.s || importing) return;
  importing = true;
  $('btn-save').disabled = true;
  try {
    const r = await prenda.addFiles(files, (i, n) => { $('btn-pick').textContent = n > 1 ? `Añadiendo foto ${i} de ${n}…` : 'Guardando foto…'; });
    if (r.skipped) toast(`${r.skipped} archivo(s) no se han podido añadir (solo se admiten fotos).`);
  } catch (err) { toast('No se pudieron añadir las fotos: ' + (err?.message || err)); }
  finally { importing = false; renderPrenda(); }
}

async function onRecTap() {
  if (!prenda.s) return;
  const b = $('btn-rec');
  if (b.disabled) return;
  b.disabled = true;
  try {
    if (prenda.recording) await prenda.stopRecording('usuario');
    else {
      $('rec-time').textContent = '00:00';
      await prenda.startRecording(radio('audiofmt') || 'mp4');
      renderRecButton();
    }
  } catch (e) {
    const denied = e?.name === 'NotAllowedError';
    await info((denied ? 'No hay permiso para usar el micrófono.' : 'No se pudo grabar: ' + (e?.message || e))
      + (denied ? '\n\nPara permitirlo: toca el icono de la izquierda de la barra de direcciones de Safari › Ajustes del sitio web › Micrófono › Permitir.' : ''));
  } finally { b.disabled = false; }
}

async function savePrenda() {
  if (!prenda.s || importing) return;
  const photos = await prenda.photos();
  if (!photos.length) return;
  if (!prenda.recording && prenda.audios().length === 0) {
    const ok = await dialog({ msg: 'Esta prenda no tiene audio.\n\n¿Guardarla solo con las fotos?', okText: 'Guardar sin audio', cancelText: 'Volver' });
    if (!ok) return;
  }
  $('btn-save').disabled = true;
  try {
    const s = await prenda.save();
    sync.resetBackoff();
    openSummary(s);
  } catch (e) { await info('No se pudo guardar la prenda: ' + (e?.message || e)); renderPrenda(); }
}

async function discardPrenda() {
  if (!prenda.s) return;
  const ok = await dialog({ msg: '¿Descartar esta prenda?\n\nSe quitan de la app las fotos elegidas y los audios grabados. Las fotos siguen en la galería de tu iPhone.', okText: 'Descartar', danger: true });
  if (!ok) return;
  await prenda.discard();
  go('home');
}

async function leavePrenda() {
  if (prenda.recording) {
    const ok = await dialog({ msg: 'Se está grabando un audio. ¿Pararlo y volver al inicio?\n\nLa prenda se queda guardada a medias para continuarla luego.', okText: 'Parar y salir' });
    if (!ok) return;
  }
  await prenda.leave();
  go('home');
}

const prendaUi = {
  onChange: () => { if (currentScreen === 'prenda') renderPrenda(); },
  onLevel: lvl => { if (lvl != null) $('rec-meter-bar').style.width = `${Math.round(lvl * 100)}%`; },
  onRecTick: ms => { $('rec-time').textContent = fmtDuration(ms).slice(3); },
  onRecStopped: (reason, saved) => {
    renderRecButton();
    if (reason !== 'usuario') toast(saved
      ? 'La grabación se ha cortado (iOS ha parado el micrófono). Lo grabado está guardado: puedes escucharlo y grabar otro audio para continuar.'
      : 'iOS ha parado el micrófono antes de grabar nada. Vuelve a pulsar GRABAR AUDIO.', 9000);
  },
  onWarn: msg => toast(msg, 10000),
};

// ---------------- Arranque ----------------
async function main() {
  $('app-version').textContent = `Versión ${CONFIG.APP_VERSION}`;
  restoreSettings();
  requestPersistence();
  environmentWarnings();
  refreshCameras();

  controller = new SessionController($('preview'), ui);
  prenda = new PrendaController(prendaUi);

  auth.onChange(renderAuth);
  sync.onStatus(renderSync);
  setInterval(renderAuth, 30000); // refresca los minutos de acceso

  $('btn-login').onclick = () => login().then(renderHome);
  $('btn-logout').onclick = () => login({ switchAccount: true }).then(renderHome);
  $('btn-start').onclick = startSession;
  $('btn-prenda').onclick = () => openPrenda({ ask: true });
  document.querySelectorAll('.drive-alert').forEach(b => { b.onclick = () => login().then(() => { if (currentScreen === 'home') renderHome(); }); });
  $('btn-prenda-back').onclick = leavePrenda;
  $('file-input').onchange = onPickFiles;
  $('camera-input').onchange = onPickFiles;
  $('btn-rec').onclick = onRecTap;
  $('btn-save').onclick = savePrenda;
  $('btn-discard').onclick = discardPrenda;
  $('btn-sum-next').onclick = () => { clearTimeout(openSummary.timer); openPrenda(); };
  $('btn-photo').onclick = onPhotoTap;
  $('btn-gallery').onclick = openGallery;
  $('btn-gal-back').onclick = () => go('session');
  $('btn-viewer-close').onclick = () => show($('viewer'), false);
  $('btn-viewer-delete').onclick = deleteViewerPhoto;
  $('btn-end').onclick = endSession;
  $('btn-recover-end').onclick = endSession;
  $('btn-zoom').onclick = async () => { const z = await controller.cycleZoom(); if (z) $('btn-zoom').textContent = z; };
  $('btn-torch').onclick = async () => { $('btn-torch').classList.toggle('on', await controller.toggleTorch()); };
  $('btn-recover').onclick = async () => {
    $('btn-recover').disabled = true;
    try { await controller.recoverManual(); }
    catch (e) { $('recover-msg').textContent = 'No se pudo reanudar: ' + (e?.message || e) + '. Vuelve a intentarlo. Si sigue fallando, recarga la página y pulsa REANUDAR: no se pierde lo grabado.'; }
    finally { $('btn-recover').disabled = false; }
  };
  $('sync-pill').onclick = () => {
    const st = sync.status, pending = st.pendingPhotos + st.pendingAudio;
    if (!auth.isValid()) {
      dialog({
        msg: 'La subida a Drive está en pausa porque el acceso de Google dura 1 hora. No pasa nada: todo se guarda en el móvil y se subirá al terminar.\n\nSi prefieres reconectar ahora, se abrirá una ventana de Google y la grabación puede cortarse un par de segundos (se reanuda sola y el corte queda anotado).',
        okText: 'Reconectar ahora', cancelText: 'Seguir así', onOk: () => login(),
      });
    } else toast(st.lastError ? `Reintentando la subida (${st.lastError}). Lo pendiente sigue guardado en el móvil.` : pending ? `Subiendo a Drive: quedan ${pending} archivo(s).` : 'Todo lo capturado hasta ahora ya está en Drive.', 4000);
  };
  $('btn-resume').onclick = async () => {
    const s = orphan;
    if (!s || controller.s || starting) return;
    starting = true;
    $('btn-resume').disabled = true;
    try {
      await controller.resume(s, getOpts());
      orphan = null;
      await enterSessionScreen(await photosOf(s.id));
    } catch (e) {
      await info('No se pudo reanudar: ' + (e?.message || e) + '\n\nComprueba el permiso de cámara y micrófono y vuelve a intentarlo. También puedes pulsar TERMINAR Y GUARDAR: lo grabado no se pierde.');
      renderHome();
    } finally { $('btn-resume').disabled = false; starting = false; }
  };
  $('btn-finish-old').onclick = async () => {
    const s = orphan;
    if (!s) return;
    const ok = await dialog({ msg: '¿Terminar esta sesión sin reanudarla?\n\nSe guardará en Drive todo lo grabado hasta el corte.', okText: 'Terminar y guardar' });
    if (!ok) return;
    await finishOrphan(s);
    orphan = null;
    openSummary(s);
  };
  $('btn-sum-retry').onclick = () => {
    const s = summaryState?.session;
    if (!s) return;
    if (!auth.isValid()) { login().then(ok => { if (ok) openSummary(s); }); return; }
    openSummary(s);
  };
  $('btn-sum-home').onclick = () => { clearTimeout(openSummary.timer); go('home'); };

  // Al volver la conexión, completar el guardado pendiente sin que el usuario tenga que pulsar nada
  window.addEventListener('online', () => {
    if (currentScreen === 'summary' && summaryState?.report && !summaryState.report.ok && !summaryState.report.needsLogin) openSummary(summaryState.session, { auto: true });
  });
  // Gesto "atrás" de Safari: durante la sesión no debe sacar de la página
  window.addEventListener('popstate', () => {
    if (currentScreen === 'prenda' && prenda.s) {
      if (prenda.recording) { try { history.pushState({ vw: 'prenda' }, ''); } catch { /* */ } toast('Se está grabando. Para salir, pulsa primero PARAR GRABACIÓN.', 3500); }
      else leavePrenda();
      return;
    }
    if (!controller.s) return;
    try { history.pushState({ vw: 'session' }, ''); } catch { /* */ }
    if (currentScreen === 'gallery') go('session');
    else toast('Para salir, pulsa TERMINAR SESIÓN.', 3000);
  });
  // Si Safari restaura la página desde su caché de navegación, se recarga para partir de un estado limpio
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
  // Errores inesperados: quedan anotados en el diagnóstico de la sesión
  const note = (kind, detail) => { const s = controller?.s || prenda?.s; if (s) { addIncident(s, controller?.s ? controller.clock : null, kind, detail); saveSession(s); } };
  window.addEventListener('error', e => note('error_javascript', e.message));
  window.addEventListener('unhandledrejection', e => note('error_promesa', e.reason?.message || e.reason));

  await loadSessions().catch(() => {});
  go('home');
  sync.start();
  try { await auth.init(); }
  catch (e) { $('auth-status').textContent = e.message; }
  renderAuth();
  if (auth.isValid() && !auth.email) {
    try {
      const user = await drive.whoAmI();
      const allowed = CONFIG.ALLOWED_EMAILS.map(x => x.toLowerCase());
      if (allowed.length && !allowed.includes(user.emailAddress.toLowerCase())) auth.signOut(); else auth.setEmail(user.emailAddress);
    } catch { /* se pedirá al entrar */ }
  }
}

main();
