/**
 * Interfaz de Vinted Workflow (pantallas, botones y estados).
 */
import { CONFIG } from './config.js';
import { db, requestPersistence } from './db.js';
import { auth } from './auth.js';
import { drive } from './drive.js';
import { capabilities } from './capture.js';
import { pickAudioMime } from './audio.js';
import { loadSessions, allSessions, photosOf } from './store.js';
import { sync } from './sync.js';
import { SessionController, finishOrphan } from './session.js';
import { fmtDuration, fmtDateTime, fmtBytes } from './util.js';

const $ = id => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const urls = new Set();
const objUrl = blob => { const u = URL.createObjectURL(blob); urls.add(u); return u; };
const freeUrls = () => { urls.forEach(u => URL.revokeObjectURL(u)); urls.clear(); };

let controller;
let orphan = null;
let photoCount = 0;
let viewerPhoto = null;
let currentSummarySession = null;

// ---------------- Pantallas ----------------
function go(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${screen}`));
  if (screen === 'home') renderHome();
}

function photoMode() { return document.querySelector('input[name=photomode]:checked')?.value || 'auto'; }

// ---------------- Diálogo ----------------
/** onOk se ejecuta DENTRO del toque (necesario para abrir la ventana de Google en Safari). */
function confirmDialog(msg, okText = 'Aceptar', danger = true, onOk = null) {
  return new Promise(resolve => {
    $('dialog-msg').textContent = msg;
    $('dialog-ok').textContent = okText;
    $('dialog-ok').className = `btn ${danger ? 'danger' : 'primary'}`;
    show($('dialog'));
    const done = (v) => { show($('dialog'), false); $('dialog-ok').onclick = $('dialog-cancel').onclick = null; resolve(v); };
    $('dialog-ok').onclick = () => { let r = true; if (onOk) r = onOk(); done(r); };
    $('dialog-cancel').onclick = () => done(false);
  });
}

function toast(msg) {
  const b = $('banner');
  b.textContent = msg; show(b);
  clearTimeout(toast.t); toast.t = setTimeout(() => show(b, false), 5000);
}

// ---------------- Login ----------------
async function login() {
  try {
    const p = auth.signIn();          // se llama dentro del toque
    await p;
    const user = await drive.whoAmI();
    if (CONFIG.ALLOWED_EMAILS.length && !CONFIG.ALLOWED_EMAILS.map(e => e.toLowerCase()).includes(user.emailAddress.toLowerCase())) {
      auth.signOut();
      alert(`La cuenta ${user.emailAddress} no está autorizada en esta app.`);
      return false;
    }
    auth.setEmail(user.emailAddress);
    sync.kick();
    return true;
  } catch (e) {
    alert('No se pudo entrar con Google: ' + e.message);
    return false;
  }
}

function renderAuth() {
  const ok = auth.isValid();
  $('auth-status').textContent = ok ? `${auth.email || 'Conectado'} · acceso ${auth.minutesLeft()} min` : 'Sin conectar';
  $('btn-login').textContent = ok ? 'Renovar' : 'Entrar con Google';
  $('btn-start').disabled = !ok || !!orphan;
  $('start-hint').textContent = !ok ? 'Entra con Google para empezar.'
    : orphan ? 'Reanuda o termina primero la sesión pendiente.' : 'Al empezar, el iPhone pedirá permiso de cámara y micrófono.';
}

// ---------------- Inicio ----------------
async function renderHome() {
  renderAuth();
  const sessions = await loadSessions();
  orphan = sessions.find(s => s.status === 'active' && s !== controller?.s) || null;
  show($('resume-card'), !!orphan);
  if (orphan) {
    const photos = (await photosOf(orphan.id)).filter(p => p.status !== 'deleted');
    $('resume-info').textContent = `Iniciada ${fmtDateTime(orphan.startEpoch)} · ${fmtDuration(orphan.heartbeatMs)} grabados · ${photos.length} fotos`;
  }
  renderAuth();

  const list = $('session-list');
  const visible = sessions.filter(s => s.status !== 'failed');
  if (!visible.length) { list.innerHTML = '<li class="muted">Ninguna todavía.</li>'; return; }
  list.innerHTML = '';
  for (const s of visible) {
    const photos = (await photosOf(s.id)).filter(p => p.status !== 'deleted');
    const li = document.createElement('li');
    const dur = (s.endEpoch || s.startEpoch + s.heartbeatMs) - s.startEpoch;
    const tag = s.verified ? '<span class="tag ok">guardada</span>'
      : s.status === 'active' ? '<span class="tag bad">sin terminar</span>'
      : '<span class="tag pend">pendiente de subir</span>';
    li.innerHTML = `<div><b>${fmtDateTime(s.startEpoch)}</b> ${tag}</div>
      <div class="muted">${fmtDuration(dur)} · ${photos.length} fotos · ${s.segments.length} segmento(s) de audio</div>`;
    if (s.drive?.folderId) {
      const a = document.createElement('a');
      a.href = drive.folderUrl(s.drive.folderId); a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Abrir en Drive';
      li.appendChild(a);
    }
    if (s.status === 'finishing') {
      const b = document.createElement('button');
      b.className = 'btn secondary'; b.style.marginLeft = '10px'; b.textContent = 'Completar guardado';
      b.onclick = () => openSummary(s);
      li.appendChild(b);
    }
    list.appendChild(li);
  }
}

function renderSync(st) {
  const pending = st.pendingPhotos + st.pendingAudio;
  $('home-sync').textContent = st.paused ? `${st.paused} · ${pending} archivo(s) pendientes`
    : pending ? `Subiendo… ${st.pendingPhotos} foto(s) y ${st.pendingAudio} audio(s) pendientes`
    : st.lastError ? `Error: ${st.lastError}` : 'Todo sincronizado';
  $('sync-count').textContent = pending;
  const pill = $('sync-pill');
  pill.classList.toggle('pause', !!st.paused || !!st.lastError);
}

// ---------------- Sesión ----------------
async function startSession() {
  if (auth.minutesLeft() < CONFIG.TOKEN_MIN_MINUTES_TO_START) {
    const ok = await confirmDialog(
      `Al acceso a Drive le quedan ${auth.minutesLeft()} min. Renuévalo antes de empezar para que todo se suba durante la sesión.`,
      'Renovar acceso', false, () => login());
    if (!ok) return;
  }
  $('btn-start').disabled = true;
  try {
    await controller.startNew(photoMode());
    enterSessionScreen([]);
  } catch (e) {
    alert('No se pudo activar la cámara o el micrófono: ' + e.message +
      '\n\nRevisa Ajustes › Apps › Safari › Cámara y Micrófono (o el icono "aA" de la barra de direcciones › Ajustes del sitio).');
    go('home');
  }
}

function enterSessionScreen(photos) {
  const valid = photos.filter(p => p.status !== 'deleted');
  photoCount = valid.length;
  $('photo-count').textContent = photoCount;
  const last = valid[valid.length - 1];
  if (last?.thumb) $('last-thumb').src = objUrl(last.thumb); else $('last-thumb').removeAttribute('src');
  show($('recover-overlay'), false);
  $('mic-pill').classList.remove('bad');
  go('session');
}

async function onPhotoTap() {
  if (!controller.active || controller.interrupting) return;
  const f = $('flash'); f.classList.add('on'); setTimeout(() => f.classList.remove('on'), 60);
  try {
    await controller.takePhoto();
  } catch (e) { toast('No se pudo hacer la foto: ' + e.message); }
}

const ui = {
  onTick: ms => { $('timer').textContent = fmtDuration(ms); },
  onLevel: lvl => { $('meter-bar').style.width = `${Math.round(lvl * 100)}%`; },
  onPhoto: photo => {
    photoCount++;
    $('photo-count').textContent = photoCount;
    $('last-thumb').src = objUrl(photo.thumb);
  },
  onInterrupted: msg => {
    $('recover-msg').textContent = msg + '. Lo grabado hasta ahora está a salvo.';
    $('mic-pill').classList.add('bad');
    show($('recover-overlay'));
  },
  onRecovered: () => {
    show($('recover-overlay'), false);
    $('mic-pill').classList.remove('bad');
    toast('Grabación reanudada (se ha registrado el corte en el manifiesto)');
  },
  onWarn: msg => toast(msg),
};

// ---------------- Galería ----------------
async function openGallery() {
  go('gallery');
  const photos = (await controller.photos()).filter(p => p.status !== 'deleted');
  $('gal-title').textContent = `${photos.length} fotos`;
  const grid = $('gallery-grid');
  grid.innerHTML = '';
  for (const p of [...photos].reverse()) {
    const fig = document.createElement('figure');
    fig.innerHTML = `<img alt=""><figcaption>#${p.seq} · ${fmtDuration(p.elapsedMs)}</figcaption><span class="st">${p.driveId ? '☁︎' : '⏳'}</span>`;
    fig.querySelector('img').src = objUrl(p.thumb);
    fig.onclick = () => openViewer(p);
    grid.appendChild(fig);
  }
}

async function openViewer(p) {
  viewerPhoto = p;
  const full = (await db.get('blobs', p.id))?.blob;
  $('viewer-img').src = objUrl(full || p.thumb);
  $('viewer-info').textContent = `Foto #${p.seq} · minuto ${fmtDuration(p.elapsedMs)} · ${p.width || '?'}×${p.height || '?'} · ${fmtBytes(p.size)} · ${p.method} · ${p.driveId ? 'en Drive' : 'pendiente de subir'}`;
  show($('viewer'));
}

async function deleteViewerPhoto() {
  const p = viewerPhoto;
  const ok = await confirmDialog(`¿Eliminar la foto #${p.seq}? No se incluirá en la sesión (si ya estaba en Drive, se mueve a FOTOS/_ELIMINADAS).`, 'Eliminar');
  if (!ok) return;
  await controller.deletePhoto(p);
  photoCount = Math.max(0, photoCount - 1);
  $('photo-count').textContent = photoCount;
  const remaining = (await controller.photos()).filter(x => x.status !== 'deleted');
  const last = remaining[remaining.length - 1];
  if (last) $('last-thumb').src = objUrl(last.thumb); else $('last-thumb').removeAttribute('src');
  show($('viewer'), false);
  openGallery();
}

// ---------------- Fin y resumen ----------------
async function endSession() {
  const ok = await confirmDialog('¿Terminar la sesión? Se detendrán la cámara y el micrófono y se guardará todo en Drive.', 'Terminar');
  if (!ok) return;
  const s = await controller.finish();
  freeUrls();
  openSummary(s);
}

async function openSummary(s) {
  currentSummarySession = s;
  go('summary');
  $('sum-title').textContent = 'Guardando sesión…';
  show($('btn-sum-retry'), false);
  show($('btn-sum-drive'), false);
  const photos = await photosOf(s.id);
  const valid = photos.filter(p => p.status !== 'deleted');
  const audioMs = s.segments.reduce((a, g) => a + ((g.endMs ?? g.startMs) - g.startMs), 0);
  $('sum-kv').innerHTML = `
    <dt>Inicio</dt><dd>${fmtDateTime(s.startEpoch)}</dd>
    <dt>Fin</dt><dd>${s.endEpoch ? fmtDateTime(s.endEpoch) : '—'}</dd>
    <dt>Duración</dt><dd>${fmtDuration((s.endEpoch || Date.now()) - s.startEpoch)}</dd>
    <dt>Fotos válidas</dt><dd>${valid.length} (${photos.length - valid.length} eliminadas)</dd>
    <dt>Audio</dt><dd>${fmtDuration(audioMs)} en ${s.segments.length} segmento(s), ${s.gaps.length} corte(s)</dd>
    <dt>Carpeta</dt><dd>${CONFIG.ROOT_FOLDER_NAME}/${s.folderName}</dd>`;
  $('sum-checks').innerHTML = '<li>⏳ Subiendo y comprobando archivos en Drive…</li>';
  $('sum-incidents').textContent = s.incidents.map(i => `${i.elapsed_ms != null ? fmtDuration(i.elapsed_ms) : '--'}  ${i.type} ${i.detail}`).join('\n');

  const report = await sync.finalize(s);
  $('sum-checks').innerHTML = report.checks.map(c =>
    `<li>${c.ok ? '✅' : '❌'} ${c.label}${c.detail ? `<div class="muted small">${escapeHtml(c.detail)}</div>` : ''}</li>`).join('');
  $('sum-title').textContent = report.ok ? 'Sesión guardada' : 'Faltan archivos por guardar';
  show($('btn-sum-retry'), !report.ok);
  if (s.drive?.folderId) { $('btn-sum-drive').href = drive.folderUrl(s.drive.folderId); show($('btn-sum-drive')); }
  $('sum-incidents').textContent = s.incidents.map(i => `${i.elapsed_ms != null ? fmtDuration(i.elapsed_ms) : '--'}  ${i.type} ${i.detail}`).join('\n');
}

const escapeHtml = t => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------- Arranque ----------------
async function main() {
  $('app-version').textContent = `v${CONFIG.APP_VERSION}`;
  const caps = capabilities();
  $('caps-info').textContent = `Cámara/micro: ${caps.getUserMedia ? 'sí' : 'NO'} · Grabador: ${caps.mediaRecorder ? (pickAudioMime() || 'por defecto') : 'NO'} · Foto completa (takePhoto): ${caps.imageCapture ? 'sí' : 'no → fotograma'} · Pantalla activa: ${caps.wakeLock ? 'sí' : 'no'}`;
  if (CONFIG.CLIENT_ID.startsWith('PEGA_AQUI')) {
    $('auth-status').textContent = '⚠️ Falta configurar CLIENT_ID en js/config.js';
  }
  requestPersistence();
  // Recordar el modo de foto elegido (también tras recargar la página)
  const savedMode = localStorage.getItem('vw_photomode');
  if (savedMode) { const r = document.querySelector(`input[name=photomode][value=${savedMode}]`); if (r) r.checked = true; }
  document.querySelectorAll('input[name=photomode]').forEach(r => r.onchange = () => localStorage.setItem('vw_photomode', photoMode()));

  controller = new SessionController($('preview'), ui);

  auth.onChange(renderAuth);
  sync.onStatus(renderSync);
  $('btn-login').onclick = () => login().then(renderHome);
  $('btn-start').onclick = startSession;
  $('btn-photo').onclick = onPhotoTap;
  $('btn-gallery').onclick = openGallery;
  $('btn-gal-back').onclick = () => { show($('viewer'), false); go('session'); };
  $('btn-viewer-close').onclick = () => show($('viewer'), false);
  $('btn-viewer-delete').onclick = deleteViewerPhoto;
  $('btn-end').onclick = endSession;
  $('btn-recover').onclick = async () => {
    try { await controller.recoverManual(); }
    catch (e) { $('recover-msg').textContent = 'No se pudo reanudar: ' + e.message + '. Vuelve a intentarlo; si sigue fallando, recarga la página y pulsa REANUDAR.'; }
  };
  $('sync-pill').onclick = () => {
    if (!auth.isValid()) {
      confirmDialog('El acceso a Drive ha caducado. Al reconectar se abre una ventana de Google y la cámara puede pausarse un momento (se reanuda sola). Lo grabado sigue guardado en el móvil.',
        'Reconectar', false, () => login());
    } else toast(sync.status.lastError ? 'Último error: ' + sync.status.lastError : `${$('sync-count').textContent} archivo(s) pendientes de subir`);
  };
  $('btn-resume').onclick = async () => {
    const s = orphan;
    try {
      await controller.resume(s, photoMode());
      orphan = null;
      enterSessionScreen(await photosOf(s.id));
    } catch (e) { alert('No se pudo reanudar: ' + e.message); }
  };
  $('btn-finish-old').onclick = async () => {
    const ok = await confirmDialog('¿Terminar esta sesión sin reanudarla? Se guardará lo grabado hasta el corte.', 'Terminar y guardar');
    if (!ok) return;
    const s = await finishOrphan(orphan);
    orphan = null;
    openSummary(s);
  };
  $('btn-sum-retry').onclick = () => {
    const s = currentSummarySession;
    if (!auth.isValid()) { login().then(ok => ok && openSummary(s)); return; }
    openSummary(s);
  };
  $('btn-sum-home').onclick = () => go('home');

  await loadSessions();
  go('home');
  sync.start();
  try { await auth.init(); renderAuth(); }
  catch (e) { $('auth-status').textContent = e.message; }
  if (auth.isValid() && !auth.email) {
    try { auth.setEmail((await drive.whoAmI()).emailAddress); } catch { /* */ }
  }
}

main();
