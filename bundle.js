/* Vinted Workflow — archivo generado automáticamente a partir de los módulos .js de este repositorio. No editar a mano. */

// ../vinted-workflow/config.js
var CONFIG = {
  APP_VERSION: "0.6.0",
  // ID de cliente OAuth (tipo "Aplicación web") del proyecto de Google Cloud "vinted-workflow".
  CLIENT_ID: "34737536696-u8js6hqusljsbs5v5b4i424b3ejuhto2.apps.googleusercontent.com",
  // Correos autorizados. Si entras con otra cuenta, la app se niega a trabajar
  // (capa extra; la protección real es la de Google: modo Prueba + usuarios de prueba).
  ALLOWED_EMAILS: ["ialvaroautomatizacion@gmail.com"],
  // Permiso mínimo: la app solo ve y modifica los archivos que ella misma crea.
  SCOPE: "https://www.googleapis.com/auth/drive.file",
  ROOT_FOLDER_NAME: "VINTED_WORKFLOW",
  // Audio: el grabador entrega un trozo cada AUDIO_TIMESLICE_MS (se guarda al momento en el móvil).
  // Cada AUDIO_CHUNKS_PER_PART trozos se sube un fragmento a Drive (12 x 5 s = 1 minuto).
  AUDIO_TIMESLICE_MS: 5e3,
  AUDIO_CHUNKS_PER_PART: 12,
  AUDIO_BITRATE: 64e3,
  // Si no llega ningún trozo de audio en este tiempo, se considera que el grabador se ha parado y se reinicia.
  AUDIO_WATCHDOG_MS: 16e3,
  // Cámara
  PREVIEW_WIDTH: 1920,
  PREVIEW_HEIGHT: 1080,
  // vista previa cuando las fotos salen de takePhoto()
  FRAME_HIGH: [3840, 2160],
  // fotos por fotograma, calidad alta (4K)
  FRAME_NORMAL: [1920, 1080],
  // fotos por fotograma, calidad normal (menos batería y calor)
  JPEG_QUALITY: 0.92,
  THUMB_SIZE: 320,
  // Sincronización
  SYNC_INTERVAL_MS: 5e3,
  TOKEN_MIN_MINUTES_TO_START: 45,
  // al empezar sesión, pedir renovar si quedan menos minutos de acceso
  LOW_SPACE_BYTES: 600 * 1024 * 1024
};

// ../vinted-workflow/db.js
var DB_NAME = "vinted-workflow";
var DB_VERSION = 2;
var dbPromise = null;
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      return reject(e);
    }
    req.onupgradeneeded = () => {
      const d = req.result;
      const has = (n) => d.objectStoreNames.contains(n);
      if (!has("sessions")) d.createObjectStore("sessions", { keyPath: "id" });
      if (!has("photos")) d.createObjectStore("photos", { keyPath: "id" }).createIndex("bySession", "sessionId");
      if (!has("chunks")) d.createObjectStore("chunks", { keyPath: ["sessionId", "seg", "seq"] }).createIndex("bySession", "sessionId");
      if (!has("blobs")) d.createObjectStore("blobs", { keyPath: "id" });
      if (!has("thumbs")) d.createObjectStore("thumbs", { keyPath: "id" });
      if (!has("kv")) d.createObjectStore("kv", { keyPath: "k" });
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => d.close();
      resolve(d);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Cierra las demás pestañas de Vinted Workflow y recarga"));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}
var reqP = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});
function tx(store, mode, fn) {
  return open().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    let result;
    try {
      Promise.resolve(fn(t.objectStore(store))).then((r) => {
        result = r;
      }, (e) => {
        try {
          t.abort();
        } catch {
        }
        reject(e);
      });
    } catch (e) {
      return reject(e);
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("No se pudo guardar en el móvil (¿sin espacio?)"));
  }));
}
var db = {
  /** Comprueba que el almacenamiento local funciona (falla en algunos modos privados). */
  check: () => open().then(() => true),
  put: (store, obj) => tx(store, "readwrite", (s) => {
    s.put(obj);
    return obj;
  }),
  get: (store, key) => tx(store, "readonly", (s) => reqP(s.get(key))),
  del: (store, key) => tx(store, "readwrite", (s) => {
    s.delete(key);
  }),
  all: (store) => tx(store, "readonly", (s) => reqP(s.getAll())),
  bySession: (store, sessionId) => tx(store, "readonly", (s) => reqP(s.index("bySession").getAll(sessionId))),
  /**
   * Leer-modificar-escribir en UNA transacción (atómico). fn recibe el objeto actual y lo modifica.
   * Evita que dos partes de la app se pisen cambios (p. ej. borrar una foto mientras se está subiendo).
   */
  update: (store, key, fn) => tx(store, "readwrite", async (s) => {
    const cur = await reqP(s.get(key));
    if (!cur) return null;
    fn(cur);
    s.put(cur);
    return cur;
  }),
  chunksRange: (sessionId, seg, fromSeq, toSeq) => tx(
    "chunks",
    "readonly",
    (s) => reqP(s.getAll(IDBKeyRange.bound([sessionId, seg, fromSeq], [sessionId, seg, toSeq])))
  ),
  /** Último trozo de audio guardado de un segmento (para reconstruir tras un cierre inesperado). */
  lastChunk: (sessionId, seg) => tx("chunks", "readonly", (s) => new Promise((res, rej) => {
    const r = s.openCursor(IDBKeyRange.bound([sessionId, seg, 0], [sessionId, seg, Number.MAX_SAFE_INTEGER]), "prev");
    r.onsuccess = () => {
      const c = r.result;
      res(c ? { seq: c.value.seq, endMs: c.value.endMs, startMs: c.value.startMs } : null);
    };
    r.onerror = () => rej(r.error);
  })),
  delChunks: (sessionId, seg) => tx(
    "chunks",
    "readwrite",
    (s) => {
      s.delete(IDBKeyRange.bound([sessionId, seg, 0], [sessionId, seg, Number.MAX_SAFE_INTEGER]));
    }
  ),
  kvGet: async (k) => (await db.get("kv", k))?.v,
  kvSet: (k, v) => db.put("kv", { k, v })
};
async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
  }
  return false;
}
async function storageEstimate() {
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

// ../vinted-workflow/auth.js
var KEY = "vw_token";
var tokenClient = null;
var token = null;
var expiryTimer = null;
var listeners = /* @__PURE__ */ new Set();
var auth = {
  onChange(fn) {
    listeners.add(fn);
  },
  get token() {
    return token && token.expiresAt > Date.now() + 3e4 ? token.access_token : null;
  },
  get email() {
    return token?.email || null;
  },
  minutesLeft() {
    return token ? Math.max(0, Math.floor((token.expiresAt - Date.now()) / 6e4)) : 0;
  },
  isValid() {
    return !!auth.token;
  },
  get ready() {
    return !!tokenClient;
  },
  init,
  signIn,
  signOut,
  setEmail
};
function emit() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  });
}
function save() {
  try {
    if (token) sessionStorage.setItem(KEY, JSON.stringify(token));
    else sessionStorage.removeItem(KEY);
  } catch {
  }
  clearTimeout(expiryTimer);
  if (token && token.expiresAt > Date.now()) expiryTimer = setTimeout(emit, Math.max(1e3, token.expiresAt - Date.now() - 29e3));
}
async function waitForGis(timeoutMs = 15e3) {
  const t0 = Date.now();
  while (!window.google?.accounts?.oauth2) {
    if (Date.now() - t0 > timeoutMs) throw new Error("No se pudo cargar el inicio de sesión de Google. Revisa la conexión o desactiva los bloqueadores de contenido para esta página.");
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function init() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (saved && saved.expiresAt > Date.now() + 6e4) {
      token = saved;
      save();
    }
  } catch {
  }
  emit();
  await waitForGis();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPE,
    callback: () => {
    }
    // se sustituye en cada petición
  });
  emit();
}
var ERRORS = {
  popup_closed: "Se cerró la ventana de Google antes de terminar.",
  popup_failed_to_open: 'Safari ha bloqueado la ventana de Google. Vuelve a pulsar el botón; si sigue igual, desactiva "Bloquear ventanas" en Ajustes › Apps › Safari.',
  access_denied: "No se concedió el permiso. Si Google dice que la app está bloqueada, esa cuenta no está en la lista de usuarios de prueba."
};
function signIn({ switchAccount = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error("Google todavía se está cargando. Espera un par de segundos y vuelve a pulsar."));
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(ERRORS[resp.error] || resp.error_description || resp.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, CONFIG.SCOPE)) {
        return reject(new Error("No se concedió el permiso de Google Drive (hay que dejar marcada la casilla de acceso a archivos)."));
      }
      token = {
        access_token: resp.access_token,
        expiresAt: Date.now() + (Number(resp.expires_in) || 3599) * 1e3,
        email: switchAccount ? null : token?.email || null
      };
      save();
      emit();
      resolve(token);
    };
    tokenClient.error_callback = (err) => reject(new Error(ERRORS[err?.type] || err?.message || "Inicio de sesión cancelado"));
    const hint = token?.email || CONFIG.ALLOWED_EMAILS[0];
    const opts = { prompt: switchAccount || !token ? "select_account" : "" };
    if (hint && !switchAccount) opts.login_hint = hint;
    tokenClient.requestAccessToken(opts);
  });
}
function setEmail(email) {
  if (token) {
    token.email = email;
    save();
    emit();
  }
}
function signOut() {
  token = null;
  save();
  emit();
}
function invalidateToken() {
  if (token) {
    token.expiresAt = 0;
    save();
    emit();
  }
}

// ../vinted-workflow/drive.js
var API = "https://www.googleapis.com/drive/v3";
var UPLOAD = "https://www.googleapis.com/upload/drive/v3";
var FOLDER_MIME = "application/vnd.google-apps.folder";
var MULTIPART_MAX = 4 * 1024 * 1024;
var DriveError = class extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status;
  }
};
async function request(method, url, { json, body, headers = {} } = {}) {
  const tok = auth.token;
  if (!tok) throw new DriveError("Sin acceso a Drive (hay que volver a entrar con Google)", 401);
  const h = { Authorization: `Bearer ${tok}`, ...headers };
  if (json !== void 0) {
    h["Content-Type"] = "application/json; charset=UTF-8";
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(url, { method, headers: h, body });
  } catch (e) {
    throw new DriveError("Sin conexión con Drive", 0);
  }
  if (res.status === 401) {
    invalidateToken();
    throw new DriveError("El acceso a Drive ha caducado", 401);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.error?.message || "";
    } catch {
    }
    throw new DriveError(`Drive ${res.status}: ${detail}`.trim(), res.status);
  }
  return res;
}
var wait = (ms) => new Promise((r) => setTimeout(r, ms));
var transient = (e) => e instanceof DriveError && (e.status === 429 || e.status >= 500 || e.status === 0 && navigator.onLine);
async function retrying(fn, delays = [800, 2500]) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= delays.length || !transient(e)) throw e;
      await wait(delays[i]);
    }
  }
}
var q = (s) => encodeURIComponent(s);
var esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
var drive = {
  folderUrl: (id) => `https://drive.google.com/drive/folders/${id}`,
  async whoAmI() {
    const r = await retrying(() => request("GET", `${API}/about?fields=user(emailAddress,displayName)`));
    return (await r.json()).user;
  },
  async findByVwId(vwId) {
    const query = `appProperties has { key='vwId' and value='${esc(vwId)}' } and trashed=false`;
    const r = await retrying(() => request("GET", `${API}/files?q=${q(query)}&fields=files(id,name,size,parents)&spaces=drive&pageSize=10`));
    const files = (await r.json()).files || [];
    return files[0] || null;
  },
  async getFile(id, fields = "id,name,size,trashed,parents") {
    const r = await retrying(() => request("GET", `${API}/files/${id}?fields=${q(fields)}`));
    return r.json();
  },
  /** true si la carpeta existe y no está en la papelera */
  async folderAlive(id) {
    try {
      const f = await drive.getFile(id, "id,trashed");
      return !f.trashed;
    } catch (e) {
      if (e.status === 404) return false;
      throw e;
    }
  },
  async ensureFolder(name, parentId, vwId) {
    const found = await drive.findByVwId(vwId);
    if (found) return found.id;
    const meta = { name, mimeType: FOLDER_MIME, appProperties: { vwId, vwApp: "1" } };
    if (parentId) meta.parents = [parentId];
    const r = await request("POST", `${API}/files?fields=id`, { json: meta });
    return (await r.json()).id;
  },
  /** Sube un archivo nuevo. Devuelve { id, size }. Cada reintento vuelve a comprobar si ya existe (sin duplicados). */
  upload(args) {
    return retrying(() => drive.uploadOnce(args));
  },
  async uploadOnce({ blob, name, parentId, mimeType, vwId, props = {} }) {
    const existing = await drive.findByVwId(vwId);
    if (existing && Number(existing.size || 0) === blob.size) return { id: existing.id, size: blob.size, reused: true };
    if (existing) {
      const j2 = await drive.updateContent(existing.id, blob, mimeType);
      return { id: j2.id, size: Number(j2.size) };
    }
    const meta = { name, parents: [parentId], mimeType, appProperties: { vwId, vwApp: "1", ...props } };
    if (blob.size > MULTIPART_MAX) {
      const init2 = await request("POST", `${UPLOAD}/files?uploadType=resumable&fields=id,size`, {
        json: meta,
        headers: { "X-Upload-Content-Type": mimeType, "X-Upload-Content-Length": String(blob.size) }
      });
      let location2 = init2.headers.get("Location");
      const uploadId = init2.headers.get("X-GUploader-UploadID");
      if (!location2 && uploadId) location2 = `${UPLOAD}/files?uploadType=resumable&fields=id,size&upload_id=${q(uploadId)}`;
      if (location2) {
        let res;
        try {
          res = await fetch(location2, { method: "PUT", headers: { "Content-Type": mimeType }, body: blob });
        } catch {
          throw new DriveError("Subida interrumpida (sin conexión)", 0);
        }
        if (!res.ok) throw new DriveError(`Drive ${res.status} al subir ${name}`, res.status);
        const j2 = await res.json();
        return { id: j2.id, size: Number(j2.size) };
      }
    }
    const boundary = "vw" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const body = new Blob([
      `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify(meta)}\r
`,
      `--${boundary}\r
Content-Type: ${mimeType}\r
\r
`,
      blob,
      `\r
--${boundary}--`
    ]);
    const r = await request("POST", `${UPLOAD}/files?uploadType=multipart&fields=id,size`, {
      body,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` }
    });
    const j = await r.json();
    return { id: j.id, size: Number(j.size) };
  },
  /** Reemplaza el contenido de un archivo existente (manifiesto, resumen). */
  async updateContent(fileId, blob, mimeType) {
    const r = await retrying(() => request("PATCH", `${UPLOAD}/files/${fileId}?uploadType=media&fields=id,size`, {
      body: blob,
      headers: { "Content-Type": mimeType }
    }));
    return r.json();
  },
  async move(fileId, addParent, removeParent) {
    const r = await retrying(() => request(
      "PATCH",
      `${API}/files/${fileId}?addParents=${q(addParent)}&removeParents=${q(removeParent)}&fields=id,parents`,
      { json: {} }
    ));
    return r.json();
  },
  /**
   * Envía una carpeta de sesión a la PAPELERA de Drive (recuperable 30 días).
   * Solo actúa si la carpeta lleva la marca de esa sesión.
   */
  async trashSessionFolder(folderId, sessionId) {
    const f = await drive.getFile(folderId, "id,trashed,mimeType,appProperties");
    if (f.mimeType !== FOLDER_MIME || f.appProperties?.vwId !== `${sessionId}_DIR`) {
      throw new DriveError("La carpeta no corresponde a esta sesión; no se toca.", 409);
    }
    if (f.trashed) return true;
    await request("PATCH", `${API}/files/${folderId}?fields=id,trashed`, { json: { trashed: true } });
    return true;
  }
};

// ../vinted-workflow/capture.js
function capabilities() {
  return {
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    mediaRecorder: typeof MediaRecorder !== "undefined",
    imageCapture: typeof ImageCapture !== "undefined" && "takePhoto" in (ImageCapture.prototype || {}),
    wakeLock: "wakeLock" in navigator
  };
}
async function listCameras() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === "videoinput" && d.label).map((d) => ({ id: d.deviceId, label: d.label }));
  } catch {
    return [];
  }
}
var Capture = class {
  /**
   * @param {HTMLVideoElement} videoEl
   * @param {object} o { photoMode: 'auto'|'frame', quality: 'high'|'normal', deviceId, onTrackEvent(kind, ev) }
   */
  constructor(videoEl, { photoMode = "auto", quality = "high", deviceId = "", onTrackEvent = () => {
  } } = {}) {
    this.video = videoEl;
    this.requestedMode = photoMode;
    this.quality = quality;
    this.deviceId = deviceId;
    this.onTrackEvent = onTrackEvent;
    this.stream = null;
    this.imageCapture = null;
    this.mode = "frame";
    this.takePhotoFailures = 0;
    this.zoomSteps = [];
    this.zoomIndex = 0;
    this.torchOn = false;
  }
  get audioTrack() {
    return this.stream?.getAudioTracks()[0] || null;
  }
  get videoTrack() {
    return this.stream?.getVideoTracks()[0] || null;
  }
  async start() {
    const useTakePhoto = this.requestedMode !== "frame" && capabilities().imageCapture;
    const [fw, fh] = this.quality === "normal" ? CONFIG.FRAME_NORMAL : CONFIG.FRAME_HIGH;
    const w = useTakePhoto ? CONFIG.PREVIEW_WIDTH : fw;
    const h = useTakePhoto ? CONFIG.PREVIEW_HEIGHT : fh;
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const size = { width: { ideal: w }, height: { ideal: h } };
    try {
      const video = this.deviceId ? { deviceId: { exact: this.deviceId }, ...size } : { facingMode: { ideal: "environment" }, ...size };
      this.stream = await navigator.mediaDevices.getUserMedia({ audio, video });
    } catch (e) {
      if (e?.name !== "OverconstrainedError" && e?.name !== "NotFoundError") throw e;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: { facingMode: { ideal: "environment" } } });
    }
    if (!this.audioTrack || !this.videoTrack) {
      this.stop();
      throw new Error("El navegador no ha entregado cámara y micrófono a la vez");
    }
    this.video.srcObject = this.stream;
    this.video.setAttribute("playsinline", "");
    this.video.muted = true;
    await this.ensurePlaying();
    this.mode = "frame";
    if (useTakePhoto) {
      try {
        this.imageCapture = new ImageCapture(this.videoTrack);
        this.mode = "takephoto";
      } catch {
        this.imageCapture = null;
      }
    }
    for (const t of this.stream.getTracks()) {
      t.addEventListener("ended", () => this.onTrackEvent(t.kind, "ended"));
      t.addEventListener("mute", () => this.onTrackEvent(t.kind, "mute"));
      t.addEventListener("unmute", () => this.onTrackEvent(t.kind, "unmute"));
    }
    this.setupZoom();
    return this.stream;
  }
  /** Intenta que la vista previa se esté reproduciendo. Devuelve true si lo consigue. */
  async ensurePlaying() {
    try {
      if (this.video.paused) await this.video.play();
    } catch {
    }
    return !this.video.paused;
  }
  get previewPlaying() {
    return !!this.stream && !this.video.paused && this.video.readyState >= 2;
  }
  // ---------- Zoom y linterna (solo si el dispositivo los ofrece) ----------
  setupZoom() {
    this.zoomSteps = [];
    this.zoomIndex = 0;
    try {
      const caps = this.videoTrack.getCapabilities?.() || {};
      this.hasTorch = !!caps.torch;
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        const cur = this.videoTrack.getSettings?.().zoom || caps.zoom.min;
        const steps = [cur, cur * 2, cur * 3].filter((z) => z <= caps.zoom.max + 1e-3);
        if (steps.length > 1) this.zoomSteps = steps;
      }
    } catch {
    }
  }
  get zoomLabel() {
    if (!this.zoomSteps.length) return null;
    return `${Math.round(this.zoomSteps[this.zoomIndex] / this.zoomSteps[0] * 10) / 10}×`;
  }
  async cycleZoom() {
    if (!this.zoomSteps.length) return null;
    const next = (this.zoomIndex + 1) % this.zoomSteps.length;
    try {
      await this.videoTrack.applyConstraints({ advanced: [{ zoom: this.zoomSteps[next] }] });
      this.zoomIndex = next;
    } catch (e) {
      this.onTrackEvent("video", "zoom_error: " + (e?.message || e));
    }
    return this.zoomLabel;
  }
  async toggleTorch() {
    if (!this.hasTorch) return false;
    try {
      await this.videoTrack.applyConstraints({ advanced: [{ torch: !this.torchOn }] });
      this.torchOn = !this.torchOn;
    } catch (e) {
      this.onTrackEvent("video", "linterna_error: " + (e?.message || e));
    }
    return this.torchOn;
  }
  info() {
    const s = this.videoTrack?.getSettings?.() || {};
    return { mode: this.mode, quality: this.quality, width: s.width, height: s.height, frameRate: s.frameRate, facing: s.facingMode, camera: this.videoTrack?.label || null, microphone: this.audioTrack?.label || null };
  }
  healthy() {
    const a = this.audioTrack, v = this.videoTrack;
    return {
      audio: !!a && a.readyState === "live" && !a.muted,
      video: !!v && v.readyState === "live" && !v.muted,
      audioLive: !!a && a.readyState === "live"
    };
  }
  /** Devuelve { blob, width, height, method } */
  async takePhoto() {
    if (this.mode === "takephoto" && this.imageCapture) {
      try {
        const blob = await withTimeout(this.imageCapture.takePhoto(), 8e3, "takePhoto no responde");
        if (!blob || !blob.size) throw new Error("foto vacía");
        this.takePhotoFailures = 0;
        const dims = await imageSize(blob);
        return { blob, ...dims, method: "takePhoto" };
      } catch (e) {
        this.takePhotoFailures++;
        this.onTrackEvent("video", "takephoto_error: " + (e?.message || e));
        if (this.takePhotoFailures >= 2) {
          this.mode = "frame";
          this.onTrackEvent("video", "takephoto_desactivado_se_usa_fotograma");
        }
      }
    }
    return this.grabFrame();
  }
  async grabFrame() {
    const v = this.video;
    if (v.paused) await this.ensurePlaying();
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h || v.readyState < 2) throw new Error("La cámara todavía no muestra imagen");
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(v, 0, 0, w, h);
    const blob = await new Promise((res, rej) => c.toBlob((b) => b && b.size ? res(b) : rej(new Error("No se pudo crear la foto")), "image/jpeg", CONFIG.JPEG_QUALITY));
    c.width = c.height = 0;
    return { blob, width: w, height: h, method: "frame" };
  }
  stop() {
    this.stream?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
      }
    });
    if (this.video.srcObject === this.stream) this.video.srcObject = null;
    this.stream = null;
    this.imageCapture = null;
  }
};
function withTimeout(promise, ms, msg) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}
async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2e3);
  }
}
async function imageSize(blob) {
  try {
    const img = await loadImage(blob);
    return { width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return { width: null, height: null };
  }
}
async function makeThumb(blob, size = CONFIG.THUMB_SIZE) {
  try {
    const img = await loadImage(blob);
    const r = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * r));
    c.height = Math.max(1, Math.round(img.naturalHeight * r));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const t = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.7));
    c.width = c.height = 0;
    return t;
  } catch {
    return null;
  }
}
var LevelMeter = class {
  constructor(track, onLevel) {
    this.onLevel = onLevel;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      const src = this.ctx.createMediaStreamSource(new MediaStream([track]));
      this.an = this.ctx.createAnalyser();
      this.an.fftSize = 512;
      src.connect(this.an);
      this.buf = new Uint8Array(this.an.fftSize);
      this.timer = setInterval(() => this.tick(), 120);
    } catch (e) {
      console.warn("Medidor no disponible", e);
    }
  }
  /** Llamar dentro de un toque: iOS solo deja activar el análisis de audio tras un gesto. */
  nudge() {
    if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {
    });
  }
  get running() {
    return this.ctx?.state === "running";
  }
  tick() {
    if (!this.an) return;
    if (this.ctx.state !== "running") {
      this.onLevel(null);
      return;
    }
    this.an.getByteTimeDomainData(this.buf);
    let peak = 0;
    for (const v of this.buf) peak = Math.max(peak, Math.abs(v - 128));
    this.onLevel(Math.min(1, peak / 64));
  }
  stop() {
    clearInterval(this.timer);
    try {
      this.ctx?.close();
    } catch {
    }
  }
};

// ../vinted-workflow/audio.js
var WEBM = ["audio/webm;codecs=opus", "audio/webm"];
var MP4 = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"];
function pickAudioMime(prefer = "auto") {
  if (typeof MediaRecorder === "undefined") return null;
  const order = prefer === "mp4" ? [...MP4, ...WEBM] : [...WEBM, ...MP4];
  for (const m of order) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
    }
  }
  return "";
}
function supportedAudioFormats() {
  const ok = (list) => list.some((m) => {
    try {
      return MediaRecorder.isTypeSupported(m);
    } catch {
      return false;
    }
  });
  if (typeof MediaRecorder === "undefined") return { webm: false, mp4: false };
  return { webm: ok(WEBM), mp4: ok(MP4) };
}
var SegmentRecorder = class {
  /**
   * @param {MediaStreamTrack} track pista de audio
   * @param {object} o { clock, prefer, onChunk(blob, startMs, endMs), onError(msg) }
   */
  constructor(track, { clock, prefer = "auto", onChunk, onError }) {
    this.track = track;
    this.clock = clock;
    this.prefer = prefer;
    this.onChunk = onChunk;
    this.onError = onError;
    this.rec = null;
    this.startMs = null;
    this.lastEnd = null;
    this.stopping = null;
    this.lastChunkAt = 0;
  }
  start() {
    const mime = pickAudioMime(this.prefer);
    const opts = { audioBitsPerSecond: CONFIG.AUDIO_BITRATE };
    if (mime) opts.mimeType = mime;
    try {
      this.rec = new MediaRecorder(new MediaStream([this.track]), opts);
    } catch {
      this.rec = new MediaRecorder(new MediaStream([this.track]));
    }
    this.mimeType = this.rec.mimeType || mime || "audio/mp4";
    this.startMs = this.clock.elapsed();
    this.lastEnd = this.startMs;
    this.lastChunkAt = performance.now();
    this.rec.addEventListener("start", () => {
      const t = this.clock.elapsed();
      this.startMs = t;
      this.lastEnd = t;
      this.lastChunkAt = performance.now();
    });
    this.rec.addEventListener("dataavailable", (e) => {
      const end = this.clock.elapsed();
      if (e.data && e.data.size > 0) {
        const start = this.lastEnd;
        this.lastEnd = end;
        this.lastChunkAt = performance.now();
        this.onChunk(e.data, start, end);
      }
    });
    this.rec.addEventListener("error", (e) => this.onError?.("MediaRecorder: " + (e.error?.message || e.error?.name || "error")));
    this.rec.start(CONFIG.AUDIO_TIMESLICE_MS);
    return this.mimeType;
  }
  get state() {
    return this.rec?.state || "inactive";
  }
  /** Milisegundos desde el último trozo recibido (para detectar un grabador parado). */
  get silenceMs() {
    return performance.now() - this.lastChunkAt;
  }
  /** Detiene y espera al último trozo. */
  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = new Promise((resolve) => {
      if (!this.rec || this.rec.state === "inactive") return setTimeout(() => resolve(this.lastEnd), 250);
      const done = () => setTimeout(() => resolve(this.lastEnd), 80);
      this.rec.addEventListener("stop", done, { once: true });
      try {
        this.rec.stop();
      } catch {
        done();
      }
      setTimeout(() => resolve(this.lastEnd), 4e3);
    });
    return this.stopping;
  }
};

// ../vinted-workflow/store.js
var cache = /* @__PURE__ */ new Map();
async function loadSessions() {
  const all = await db.all("sessions");
  for (const s of all) if (!cache.has(s.id)) cache.set(s.id, s);
  return allSessions();
}
function allSessions() {
  return [...cache.values()].sort((a, b) => b.startEpoch - a.startEpoch);
}
var queues = /* @__PURE__ */ new Map();
function saveSession(s) {
  cache.set(s.id, s);
  const prev = queues.get(s.id) || Promise.resolve();
  const next = prev.then(() => db.put("sessions", JSON.parse(JSON.stringify(s)))).catch((e) => console.error("saveSession", e));
  queues.set(s.id, next);
  return next;
}
async function forgetSession(id) {
  await (queues.get(id) || Promise.resolve());
  cache.delete(id);
  queues.delete(id);
  await db.del("sessions", id);
}
function addIncident(s, clockOrMs, type, detail = "") {
  const ms = typeof clockOrMs === "number" ? clockOrMs : clockOrMs?.elapsed?.() ?? null;
  s.incidents.push({ elapsed_ms: ms, epoch_ms: Date.now(), type, detail: String(detail ?? "").slice(0, 300) });
  if (s.incidents.length > 2e3) s.incidents.splice(0, s.incidents.length - 2e3);
  s.manifestDirty = true;
}
async function photosOf(sessionId) {
  const list = await db.bySession("photos", sessionId);
  return list.sort((a, b) => a.seq - b.seq);
}
var updatePhoto = (id, fn) => db.update("photos", id, fn);
async function thumbOf(photo) {
  const t = await db.get("thumbs", photo.id);
  return t?.blob || photo.thumb || null;
}
var validPhotos = (list) => list.filter((p) => p.status !== "deleted");

// ../vinted-workflow/util.js
var SessionClock = class {
  constructor(startEpoch) {
    this.startEpoch = startEpoch;
    this.anchor();
  }
  anchor() {
    this.base = Date.now() - this.startEpoch;
    this.perf0 = performance.now();
  }
  elapsed() {
    return Math.max(0, Math.round(this.base + (performance.now() - this.perf0)));
  }
  /** Diferencia (ms) entre el reloj monotónico y la hora del sistema. */
  drift() {
    return Date.now() - this.startEpoch - this.elapsed();
  }
  /** Si el reloj monotónico se quedó atrás (página congelada), lo re-ancla. Devuelve el desfase corregido o 0. */
  resyncIfDrifted(toleranceMs = 2e3) {
    const d = this.drift();
    if (Math.abs(d) <= toleranceMs) return 0;
    this.anchor();
    return d;
  }
};
var pad = (n, w = 2) => String(n).padStart(w, "0");
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1e3);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
}
var fmtStamp = (ms) => fmtDuration(ms).replace(/:/g, "-") + "." + pad(Math.max(0, Math.round(ms)) % 1e3, 3);
function isoLocal(epoch) {
  const d = new Date(epoch);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function fmtDateTime(epoch) {
  const d = new Date(epoch);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function folderNameFor(epoch) {
  const d = new Date(epoch);
  return `SESION_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function randomId(len = 6) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}
function fmtBytes(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function extFor(mime) {
  if (!mime) return "bin";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("jpeg")) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("heic") || mime.includes("heif")) return "heic";
  return "bin";
}
var escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var settings = {
  get(key, def) {
    try {
      const v = localStorage.getItem("vw_" + key);
      return v == null ? def : v;
    } catch {
      return def;
    }
  },
  set(key, v) {
    try {
      localStorage.setItem("vw_" + key, v);
    } catch {
    }
  }
};
function measureAudioDurationMs(blob, timeoutMs = 6e3) {
  return new Promise((resolve) => {
    let done = false;
    const a = document.createElement("audio");
    const url = URL.createObjectURL(blob);
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.removeAttribute("src");
      try {
        a.load();
      } catch {
      }
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const check = () => {
      const d = a.duration;
      if (Number.isFinite(d) && d > 0) finish(Math.round(d * 1e3));
    };
    a.preload = "metadata";
    a.muted = true;
    a.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(a.duration) && a.duration > 0) return finish(Math.round(a.duration * 1e3));
      try {
        a.currentTime = 1e7;
      } catch {
        finish(null);
      }
    });
    a.addEventListener("durationchange", check);
    a.addEventListener("seeked", check);
    a.addEventListener("timeupdate", check);
    a.addEventListener("error", () => finish(null));
    a.src = url;
    try {
      a.load();
    } catch {
    }
  });
}
function log(...args) {
  console.log("[VW]", ...args);
}

// ../vinted-workflow/manifest.js
var pendingAudioSegments = (s) => s.segments.filter((g) => g.endMs != null && !g.full?.empty && !g.full?.driveId);
function buildManifest(s, photos) {
  const valid = photos.filter((p) => p.status !== "deleted");
  const deleted = photos.filter((p) => p.status === "deleted");
  const lastKnown = s.startEpoch + Math.max(s.heartbeatMs || 0, ...s.segments.map((g) => g.endMs || 0));
  const base = `${CONFIG.ROOT_FOLDER_NAME}/${s.folderName}`;
  const photoOut = (p) => {
    const isDel = p.status === "deleted";
    return {
      photo_id: p.id,
      seq: p.seq,
      file_name: p.fileName,
      drive_path: p.driveId ? `${base}/FOTOS/${isDel ? "_ELIMINADAS/" : ""}${p.fileName}` : null,
      drive_file_id: p.driveId || null,
      elapsed_ms: p.elapsedMs,
      captured_at: isoLocal(p.epoch),
      captured_epoch_ms: p.epoch,
      width: p.width,
      height: p.height,
      bytes: p.size,
      mime_type: p.mime,
      capture_method: p.method,
      status: isDel ? "eliminada" : p.driveId ? "guardada_en_drive" : "pendiente_de_subir",
      ...isDel ? { deleted_at: isoLocal(p.deletedAt), was_uploaded: !!p.driveId } : {}
    };
  };
  const segments = s.segments.map((g) => ({
    segment: g.seg,
    mime_type: g.mimeType,
    start_elapsed_ms: g.startMs,
    end_elapsed_ms: g.endMs ?? null,
    start_at: isoLocal(s.startEpoch + g.startMs),
    end_at: g.endMs != null ? isoLocal(s.startEpoch + g.endMs) : null,
    duration_ms: g.endMs != null ? g.endMs - g.startMs : null,
    measured_audio_duration_ms: g.measuredMs ?? null,
    end_reason: g.endReason || "grabando",
    chunks_recorded: g.chunkCount,
    full_file: g.full?.empty ? { status: "sin_datos" } : g.full ? {
      file_name: g.full.fileName,
      drive_path: `${base}/AUDIO/${g.full.fileName}`,
      drive_file_id: g.full.driveId || null,
      bytes: g.full.size || null,
      status: g.full.driveId ? "guardado_en_drive" : "pendiente"
    } : { status: g.endMs != null ? "pendiente" : "se_genera_al_terminar" },
    parts: (g.parts || []).map((pt) => ({
      part: pt.part + 1,
      file_name: pt.fileName,
      drive_path: `${base}/AUDIO/fragmentos/${pt.fileName}`,
      drive_file_id: pt.driveId || null,
      start_elapsed_ms: pt.startMs,
      end_elapsed_ms: pt.endMs,
      bytes: pt.size
    }))
  }));
  const pendingPhotos = valid.filter((p) => !p.driveId).length;
  const pendingAudio = pendingAudioSegments(s).length;
  return {
    schema: "vinted-workflow/manifest@1",
    app_version: CONFIG.APP_VERSION,
    generated_at: isoLocal(Date.now()),
    session: {
      session_id: s.id,
      folder: base,
      status: s.status === "finished" ? "terminada" : s.status === "finishing" ? "guardando" : "en_curso_o_interrumpida",
      start_at: isoLocal(s.startEpoch),
      start_epoch_ms: s.startEpoch,
      end_at: s.endEpoch ? isoLocal(s.endEpoch) : null,
      end_epoch_ms: s.endEpoch || null,
      timezone: s.timezone,
      utc_offset_minutes: s.utcOffsetMin,
      duration_ms: (s.endEpoch || lastKnown) - s.startEpoch,
      google_account: s.accountEmail || null
    },
    timeline_notes: [
      "elapsed_ms = milisegundos desde el inicio de la sesión (reloj monotónico del navegador).",
      "Para situar un instante dentro de un archivo de audio: posición_en_archivo_ms = elapsed_ms - start_elapsed_ms del segmento que lo contiene.",
      "Los fragmentos (parts) de un segmento, unidos en orden byte a byte, forman exactamente el archivo completo del segmento.",
      "Entre segmentos puede haber huecos sin audio (ver audio.gaps). Precisión esperada de las marcas: ±0,5 s.",
      "measured_audio_duration_ms es la duración real del archivo medida al cerrar la sesión; si difiere de duration_ms en más de unos segundos, las marcas de ese segmento son menos fiables hacia el final."
    ],
    photos: valid.map(photoOut),
    deleted_photos: deleted.map(photoOut),
    audio: {
      segments,
      gaps: s.gaps.map((g) => ({ from_elapsed_ms: g.fromMs, to_elapsed_ms: g.toMs, duration_ms: Math.max(0, g.toMs - g.fromMs), reason: g.reason }))
    },
    storage: {
      all_saved: pendingPhotos === 0 && pendingAudio === 0 && s.status === "finished",
      verified_against_drive: !!s.verified,
      pending_photos: pendingPhotos,
      pending_audio_files: pendingAudio
    },
    incidents: s.incidents,
    device: { user_agent: s.userAgent, capture: s.captureInfo || null }
  };
}
function buildSummaryText(s, photos) {
  const valid = photos.filter((p) => p.status !== "deleted");
  const deleted = photos.filter((p) => p.status === "deleted");
  const dur = (s.endEpoch || Date.now()) - s.startEpoch;
  const audioMs = s.segments.reduce((a, g) => a + ((g.endMs ?? g.startMs) - g.startMs), 0);
  const gapMs = s.gaps.reduce((a, g) => a + Math.max(0, g.toMs - g.fromMs), 0);
  const lines = [
    "VINTED WORKFLOW — RESUMEN DE SESIÓN",
    "====================================",
    `Sesión:        ${s.id}`,
    `Carpeta:       ${CONFIG.ROOT_FOLDER_NAME}/${s.folderName}`,
    `Inicio:        ${fmtDateTime(s.startEpoch)} (${s.timezone})`,
    `Fin:           ${s.endEpoch ? fmtDateTime(s.endEpoch) : "—"}`,
    `Duración:      ${fmtDuration(dur)}`,
    `Fotos válidas: ${valid.length}`,
    `Fotos eliminadas: ${deleted.length}`,
    `Audio grabado: ${fmtDuration(audioMs)} en ${s.segments.length} segmento(s)`,
    `Cortes de audio: ${s.gaps.length} (${fmtDuration(gapMs)} sin grabar)`,
    `Estado: ${s.verified ? "Todo guardado y comprobado en Drive" : "Pendiente de comprobar"}`,
    "",
    "LÍNEA TEMPORAL",
    "--------------"
  ];
  const events = [
    ...valid.map((p) => ({ t: p.elapsedMs, txt: `Foto ${p.seq}  ${p.fileName}` })),
    ...s.segments.map((g) => ({ t: g.startMs, txt: `▶ Audio segmento ${g.seg} empieza` })),
    ...s.segments.filter((g) => g.endMs != null).map((g) => ({ t: g.endMs, txt: `■ Audio segmento ${g.seg} termina (${g.endReason})` }))
  ].sort((a, b) => a.t - b.t);
  for (const e of events) lines.push(`${fmtDuration(e.t)}  ${e.txt}`);
  if (s.incidents.length) {
    lines.push("", "INCIDENCIAS", "-----------");
    for (const i of s.incidents) lines.push(`${i.elapsed_ms != null ? fmtDuration(i.elapsed_ms) : "--:--:--"}  ${i.type} ${i.detail}`);
  }
  return lines.join("\n") + "\n";
}
function buildPrendaManifest(s, photos) {
  const valid = photos.filter((p) => p.status !== "deleted").sort((a, b) => (a.order || a.seq) - (b.order || b.seq));
  const audios = s.segments.filter((g) => g.endMs != null && !g.full?.empty).sort((a, b) => (a.order || a.seg) - (b.order || b.seg));
  const base = `${CONFIG.ROOT_FOLDER_NAME}/${s.dayFolder}/${s.folderName}`;
  return {
    schema: "vinted-workflow/prenda@1",
    app_version: CONFIG.APP_VERSION,
    generated_at: isoLocal(Date.now()),
    item: {
      id: s.id,
      number_of_day: s.number,
      tipo: s.tipo === "resubida" ? "resubida" : "nueva",
      tipo_descripcion: s.tipo === "resubida" ? "RESUBIDA: la prenda ya existe en el sistema. Hay que buscar su anuncio anterior, eliminarlo y volver a publicarla." : "NUEVA: la prenda nunca se ha subido. Hay que crearla y añadirla a su lote o bala.",
      folder: base,
      status: s.status === "finished" ? "guardada" : "guardando",
      created_at: isoLocal(s.startEpoch),
      saved_at: s.endEpoch ? isoLocal(s.endEpoch) : null,
      timezone: s.timezone,
      utc_offset_minutes: s.utcOffsetMin,
      google_account: s.accountEmail || null
    },
    notes: [
      "Todas las fotos y todos los audios de esta carpeta pertenecen a UNA sola prenda.",
      "item.tipo indica si la prenda es nueva (crear) o resubida (buscar la anterior, eliminarla y volver a subir). También aparece al final del nombre de la carpeta.",
      "Las fotos se hicieron con la cámara del iPhone; taken_at es la fecha de la foto según sus metadatos (null si no se pudo leer).",
      "Los audios se grabaron después de hacer las fotos: describen la prenda (marca, talla, medidas, defectos, instrucciones)."
    ],
    photos: valid.map((p) => ({
      order: p.order || p.seq,
      file_name: p.fileName,
      drive_path: p.driveId ? `${base}/${p.fileName}` : null,
      drive_file_id: p.driveId || null,
      original_name: p.originalName || null,
      taken_at: p.takenAt ? isoLocal(p.takenAt) : null,
      width: p.width,
      height: p.height,
      bytes: p.size,
      mime_type: p.mime,
      status: p.driveId ? "guardada_en_drive" : "pendiente_de_subir"
    })),
    audio: audios.map((g) => ({
      order: g.order || g.seg,
      file_name: g.fileName,
      drive_path: g.full?.driveId ? `${base}/${g.fileName}` : null,
      drive_file_id: g.full?.driveId || null,
      mime_type: g.mimeType,
      recorded_at: g.recordedAt ? isoLocal(g.recordedAt) : null,
      duration_ms: g.endMs - g.startMs,
      measured_audio_duration_ms: g.measuredMs ?? null,
      bytes: g.full?.size || g.bytes || null,
      end_reason: g.endReason === "usuario" ? "detenido_por_el_usuario" : g.endReason,
      status: g.full?.driveId ? "guardado_en_drive" : "pendiente_de_subir"
    })),
    storage: {
      all_saved: valid.every((p) => p.driveId) && audios.every((g) => g.full?.driveId) && s.status === "finished",
      verified_against_drive: !!s.verified
    },
    incidents: s.incidents,
    device: { user_agent: s.userAgent }
  };
}

// ../vinted-workflow/sync.js
var N = () => CONFIG.AUDIO_CHUNKS_PER_PART;
var p2 = (n) => String(n).padStart(2, "0");
var p4 = (n) => String(n).padStart(4, "0");
var isDone = (s) => s.status === "failed" || s.status === "draft" || s.status === "finished" && (s.verified || s.lossy);
var SyncEngine = class {
  constructor() {
    this.timer = null;
    this.queued = null;
    this.lockP = null;
    this.listeners = /* @__PURE__ */ new Set();
    this.status = { pendingPhotos: 0, pendingAudio: 0, lastError: null, lastOk: null, paused: null, working: null };
    this.manifestThrottle = /* @__PURE__ */ new Map();
    this.foldersChecked = /* @__PURE__ */ new Set();
    this.backoff = /* @__PURE__ */ new Map();
  }
  onStatus(fn) {
    this.listeners.add(fn);
  }
  emit() {
    this.listeners.forEach((fn) => {
      try {
        fn(this.status);
      } catch (e) {
        console.error(e);
      }
    });
  }
  working(txt) {
    this.status.working = txt;
    this.emit();
  }
  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.kick(), CONFIG.SYNC_INTERVAL_MS);
    window.addEventListener("online", () => {
      this.resetBackoff();
      this.kick();
    });
    this.kick();
  }
  /** Olvida las esperas por fallos anteriores (tras entrar con Google, volver la conexión o guardar algo nuevo). */
  resetBackoff() {
    this.backoff.clear();
  }
  /** Ejecuta fn en exclusiva (nunca dos subidas en paralelo → sin duplicados). */
  exclusive(fn) {
    const p = (this.lockP || Promise.resolve()).then(fn);
    this.lockP = p.catch(() => {
    });
    return p;
  }
  /** Programa una ronda de sincronización (como mucho una en cola). */
  kick() {
    if (this.queued) return this.queued;
    this.queued = this.exclusive(async () => {
      this.queued = null;
      await this.runOnce();
    }).catch((e) => log("sync", e));
    return this.queued;
  }
  blockedReason() {
    if (!navigator.onLine) return "Sin conexión: se subirá al volver la cobertura";
    if (!auth.isValid()) return "Subida a Drive en pausa (acceso caducado). Todo se sigue guardando en el móvil";
    return null;
  }
  async runOnce() {
    await this.computePending();
    this.status.paused = this.blockedReason();
    if (this.status.paused) return this.emit();
    let hadError = false;
    for (const s of allSessions()) {
      if (isDone(s)) continue;
      if (this.wrongAccount(s)) {
        this.status.lastError = `La sesión del ${new Date(s.startEpoch).toLocaleDateString()} pertenece a ${s.accountEmail}: entra con esa cuenta para subirla`;
        hadError = true;
        continue;
      }
      const bo = this.backoff.get(s.id);
      if (bo && Date.now() < bo.until) {
        hadError = true;
        continue;
      }
      try {
        if (s.status === "finishing") {
          const r = await this._finalize(s);
          if (!r.ok) throw new DriveError(r.checks.find((c) => !c.ok)?.label || "Guardado incompleto", r.needsLogin ? 401 : r.offline ? 0 : 500);
          this.listeners.forEach((fn) => {
            try {
              fn(this.status, s);
            } catch {
            }
          });
        } else {
          await this.syncSession(s);
        }
        this.status.lastOk = Date.now();
        this.backoff.delete(s.id);
      } catch (e) {
        hadError = true;
        this.status.lastError = e.message;
        log("sync error", e);
        if (e instanceof DriveError && (e.status === 401 || e.status === 0)) break;
        const fails = (bo?.fails || 0) + 1;
        this.backoff.set(s.id, { fails, until: Date.now() + Math.min(12e4, 5e3 * 2 ** fails) });
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
    if (g.noParts) return [];
    return this.completeParts(g).filter((p) => !(g.parts || []).some((x) => x.part === p && (x.driveId || x.empty)));
  }
  async computePending() {
    let pp = 0, pa = 0;
    for (const s of allSessions()) {
      if (isDone(s)) continue;
      pp += validPhotos(await photosOf(s.id)).filter((p) => !p.driveId && !p.lost).length;
      for (const g of s.segments) pa += this.pendingParts(g).length;
      pa += pendingAudioSegments(s).length;
    }
    this.status.pendingPhotos = pp;
    this.status.pendingAudio = pa;
    this.emit();
  }
  /** Crea (o localiza) las carpetas de la sesión. Si alguien las borró o envió a la papelera, las vuelve a crear. */
  async ensureFolders(s, forceCheck = false) {
    const d = s.drive;
    const email = (auth.email || "").toLowerCase();
    if (!s.accountEmail && email) s.accountEmail = email;
    const rootKey = `rootFolderId:${email}`;
    if (forceCheck || !this.foldersChecked.has(s.id)) {
      if (d.rootId && !await drive.folderAlive(d.rootId)) {
        d.rootId = null;
        await db.kvSet(rootKey, null);
      }
      if (d.folderId && !await drive.folderAlive(d.folderId)) {
        addIncident(s, null, "carpeta_de_drive_no_encontrada", "se vuelve a crear y se suben de nuevo los archivos");
        s.drive = { rootId: d.rootId };
      }
      this.foldersChecked.add(s.id);
    }
    const dd = s.drive;
    if (!dd.rootId) {
      dd.rootId = await db.kvGet(rootKey);
      if (dd.rootId && !await drive.folderAlive(dd.rootId)) dd.rootId = null;
      if (!dd.rootId) {
        dd.rootId = await drive.ensureFolder(CONFIG.ROOT_FOLDER_NAME, null, "VW_ROOT");
        await db.kvSet(rootKey, dd.rootId);
      }
    }
    if (s.kind === "prenda") {
      if (!dd.dayId) dd.dayId = await drive.ensureFolder(s.dayFolder, dd.rootId, `VW_DAY_${s.dayFolder}`);
      if (!dd.folderId) dd.folderId = await drive.ensureFolder(s.folderName, dd.dayId, `${s.id}_DIR`);
      dd.fotosId = dd.audioId = dd.folderId;
      await saveSession(s);
      return;
    }
    if (!dd.folderId) dd.folderId = await drive.ensureFolder(s.folderName, dd.rootId, `${s.id}_DIR`);
    if (!dd.fotosId) dd.fotosId = await drive.ensureFolder("FOTOS", dd.folderId, `${s.id}_FOTOS`);
    if (!dd.audioId) dd.audioId = await drive.ensureFolder("AUDIO", dd.folderId, `${s.id}_AUDIO`);
    if (!dd.partsId) dd.partsId = await drive.ensureFolder("fragmentos", dd.audioId, `${s.id}_PARTS`);
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
    for (const p of await photosOf(s.id)) {
      if (p.status === "deleted") {
        if (p.driveId && !p.movedToDeleted) {
          if (!s.drive.deletedId) {
            s.drive.deletedId = await drive.ensureFolder("_ELIMINADAS", s.drive.fotosId, `${s.id}_DEL`);
            await saveSession(s);
          }
          try {
            await drive.move(p.driveId, s.drive.deletedId, s.drive.fotosId);
          } catch (e) {
            if (e.status !== 404) throw e;
          }
          await updatePhoto(p.id, (x) => {
            x.movedToDeleted = true;
          });
          s.manifestDirty = true;
        }
        continue;
      }
      if (p.driveId || p.lost) continue;
      const rec = await db.get("blobs", p.id);
      if (!rec?.blob) {
        await updatePhoto(p.id, (x) => {
          x.lost = true;
        });
        addIncident(s, null, "foto_sin_copia_local", p.fileName);
        continue;
      }
      this.working(`Subiendo foto ${p.seq}…`);
      const r = await drive.upload({
        blob: rec.blob,
        name: p.fileName,
        parentId: s.drive.fotosId,
        mimeType: p.mime,
        vwId: p.id,
        props: { sessionId: s.id, elapsedMs: String(p.elapsedMs) }
      });
      const saved = await updatePhoto(p.id, (x) => {
        x.driveId = r.id;
        x.driveSize = r.size;
      });
      s.manifestDirty = true;
      if (saved?.status === "deleted") this.kickSoon = true;
    }
    for (const g of s.segments) {
      g.parts = g.parts || [];
      for (const part of this.pendingParts(g)) {
        const from = part * N(), to = Math.min((part + 1) * N(), g.chunkCount) - 1;
        const chunks = await db.chunksRange(s.id, g.seg, from, to);
        g.parts = g.parts.filter((x) => x.part !== part);
        if (!chunks.length) {
          addIncident(s, null, "fragmento_de_audio_sin_copia_local", `segmento ${g.seg}, fragmento ${part + 1}`);
          g.parts.push({ part, fromSeq: from, toSeq: to, empty: true });
        } else {
          if (chunks.length !== to - from + 1) addIncident(s, null, "fragmento_de_audio_incompleto", `segmento ${g.seg}, fragmento ${part + 1}: ${chunks.length}/${to - from + 1} trozos`);
          const blob = new Blob(chunks.map((c) => c.blob), { type: g.mimeType });
          const fileName = `seg${p2(g.seg)}_parte${p4(part + 1)}_t${fmtStamp(chunks[0].startMs)}.${extFor(g.mimeType)}`;
          this.working(`Subiendo audio (minuto ${Math.floor(chunks[0].startMs / 6e4)})…`);
          const r = await drive.upload({
            blob,
            name: fileName,
            parentId: s.drive.partsId,
            mimeType: g.mimeType.split(";")[0],
            vwId: `${s.id}_S${g.seg}_P${part}`
          });
          g.parts.push({
            part,
            fromSeq: from,
            toSeq: to,
            startMs: chunks[0].startMs,
            endMs: chunks[chunks.length - 1].endMs,
            size: blob.size,
            fileName,
            driveId: r.id,
            driveSize: r.size
          });
        }
        g.parts.sort((a, b) => a.part - b.part);
        s.manifestDirty = true;
        await saveSession(s);
      }
      if (g.endMs != null && !g.full?.driveId && !g.full?.empty) {
        const chunks = g.chunkCount > 0 ? await db.chunksRange(s.id, g.seg, 0, g.chunkCount - 1) : [];
        if (!chunks.length) {
          g.full = { empty: true };
        } else {
          if (chunks.length !== g.chunkCount) addIncident(s, null, "audio_completo_con_trozos_perdidos", `segmento ${g.seg}: ${chunks.length}/${g.chunkCount}`);
          const blob = new Blob(chunks.map((c) => c.blob), { type: g.mimeType });
          if (g.measuredMs == null) {
            const m = await measureAudioDurationMs(blob);
            if (m != null) g.measuredMs = m;
          }
          const fileName = g.fileName || `audio_seg${p2(g.seg)}_completo_t${fmtStamp(g.startMs)}.${extFor(g.mimeType)}`;
          this.working(`Subiendo audio completo del segmento ${g.seg}…`);
          const r = await drive.upload({ blob, name: fileName, parentId: s.drive.audioId, mimeType: g.mimeType.split(";")[0], vwId: `${s.id}_S${g.seg}_FULL` });
          g.full = { fileName, driveId: r.id, size: blob.size, driveSize: r.size, chunks: chunks.length };
        }
        s.manifestDirty = true;
        await saveSession(s);
      }
    }
    const last = this.manifestThrottle.get(s.id) || 0;
    if (s.manifestDirty && (s.status !== "active" || Date.now() - last > 6e4)) {
      await this.writeManifest(s);
      this.manifestThrottle.set(s.id, Date.now());
    }
    if (this.kickSoon) {
      this.kickSoon = false;
      setTimeout(() => this.kick(), 200);
    }
  }
  async writeManifest(s) {
    const photos = await photosOf(s.id);
    s.manifestDirty = false;
    const data = s.kind === "prenda" ? buildPrendaManifest(s, photos) : buildManifest(s, photos);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    try {
      if (s.drive.manifestId) {
        try {
          await drive.updateContent(s.drive.manifestId, blob, "application/json");
        } catch (e) {
          if (e.status !== 404) throw e;
          s.drive.manifestId = null;
        }
      }
      if (!s.drive.manifestId) s.drive.manifestId = (await drive.upload({ blob, name: "manifest.json", parentId: s.drive.folderId, mimeType: "application/json", vwId: `${s.id}_MANIFEST` })).id;
      await saveSession(s);
    } catch (e) {
      s.manifestDirty = true;
      throw e;
    }
  }
  /**
   * Cierre de una sesión terminada: sube todo, comprueba en Drive y genera el resumen.
   * Devuelve { ok, needsLogin, offline, checks:[{ok, warn, label, detail}] }.
   */
  finalize(s) {
    return this.exclusive(() => this._finalize(s)).finally(() => {
      this.status.working = null;
      this.computePending();
    });
  }
  async _finalize(s) {
    const report = { ok: false, checks: [] };
    const add = (ok, label, detail = "", warn = false) => report.checks.push({ ok, label, detail, warn });
    if (!navigator.onLine) {
      report.offline = true;
      add(false, "Sin conexión a Internet", "Todo sigue guardado en el móvil. Se reintentará solo al volver la cobertura.");
      return report;
    }
    if (!auth.isValid()) {
      report.needsLogin = true;
      add(false, "Hay que volver a conectar con Google", "El acceso dura 1 hora por seguridad. No se ha perdido nada: pulsa el botón para subir lo que falta.");
      return report;
    }
    if (this.wrongAccount(s)) {
      report.needsLogin = true;
      add(false, "Cuenta de Google distinta", `Esta sesión empezó a guardarse en ${s.accountEmail}. Entra con esa cuenta.`);
      return report;
    }
    let photos, valid, missing = [], audioBad = [], lost = [];
    try {
      for (let pass = 1; pass <= 2; pass++) {
        await this.syncSession(s, { forceCheck: true });
        this.working("Comprobando archivos en Drive…");
        photos = await photosOf(s.id);
        valid = validPhotos(photos);
        missing = [];
        audioBad = [];
        lost = valid.filter((p) => p.lost);
        let healed = 0;
        for (const p of valid) {
          if (p.lost) continue;
          const local = (await db.get("blobs", p.id))?.blob;
          if (await verifyFile(p.driveId, local?.size ?? p.size)) continue;
          missing.push(p.fileName);
          if (local) {
            await updatePhoto(p.id, (x) => {
              x.driveId = null;
            });
            healed++;
          } else {
            await updatePhoto(p.id, (x) => {
              x.lost = true;
            });
            lost.push(p);
          }
        }
        for (const g of s.segments) {
          if (g.full?.empty) continue;
          if (!await verifyFile(g.full?.driveId, g.full?.size)) {
            audioBad.push(`segmento ${g.seg} (completo)`);
            if (g.full) g.full.driveId = null;
            healed++;
          }
          for (const pt of g.parts || []) {
            if (pt.empty) continue;
            if (!await verifyFile(pt.driveId, pt.size)) {
              audioBad.push(`segmento ${g.seg}, fragmento ${pt.part + 1}`);
              pt.driveId = null;
              healed++;
            }
          }
        }
        await saveSession(s);
        if (!healed) break;
        if (pass === 1) addIncident(s, null, "archivos_resubidos_tras_comprobacion", `${missing.length} foto(s), ${audioBad.length} audio(s)`);
      }
    } catch (e) {
      if (e.status === 401) report.needsLogin = true;
      if (e.status === 0) report.offline = true;
      add(false, "Subida a Drive interrumpida", (e.message || e) + ". No se ha perdido nada; se puede reintentar.");
      await saveSession(s);
      return report;
    }
    const okPhotos = valid.length - missing.length - lost.filter((p) => !missing.includes(p.fileName)).length;
    add(
      missing.length === 0 && lost.length === 0,
      `Fotos válidas en Drive: ${okPhotos}/${valid.length}`,
      [missing.length ? "Faltan: " + missing.join(", ") : "", lost.length ? `Sin copia local (no recuperables): ${lost.map((p) => p.fileName).join(", ")}` : ""].filter(Boolean).join(" · ")
    );
    const audioDetail = [], durWarn = [];
    for (const g of s.segments) {
      if (g.full?.empty) {
        audioDetail.push(`Segmento ${g.seg}: sin datos (cortado al instante)`);
        continue;
      }
      const wall = g.endMs - g.startMs;
      let line = s.kind === "prenda" ? `${g.fileName || "audio"}: ${fmtDuration(wall)}` : `Segmento ${g.seg}: ${fmtDuration(wall)}, ${(g.parts || []).filter((x) => x.driveId).length} fragmento(s)`;
      if (g.measuredMs != null) {
        const diff = g.measuredMs - wall;
        line += `, duración real ${fmtDuration(g.measuredMs)}`;
        if (Math.abs(diff) > Math.max(4e3, wall * 0.01)) durWarn.push(`Segmento ${g.seg}: el archivo dura ${fmtDuration(g.measuredMs)} pero se grabó durante ${fmtDuration(wall)} (${diff > 0 ? "+" : "−"}${Math.round(Math.abs(diff) / 1e3)} s)`);
      }
      audioDetail.push(line);
    }
    const audioOk = audioBad.length === 0;
    add(audioOk, `Audio en Drive: ${s.segments.filter((g) => !g.full?.empty).length} archivo(s) completo(s)`, audioOk ? audioDetail.join(" · ") : "Faltan: " + audioBad.join(", "));
    if (durWarn.length) add(true, "Aviso: la duración del audio no coincide con el tiempo grabado", durWarn.join(" · ") + ". Los archivos están guardados, pero avísame: puede ser un fallo de grabación de iOS.", true);
    else if (s.segments.some((g) => g.measuredMs != null)) add(true, "Duración real del audio comprobada", "");
    if (s.gaps.length) add(true, `Cortes de audio durante la sesión: ${s.gaps.length}`, s.gaps.map((g) => `${fmtDuration(g.fromMs)} → ${fmtDuration(g.toMs)} (${g.reason})`).join(" · "), s.gaps.some((g) => g.toMs - g.fromMs > 3e3));
    const allUploaded = missing.length === 0 && audioOk;
    if (allUploaded) {
      s.status = "finished";
      s.verified = lost.length === 0;
      s.lossy = lost.length > 0;
    }
    s.manifestDirty = true;
    try {
      await this.writeManifest(s);
      const prenda2 = s.kind === "prenda";
      if (!prenda2) {
        const txt = new Blob([buildSummaryText(s, photos)], { type: "text/plain" });
        if (s.drive.summaryId) {
          try {
            await drive.updateContent(s.drive.summaryId, txt, "text/plain");
          } catch (e) {
            if (e.status !== 404) throw e;
            s.drive.summaryId = null;
          }
        }
        if (!s.drive.summaryId) s.drive.summaryId = (await drive.upload({ blob: txt, name: "resumen_sesion.txt", parentId: s.drive.folderId, mimeType: "text/plain", vwId: `${s.id}_SUMMARY` })).id;
      }
      const mOk = await verifyFile(s.drive.manifestId) && (prenda2 || await verifyFile(s.drive.summaryId));
      add(mOk, prenda2 ? "Ficha de la prenda (manifest.json)" : "Manifiesto (manifest.json) y resumen_sesion.txt", "");
      if (!mOk) {
        s.status = "finishing";
        s.verified = false;
        s.lossy = false;
        s.drive.manifestId = null;
        s.drive.summaryId = null;
      }
    } catch (e) {
      s.status = "finishing";
      s.verified = false;
      s.lossy = false;
      add(false, "Manifiesto", e.message);
    }
    await saveSession(s);
    report.ok = s.status === "finished";
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
        if (!navigator.onLine) throw new Error("Sin conexión: no se puede eliminar la carpeta de Drive ahora.");
        if (!auth.isValid()) throw new DriveError("Hay que entrar con Google para eliminar la carpeta de Drive.", 401);
        if (this.wrongAccount(s)) throw new Error(`Esta sesión está en la cuenta ${s.accountEmail}. Entra con ella para eliminarla.`);
        try {
          await drive.trashSessionFolder(s.drive.folderId, s.id);
        } catch (e) {
          if (e.status !== 404) throw e;
        }
      }
      for (const p of await photosOf(s.id)) {
        await db.del("blobs", p.id);
        await db.del("thumbs", p.id);
        await db.del("photos", p.id);
      }
      for (const g of s.segments) await db.delChunks(s.id, g.seg);
      this.backoff.delete(s.id);
      await forgetSession(s.id);
      this.foldersChecked.delete(s.id);
      await this.computePending();
    });
  }
};
async function verifyFile(id, expectedSize) {
  if (!id) return false;
  try {
    const f = await drive.getFile(id, "id,size,trashed");
    if (f.trashed) return false;
    if (expectedSize != null && Number(f.size) !== Number(expectedSize)) return false;
    return true;
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}
async function freeLocalSpace(s, photos) {
  for (const p of photos) {
    if (p.driveId || p.status === "deleted" || p.lost) await db.del("blobs", p.id);
  }
  for (const g of s.segments) await db.delChunks(s.id, g.seg);
  s.localFreed = true;
  await saveSession(s);
}
var sync = new SyncEngine();

// ../vinted-workflow/session.js
function newSessionRecord(startEpoch) {
  const d = new Date(startEpoch);
  return {
    id: `S${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${randomId(4)}`,
    folderName: folderNameFor(startEpoch),
    startEpoch,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "desconocida",
    utcOffsetMin: -d.getTimezoneOffset(),
    endEpoch: null,
    status: "active",
    photoSeq: 0,
    segments: [],
    gaps: [],
    incidents: [],
    drive: {},
    heartbeatMs: 0,
    manifestDirty: true,
    verified: false,
    appVersion: CONFIG.APP_VERSION,
    userAgent: navigator.userAgent
  };
}
async function reconcileOrphan(s, reason = "cierre_inesperado") {
  let changed = false;
  for (const g of s.segments) {
    if (g.endMs != null) continue;
    const last = await db.lastChunk(s.id, g.seg);
    if (last) {
      g.chunkCount = last.seq + 1;
      g.lastEndMs = last.endMs;
    }
    g.nextSeq = g.chunkCount || 0;
    g.endMs = g.lastEndMs ?? g.startMs;
    g.endReason = reason;
    changed = true;
  }
  const maxSeq = (await photosOf(s.id)).reduce((m, p) => Math.max(m, p.seq), 0);
  if (maxSeq > (s.photoSeq || 0)) {
    s.photoSeq = maxSeq;
    changed = true;
  }
  if (changed) {
    addIncident(s, s.heartbeatMs, "sesion_interrumpida", "la página se cerró o se recargó durante la grabación");
    await saveSession(s);
  }
  return changed;
}
var SessionController = class {
  constructor(videoEl, ui2) {
    this.video = videoEl;
    this.ui = ui2;
    this.opts = { photoMode: "auto", quality: "high", deviceId: "", audioFormat: "auto" };
    this.reset();
    this._onVis = () => this.onVisibility();
    this._onUnload = (e) => {
      if (this.active) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    this._onHide = () => {
      if (this.s && this.clock) {
        this.s.heartbeatMs = this.clock.elapsed();
        saveSession(this.s);
      }
    };
  }
  reset() {
    this.s = null;
    this.clock = null;
    this.capture = null;
    this.recorder = null;
    this.meter = null;
    this.seg = null;
    this.chunkQ = Promise.resolve();
    this.photoQ = Promise.resolve();
    this.segQ = Promise.resolve();
    this.interrupting = false;
    this.recovering = false;
    this.previewBlocked = false;
    this.audioMuted = false;
    this.muteTimers = {};
    this.lastVisibleAt = performance.now();
    this.lastReason = "";
  }
  get active() {
    return !!this.s && this.s.status === "active";
  }
  get elapsed() {
    return this.clock ? this.clock.elapsed() : 0;
  }
  /** true si ahora mismo se puede hacer una foto */
  get canShoot() {
    return this.active && !this.interrupting && !!this.capture?.stream;
  }
  /** Encadena operaciones sobre segmentos para que nunca se solapen. */
  serial(fn) {
    const p = this.segQ.then(fn);
    this.segQ = p.catch((e) => log("segQ", e));
    return p;
  }
  // ---------- Inicio / reanudación ----------
  async startNew(opts) {
    this.reset();
    Object.assign(this.opts, opts);
    const s = newSessionRecord(Date.now());
    this.s = s;
    this.clock = new SessionClock(s.startEpoch);
    await saveSession(s);
    try {
      await this.startCapture("inicio");
    } catch (e) {
      addIncident(s, this.clock, "error_al_iniciar", e?.message || e);
      s.status = "failed";
      s.endEpoch = Date.now();
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
    this.s = s;
    this.clock = new SessionClock(s.startEpoch);
    try {
      await this.startCapture("reanudacion");
    } catch (e) {
      addIncident(s, this.clock, "error_al_reanudar", e?.message || e);
      await saveSession(s);
      this.teardown();
      throw e;
    }
    s.status = "active";
    addIncident(s, this.clock, "sesion_reanudada");
    await saveSession(s);
    this.attachListeners();
    sync.kick();
    return s;
  }
  /** Para todo lo que esté en marcha y suelta la sesión (sin cambiar su estado). */
  teardown() {
    this.teardownListeners();
    this.meter?.stop();
    this.meter = null;
    try {
      if (this.recorder?.state !== "inactive") this.recorder?.rec?.stop();
    } catch {
    }
    this.recorder = null;
    this.capture?.stop();
    this.capture = null;
    this.releaseWakeLock();
    this.s = null;
  }
  attachListeners() {
    document.addEventListener("visibilitychange", this._onVis);
    window.addEventListener("beforeunload", this._onUnload);
    window.addEventListener("pagehide", this._onHide);
    clearInterval(this.hb);
    this.hb = setInterval(() => {
      if (!this.s) return;
      this.s.heartbeatMs = this.clock.elapsed();
      saveSession(this.s);
    }, 5e3);
    clearInterval(this.tick);
    this.tick = setInterval(() => {
      this.ui.onTick?.(this.clock.elapsed());
      this.watchdog();
    }, 500);
  }
  teardownListeners() {
    document.removeEventListener("visibilitychange", this._onVis);
    window.removeEventListener("beforeunload", this._onUnload);
    window.removeEventListener("pagehide", this._onHide);
    clearInterval(this.hb);
    clearInterval(this.tick);
    Object.values(this.muteTimers).forEach(clearTimeout);
  }
  /** Arranca cámara + micrófono y abre un segmento de audio nuevo. */
  async startCapture(reason) {
    const s = this.s;
    const cap = new Capture(this.video, {
      photoMode: this.opts.photoMode,
      quality: this.opts.quality,
      deviceId: this.opts.deviceId,
      onTrackEvent: (k, ev) => {
        if (this.capture === cap) this.onTrackEvent(k, ev);
      }
    });
    await cap.start();
    if (this.s !== s || s.status !== "active") {
      cap.stop();
      throw new Error("La sesión ya había terminado");
    }
    this.capture = cap;
    this.audioMuted = !!cap.audioTrack.muted;
    this.previewBlocked = false;
    s.captureInfo = cap.info();
    addIncident(s, this.clock, "captura_iniciada", `${reason}; fotos=${s.captureInfo.mode} ${s.captureInfo.width}x${s.captureInfo.height}; cámara=${s.captureInfo.camera || "?"}`);
    try {
      this.openSegment(reason);
    } catch (e) {
      cap.stop();
      this.capture = null;
      throw new Error("No se pudo iniciar la grabación de audio: " + (e?.message || e));
    }
    await saveSession(s);
    this.meter?.stop();
    this.meter = new LevelMeter(cap.audioTrack, (lvl) => this.ui.onLevel?.(lvl));
    this.acquireWakeLock();
    this.ui.onCamera?.({ zoom: cap.zoomLabel, torch: cap.hasTorch, torchOn: false, info: s.captureInfo });
  }
  /** Abre un segmento de audio sobre la pista de micrófono actual. */
  openSegment(reason) {
    const s = this.s;
    const prev = s.segments[s.segments.length - 1];
    const g = { seg: (prev?.seg || 0) + 1, startMs: this.clock.elapsed(), endMs: null, endReason: null, chunkCount: 0, nextSeq: 0, parts: [], mimeType: null, openReason: reason };
    const recorder = new SegmentRecorder(this.capture.audioTrack, {
      clock: this.clock,
      prefer: this.opts.audioFormat,
      onChunk: (blob, start, end) => this.onChunk(s, g, blob, start, end),
      onError: (msg) => {
        addIncident(s, this.clock, "error_grabador", msg);
        this.interrupt("Error del grabador de audio");
      }
    });
    g.mimeType = recorder.start();
    if (prev) {
      g.gapIndex = s.gaps.length;
      s.gaps.push({ fromMs: prev.endMs ?? prev.lastEndMs ?? prev.startMs, toMs: g.startMs, reason: prev.endReason || reason });
    }
    s.segments.push(g);
    s.manifestDirty = true;
    this.seg = g;
    this.recorder = recorder;
    log("segmento abierto", g.seg, reason, g.mimeType);
  }
  /** Guarda un trozo de audio en el móvil. s y g quedan fijados al crear el grabador (no dependen de la sesión actual). */
  onChunk(s, g, blob, startMs, endMs) {
    const seq = g.nextSeq++;
    this.chunkQ = this.chunkQ.then(async () => {
      await db.put("chunks", { sessionId: s.id, seg: g.seg, seq, blob, startMs, endMs, size: blob.size });
      if (seq === 0) {
        g.startMs = startMs;
        if (g.gapIndex != null && s.gaps[g.gapIndex]) s.gaps[g.gapIndex].toMs = startMs;
      }
      g.chunkCount = seq + 1;
      g.lastEndMs = endMs;
      if (g.endMs != null) {
        g.endMs = endMs;
        s.manifestDirty = true;
      }
      g.bytes = (g.bytes || 0) + blob.size;
      await saveSession(s);
    }).catch((e) => {
      addIncident(s, this.clock, "error_guardando_audio", e?.message || e);
      this.ui.onWarn?.("No se pudo guardar audio en el móvil (¿sin espacio?). Termina la sesión para no perder más.");
    });
    if ((seq + 1) % CONFIG.AUDIO_CHUNKS_PER_PART === 0) this.chunkQ.then(() => sync.kick());
  }
  async closeSegment(reason) {
    const g = this.seg;
    if (!g || g.endMs != null) return;
    const rec = this.recorder;
    this.recorder = null;
    this.seg = null;
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
      if (a && a.readyState === "live" && !a.muted) {
        try {
          this.openSegment(reason);
          await saveSession(this.s);
        } catch (e) {
          addIncident(this.s, this.clock, "error_grabador", e?.message || e);
          this.interrupt("No se pudo reabrir la grabación");
        }
      }
    });
  }
  async acquireWakeLock() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
    } catch (e) {
      if (!this.wakeWarned) {
        this.wakeWarned = true;
        if (this.s) addIncident(this.s, this.clock, "pantalla_activa_no_disponible", e?.message || e);
      }
    }
  }
  releaseWakeLock() {
    try {
      this.wakeLock?.release();
    } catch {
    }
    this.wakeLock = null;
  }
  /** Llamar dentro de cualquier toque: reactiva el medidor de nivel y la vista previa si iOS los pausó. */
  nudge() {
    this.meter?.nudge();
    if (this.capture?.stream && this.video.paused) this.capture.ensurePlaying();
  }
  // ---------- Fotos ----------
  takePhoto() {
    const s = this.s;
    if (!this.canShoot) return Promise.reject(new Error("La cámara no está activa"));
    const elapsedMs = this.clock.elapsed();
    const wallEpoch = Date.now();
    const seq = ++s.photoSeq;
    const run = async () => {
      if (!this.capture?.stream) throw new Error("La cámara se interrumpió antes de capturar");
      const shot = await this.capture.takePhoto();
      const mime = shot.blob.type || "image/jpeg";
      const id = `${s.id}_F${pad(seq, 4)}`;
      const thumb = await makeThumb(shot.blob);
      const photo = {
        id,
        sessionId: s.id,
        seq,
        elapsedMs,
        epoch: s.startEpoch + elapsedMs,
        wallEpoch,
        fileName: `foto_${pad(seq, 4)}_t${fmtStamp(elapsedMs)}.${extFor(mime)}`,
        mime,
        size: shot.blob.size,
        width: shot.width,
        height: shot.height,
        method: shot.method,
        status: "pending",
        driveId: null
      };
      await db.put("blobs", { id, blob: shot.blob });
      if (thumb) await db.put("thumbs", { id, blob: thumb });
      await db.put("photos", photo);
      s.manifestDirty = true;
      await saveSession(s);
      this.ui.onPhoto?.(photo, thumb);
      sync.kick();
      return photo;
    };
    const p = this.photoQ.then(run);
    this.photoQ = p.catch((e) => {
      addIncident(s, this.clock, "error_foto", `foto ${seq}: ${e?.message || e}`);
      saveSession(s);
    });
    return p;
  }
  async deletePhoto(photo) {
    const saved = await updatePhoto(photo.id, (x) => {
      x.status = "deleted";
      x.deletedAt = Date.now();
    });
    if (this.s) {
      this.s.manifestDirty = true;
      addIncident(this.s, this.clock, "foto_eliminada", photo.fileName);
      await saveSession(this.s);
    }
    sync.kick();
    return saved;
  }
  async cycleZoom() {
    return this.capture ? this.capture.cycleZoom() : null;
  }
  async toggleTorch() {
    return this.capture ? this.capture.toggleTorch() : false;
  }
  // ---------- Interrupciones ----------
  onTrackEvent(kind, ev) {
    if (!this.active) return;
    addIncident(this.s, this.clock, `pista_${kind}_${ev}`);
    if (this.interrupting) return;
    if (ev === "ended") return this.interrupt(kind === "audio" ? "iOS ha cortado el micrófono" : "iOS ha cortado la cámara");
    if (kind === "audio" && ev === "mute") {
      this.audioMuted = true;
      clearTimeout(this.muteTimers.audioRotate);
      clearTimeout(this.muteTimers.audio);
      this.muteTimers.audioRotate = setTimeout(() => {
        if (this.capture?.audioTrack?.muted) this.serial(() => this.closeSegment("microfono_silenciado_por_ios"));
      }, 600);
      this.muteTimers.audio = setTimeout(() => {
        if (this.capture?.audioTrack?.muted && document.visibilityState === "visible") this.interrupt("El micrófono se ha silenciado");
      }, 4e3);
    }
    if (kind === "audio" && ev === "unmute") {
      this.audioMuted = false;
      clearTimeout(this.muteTimers.audioRotate);
      clearTimeout(this.muteTimers.audio);
      this.serial(async () => {
        if (!this.active || this.interrupting || this.seg) return;
        try {
          this.openSegment("microfono_reactivado");
          await saveSession(this.s);
        } catch (e) {
          this.interrupt("No se pudo reabrir la grabación");
        }
      });
    }
    if (kind === "video" && ev === "mute") {
      clearTimeout(this.muteTimers.video);
      this.muteTimers.video = setTimeout(() => {
        if (this.capture?.videoTrack?.muted && document.visibilityState === "visible") this.interrupt("La cámara se ha pausado");
      }, 3e3);
    }
    if (kind === "video" && ev === "unmute") clearTimeout(this.muteTimers.video);
  }
  onVisibility() {
    if (!this.active) return;
    const vis = document.visibilityState;
    addIncident(this.s, this.clock, vis === "visible" ? "app_visible" : "app_en_segundo_plano");
    if (vis !== "visible") {
      this.s.heartbeatMs = this.clock.elapsed();
      saveSession(this.s);
      return;
    }
    this.lastVisibleAt = performance.now();
    this.acquireWakeLock();
    const drift = this.clock.resyncIfDrifted();
    if (drift) {
      addIncident(this.s, this.clock, "reloj_reanclado", `${Math.round(drift)} ms de desfase tras volver a la app`);
      if (!this.interrupting) this.rotateSegment("pagina_congelada_por_ios");
    }
    setTimeout(() => this.healthCheck(), 2e3);
  }
  async healthCheck() {
    if (!this.active || document.visibilityState !== "visible") return;
    if (this.interrupting) return this.tryAutoRecover();
    await this.segQ;
    if (!this.active || this.interrupting) return;
    const h = this.capture?.healthy() || {};
    if (!h.audio || !h.video) {
      return this.interrupt(`Al volver a la app: micrófono ${h.audio ? "ok" : "parado"}, cámara ${h.video ? "ok" : "parada"}`);
    }
    if (!this.seg || this.recorder?.state !== "recording") {
      addIncident(this.s, this.clock, "grabador_parado_al_volver");
      await this.rotateSegment("grabador_parado");
    }
    if (!await this.capture.ensurePlaying()) {
      this.previewBlocked = true;
      this.ui.onInterrupted?.("La imagen de la cámara está en pausa. El audio sigue grabando", true);
    }
  }
  /** Detecta un grabador que ha dejado de entregar audio sin avisar. */
  watchdog() {
    if (!this.active || this.interrupting || this.recovering || this.audioMuted) return;
    if (document.visibilityState !== "visible" || performance.now() - this.lastVisibleAt < 8e3) return;
    if (this.recorder && this.recorder.silenceMs > CONFIG.AUDIO_WATCHDOG_MS) {
      addIncident(this.s, this.clock, "grabador_sin_datos", `${Math.round(this.recorder.silenceMs / 1e3)} s sin recibir audio`);
      this.interrupt("El grabador de audio se había parado");
    }
  }
  interrupt(reason) {
    if (this.interrupting || !this.active) return Promise.resolve();
    this.interrupting = true;
    this.lastReason = reason;
    addIncident(this.s, this.clock, "interrupcion", reason);
    return this.serial(async () => {
      this.meter?.stop();
      this.meter = null;
      await this.closeSegment("interrupcion");
      this.capture?.stop();
      this.capture = null;
      this.releaseWakeLock();
      sync.kick();
      if (this.active && document.visibilityState === "visible") await this.tryAutoRecover();
    });
  }
  /** Intenta reanudar solo. Si iOS exige un toque, muestra el botón REANUDAR GRABACIÓN. */
  async tryAutoRecover() {
    if (this.recovering || !this.interrupting || !this.active) return;
    this.recovering = true;
    try {
      await this.startCapture("reanudacion_automatica");
      this.interrupting = false;
      await sleep(600);
      if (this.capture && !this.capture.previewPlaying && !await this.capture.ensurePlaying()) {
        this.previewBlocked = true;
        this.ui.onInterrupted?.("El audio ya vuelve a grabarse, pero la cámara necesita un toque para reactivarse", true);
      } else {
        this.ui.onRecovered?.("Grabación reanudada. El corte queda anotado.");
      }
    } catch (e) {
      if (this.active) {
        addIncident(this.s, this.clock, "reanudacion_automatica_fallida", e?.message || e);
        this.ui.onInterrupted?.(this.lastReason || "Grabación interrumpida", false);
      }
    } finally {
      this.recovering = false;
    }
  }
  /** Reanudación manual (desde el botón): cuenta como gesto del usuario. */
  async recoverManual() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      if (!this.interrupting && this.capture?.healthy().audio && this.capture.healthy().video) {
        if (await this.capture.ensurePlaying()) {
          this.previewBlocked = false;
          this.ui.onRecovered?.("Cámara reactivada.");
          return;
        }
      }
      this.interrupting = true;
      await this.serial(async () => {
        this.meter?.stop();
        this.meter = null;
        await this.closeSegment("reinicio_manual");
        this.capture?.stop();
        this.capture = null;
      });
      await this.startCapture("reanudacion_manual");
      this.interrupting = false;
      this.previewBlocked = false;
      this.ui.onRecovered?.("Grabación reanudada. El corte queda anotado.");
    } finally {
      this.recovering = false;
    }
  }
  // ---------- Fin ----------
  async finish() {
    const s = this.s;
    if (!s) return null;
    this.teardownListeners();
    s.status = "finishing";
    await Promise.race([Promise.all([this.photoQ, this.segQ]), sleep(6e3)]);
    await this.closeSegment("fin");
    this.meter?.stop();
    this.meter = null;
    this.capture?.stop();
    this.capture = null;
    this.releaseWakeLock();
    await this.chunkQ;
    s.endEpoch = s.startEpoch + this.clock.elapsed();
    s.heartbeatMs = this.clock.elapsed();
    addIncident(s, this.clock, "sesion_terminada");
    s.manifestDirty = true;
    await saveSession(s);
    this.s = null;
    return s;
  }
  async photos() {
    return this.s ? photosOf(this.s.id) : [];
  }
};
async function finishOrphan(s) {
  await reconcileOrphan(s);
  const lastMs = Math.max(s.heartbeatMs || 0, ...s.segments.map((g) => g.endMs || 0), ...(await photosOf(s.id)).map((p) => p.elapsedMs || 0));
  s.endEpoch = s.startEpoch + lastMs;
  s.status = "finishing";
  addIncident(s, lastMs, "sesion_terminada_sin_reanudar");
  s.manifestDirty = true;
  await saveSession(s);
  return s;
}

// ../vinted-workflow/prenda.js
var dayOf = (epoch) => {
  const d = new Date(epoch);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
var TIPOS = ["nueva", "resubida"];
function newPrendaRecord(tipo = "nueva") {
  const now = Date.now(), d = new Date(now);
  return {
    id: `P${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${randomId(4)}`,
    kind: "prenda",
    tipo: TIPOS.includes(tipo) ? tipo : "nueva",
    status: "draft",
    startEpoch: now,
    endEpoch: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "desconocida",
    utcOffsetMin: -d.getTimezoneOffset(),
    dayFolder: null,
    folderName: null,
    number: null,
    // se asignan al guardar
    photoSeq: 0,
    segSeq: 0,
    segments: [],
    gaps: [],
    incidents: [],
    drive: {},
    heartbeatMs: 0,
    manifestDirty: true,
    verified: false,
    appVersion: CONFIG.APP_VERSION,
    userAgent: navigator.userAgent
  };
}
var currentDraft = () => allSessions().find((s) => s.kind === "prenda" && s.status === "draft") || null;
function orderPhotos(list) {
  const all = list.every((p) => p.takenAt);
  return [...list].sort((a, b) => all ? a.takenAt - b.takenAt || a.seq - b.seq : a.seq - b.seq);
}
async function exifDate(blob) {
  try {
    const buf = new DataView(await blob.slice(0, 256 * 1024).arrayBuffer());
    if (buf.getUint16(0) !== 65496) return null;
    let off = 2;
    while (off + 4 < buf.byteLength) {
      const marker = buf.getUint16(off), size = buf.getUint16(off + 2);
      if (marker === 65505 && buf.getUint32(off + 4) === 1165519206) return parseExif(buf, off + 10);
      if ((marker & 65280) !== 65280 || marker === 65498) break;
      off += 2 + size;
    }
  } catch {
  }
  return null;
}
function parseExif(v, tiff) {
  const le = v.getUint16(tiff) === 18761;
  const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
  const str = (o, n) => {
    let s = "";
    for (let i = 0; i < n && o + i < v.byteLength; i++) {
      const c = v.getUint8(o + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const readIfd = (o, wanted) => {
    const out = {};
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12, tag = u16(e);
      if (!wanted.includes(tag)) continue;
      const type = u16(e + 2), count = u32(e + 4);
      if (type === 2) out[tag] = str(count > 4 ? tiff + u32(e + 8) : e + 8, count);
      else out[tag] = u32(e + 8);
    }
    return out;
  };
  const ifd0 = readIfd(tiff + u32(tiff + 4), [34665, 306]);
  let text = ifd0[306], sub = "";
  if (ifd0[34665]) {
    const ex = readIfd(tiff + ifd0[34665], [36867, 37521]);
    if (ex[36867]) text = ex[36867];
    if (ex[37521]) sub = ex[37521];
  }
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(text || "");
  if (!m) return null;
  const ms = sub ? Math.round(Number("0." + sub.replace(/\D/g, "")) * 1e3) || 0 : 0;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms).getTime();
  return Number.isFinite(t) ? t : null;
}
async function toJpegIfHeic(blob) {
  if (!/heic|heif/i.test(blob.type)) return blob;
  try {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const out = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.95));
    c.width = c.height = 0;
    return out && out.size ? out : blob;
  } catch {
    return blob;
  }
}
var PrendaController = class {
  constructor(ui2) {
    this.ui = ui2;
    this.s = null;
    this.rec = null;
    this.chunkQ = Promise.resolve();
    this._onVis = () => this.onVisibility();
  }
  get recording() {
    return !!this.rec;
  }
  get recordingMs() {
    return this.rec ? this.rec.clock.elapsed() : 0;
  }
  /** Abre el borrador existente o crea uno nuevo. */
  async open(tipo) {
    let s = currentDraft();
    if (s) await this.reconcile(s);
    else {
      s = newPrendaRecord(tipo);
      await saveSession(s);
    }
    if (!TIPOS.includes(s.tipo)) {
      s.tipo = TIPOS.includes(tipo) ? tipo : "nueva";
      await saveSession(s);
    }
    this.s = s;
    return s;
  }
  /** Cierra audios que quedaron a medias por un cierre inesperado. */
  async reconcile(s) {
    let changed = false;
    for (const g of s.segments) {
      if (g.endMs != null) continue;
      const last = await db.lastChunk(s.id, g.seg);
      if (last) {
        g.chunkCount = last.seq + 1;
        g.lastEndMs = last.endMs;
      }
      g.endMs = g.lastEndMs ?? g.startMs;
      g.endReason = "cierre_inesperado";
      changed = true;
    }
    const before = s.segments.length;
    s.segments = s.segments.filter((g) => (g.chunkCount || 0) > 0);
    const maxSeq = (await photosOf(s.id)).reduce((m, p) => Math.max(m, p.seq), 0);
    if (maxSeq > (s.photoSeq || 0)) {
      s.photoSeq = maxSeq;
      changed = true;
    }
    if (changed || before !== s.segments.length) await saveSession(s);
  }
  async photos() {
    return this.s ? orderPhotos((await photosOf(this.s.id)).filter((p) => p.status !== "deleted")) : [];
  }
  audios() {
    return this.s ? this.s.segments.filter((g) => g.endMs != null && (g.chunkCount || 0) > 0) : [];
  }
  async setTipo(tipo) {
    if (!this.s || !TIPOS.includes(tipo)) return;
    this.s.tipo = tipo;
    await saveSession(this.s);
  }
  // ---------- Fotos ----------
  /** Añade las fotos elegidas en la galería del iPhone. Devuelve { added, skipped }. */
  async addFiles(files, onProgress) {
    const s = this.s;
    let added = 0, skipped = 0, i = 0;
    for (const f of files) {
      onProgress?.(++i, files.length);
      try {
        if (!/^image\//.test(f.type) && !/\.(jpe?g|png|heic|heif|webp)$/i.test(f.name || "")) {
          skipped++;
          continue;
        }
        let blob = new Blob([await f.arrayBuffer()], { type: f.type || "image/jpeg" });
        if (!blob.size) {
          skipped++;
          continue;
        }
        blob = await toJpegIfHeic(blob);
        const dims = await imageSize(blob);
        const seq = ++s.photoSeq;
        const id = `${s.id}_F${pad(seq, 4)}`;
        const photo = {
          id,
          sessionId: s.id,
          seq,
          elapsedMs: 0,
          epoch: Date.now(),
          takenAt: await exifDate(blob),
          originalName: f.name || null,
          fileName: null,
          mime: blob.type || "image/jpeg",
          size: blob.size,
          width: dims.width,
          height: dims.height,
          method: "camara_iphone",
          status: "pending",
          driveId: null
        };
        const thumb = await makeThumb(blob);
        await db.put("blobs", { id, blob });
        if (thumb) await db.put("thumbs", { id, blob: thumb });
        await db.put("photos", photo);
        added++;
      } catch (e) {
        skipped++;
        addIncident(s, null, "foto_no_importada", `${f.name || ""}: ${e?.message || e}`);
      }
    }
    await saveSession(s);
    this.ui.onChange?.();
    return { added, skipped };
  }
  async removePhoto(id) {
    await db.del("blobs", id);
    await db.del("thumbs", id);
    await db.del("photos", id);
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
      clock,
      prefer,
      onChunk: (blob, start, end) => this.onChunk(s, g, blob, start, end),
      onError: (msg) => {
        addIncident(s, null, "error_grabador", msg);
        this.stopRecording("error_grabador");
      }
    });
    try {
      g.mimeType = recorder.start();
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("No se pudo iniciar la grabación: " + (e?.message || e));
    }
    s.segments.push(g);
    await saveSession(s);
    const rec = { stream, recorder, seg: g, clock, track };
    rec.meter = new LevelMeter(track, (lvl) => this.ui.onLevel?.(lvl));
    rec.timer = setInterval(() => {
      this.ui.onRecTick?.(clock.elapsed());
      if (document.visibilityState === "visible" && recorder.silenceMs > CONFIG.AUDIO_WATCHDOG_MS) this.stopRecording("grabador_sin_datos");
    }, 300);
    track.addEventListener("ended", () => this.stopRecording("microfono_cortado_por_ios"));
    track.addEventListener("mute", () => {
      rec.muteTimer = setTimeout(() => {
        if (track.muted) this.stopRecording("microfono_silenciado_por_ios");
      }, 1500);
    });
    track.addEventListener("unmute", () => clearTimeout(rec.muteTimer));
    document.addEventListener("visibilitychange", this._onVis);
    try {
      if ("wakeLock" in navigator) rec.wake = await navigator.wakeLock.request("screen");
    } catch {
    }
    this.rec = rec;
    log("grabando audio", g.seg, g.mimeType);
  }
  onVisibility() {
    if (document.visibilityState !== "visible" || !this.rec) return;
    setTimeout(() => {
      const r = this.rec;
      if (r && (r.track.readyState !== "live" || r.track.muted || r.recorder.state !== "recording")) this.stopRecording("interrumpido_al_salir_de_safari");
    }, 1200);
  }
  onChunk(s, g, blob, startMs, endMs) {
    const seq = g.nextSeq++;
    this.chunkQ = this.chunkQ.then(async () => {
      await db.put("chunks", { sessionId: s.id, seg: g.seg, seq, blob, startMs, endMs, size: blob.size });
      if (seq === 0) g.startMs = startMs;
      g.chunkCount = seq + 1;
      g.lastEndMs = endMs;
      g.bytes = (g.bytes || 0) + blob.size;
      if (g.endMs != null) g.endMs = endMs;
      await saveSession(s);
    }).catch((e) => {
      addIncident(s, null, "error_guardando_audio", e?.message || e);
      this.ui.onWarn?.("No se pudo guardar el audio en el móvil (¿sin espacio?).");
    });
  }
  /** Detiene la grabación. reason distinto de 'usuario' = se cortó sola. */
  stopRecording(reason = "usuario") {
    if (this.stopping) return this.stopping;
    if (!this.rec) return Promise.resolve();
    this.stopping = this._stop(reason).finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }
  async _stop(reason) {
    const r = this.rec;
    this.rec = null;
    clearInterval(r.timer);
    clearTimeout(r.muteTimer);
    document.removeEventListener("visibilitychange", this._onVis);
    r.meter?.stop();
    await r.recorder.stop();
    await this.chunkQ;
    r.stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
      }
    });
    try {
      r.wake?.release();
    } catch {
    }
    const g = r.seg, s = this.s;
    g.endMs = g.lastEndMs ?? g.startMs;
    g.endReason = reason;
    if (!(g.chunkCount > 0)) s.segments = s.segments.filter((x) => x !== g);
    if (reason !== "usuario") addIncident(s, null, "audio_interrumpido", reason);
    await saveSession(s);
    this.ui.onRecStopped?.(reason, g.chunkCount > 0);
    this.ui.onChange?.();
  }
  async audioBlob(g) {
    const chunks = await db.chunksRange(this.s.id, g.seg, 0, Math.max(0, (g.chunkCount || 1) - 1));
    return new Blob(chunks.map((c) => c.blob), { type: (g.mimeType || "audio/mp4").split(";")[0] });
  }
  async removeAudio(g) {
    await db.delChunks(this.s.id, g.seg);
    this.s.segments = this.s.segments.filter((x) => x !== g);
    await saveSession(this.s);
    this.ui.onChange?.();
  }
  // ---------- Guardar / descartar ----------
  /** Cierra la prenda y la deja lista para subir. Devuelve el registro. */
  async save() {
    const s = this.s;
    if (this.rec) await this.stopRecording("usuario");
    const now = Date.now(), d = new Date(now);
    s.dayFolder = dayOf(now);
    const key = `prendaCount:${s.dayFolder}`;
    s.number = (await db.kvGet(key) || 0) + 1;
    await db.kvSet(key, s.number);
    s.folderName = `PRENDA_${pad(s.number)}_${pad(d.getHours())}h${pad(d.getMinutes())}_${s.tipo === "resubida" ? "RESUBIDA" : "NUEVA"}`;
    const photos = await this.photos();
    const w = Math.max(2, String(photos.length).length);
    let n = 0;
    for (const p of photos) {
      n++;
      await db.update("photos", p.id, (x) => {
        x.order = n;
        x.fileName = `foto_${pad(n, w)}.${extFor(x.mime)}`;
      });
    }
    this.audios().forEach((g, i) => {
      g.order = i + 1;
      g.fileName = `audio_${pad(i + 1)}.${extFor(g.mimeType)}`;
    });
    s.endEpoch = now;
    s.heartbeatMs = now - s.startEpoch;
    s.status = "finishing";
    s.manifestDirty = true;
    await saveSession(s);
    this.s = null;
    return s;
  }
  async discard() {
    const s = this.s;
    if (!s) return;
    if (this.rec) await this.stopRecording("usuario");
    for (const p of await photosOf(s.id)) {
      await db.del("blobs", p.id);
      await db.del("thumbs", p.id);
      await db.del("photos", p.id);
    }
    for (let i = 1; i <= (s.segSeq || 0); i++) await db.delChunks(s.id, i);
    await forgetSession(s.id);
    this.s = null;
  }
  /** Deja de usar el borrador en pantalla (sigue guardado en el móvil). */
  async leave() {
    if (this.rec) await this.stopRecording("usuario");
    this.s = null;
  }
};

// ../vinted-workflow/app.js
var $ = (id) => document.getElementById(id);
var show = (el, on = true) => el.classList.toggle("hidden", !on);
var controller;
var prenda;
var prendaSeq = 0;
var importing = false;
var prendaUrls = /* @__PURE__ */ new Set();
var orphan = null;
var photoCount = 0;
var viewerPhoto = null;
var renderSeq = 0;
var summaryRun = 0;
var summaryState = null;
var pauseNoticeShown = false;
var currentScreen = "home";
var lastThumbUrl = null;
var viewerUrl = null;
var galleryUrls = /* @__PURE__ */ new Set();
function setLastThumb(blob) {
  if (lastThumbUrl) URL.revokeObjectURL(lastThumbUrl);
  lastThumbUrl = blob ? URL.createObjectURL(blob) : null;
  if (lastThumbUrl) $("last-thumb").src = lastThumbUrl;
  else $("last-thumb").removeAttribute("src");
}
function freePrendaUrls() {
  prendaUrls.forEach((u) => URL.revokeObjectURL(u));
  prendaUrls.clear();
}
function freeGallery() {
  galleryUrls.forEach((u) => URL.revokeObjectURL(u));
  galleryUrls.clear();
  if (viewerUrl) {
    URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
  }
  $("gallery-grid").innerHTML = "";
  $("viewer-img").removeAttribute("src");
}
function go(screen) {
  currentScreen = screen;
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === `screen-${screen}`));
  if (screen !== "gallery") {
    show($("viewer"), false);
    freeGallery();
  }
  if (screen !== "prenda") freePrendaUrls();
  if (screen === "home") renderHome();
  window.scrollTo(0, 0);
}
var radio = (name) => document.querySelector(`input[name=${name}]:checked`)?.value;
function getOpts() {
  return { photoMode: radio("photomode") || "auto", quality: radio("quality") || "high", audioFormat: radio("audiofmt") || "auto", deviceId: $("camera-select").value || "" };
}
var getTipo = () => {
  const t = settings.get("tipo", "nueva");
  return TIPOS.includes(t) ? t : "nueva";
};
function renderTipo() {
  const t = getTipo();
  document.querySelectorAll(".tipo-opt").forEach((b) => {
    const on = b.dataset.tipo === t;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  });
  const pt = prenda?.s?.tipo || t;
  const badge = $("tipo-badge");
  badge.textContent = pt === "resubida" ? "🔁 RESUBIDA · toca para cambiar a NUEVA" : "✨ NUEVA · toca para cambiar a RESUBIDA";
  badge.classList.toggle("resubida", pt === "resubida");
}
async function setTipo(t) {
  settings.set("tipo", t);
  if (prenda?.s) await prenda.setTipo(t);
  renderTipo();
}
function restoreSettings() {
  for (const name of ["photomode", "quality", "audiofmt"]) {
    const saved = settings.get(name, null);
    const el = saved && document.querySelector(`input[name=${name}][value="${saved}"]`);
    if (el) el.checked = true;
    document.querySelectorAll(`input[name=${name}]`).forEach((r) => {
      r.onchange = () => settings.set(name, radio(name));
    });
  }
  $("camera-select").onchange = () => settings.set("camera", $("camera-select").value);
}
async function refreshCameras() {
  const cams = await listCameras();
  const sel = $("camera-select");
  const saved = settings.get("camera", "");
  sel.innerHTML = '<option value="">Trasera (automática)</option>';
  for (const c of cams) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.label;
    sel.appendChild(o);
  }
  sel.value = cams.some((c) => c.id === saved) ? saved : "";
}
var dialogQueue = Promise.resolve();
function dialog(opts) {
  const p = dialogQueue.then(() => showDialog(opts));
  dialogQueue = p.catch(() => {
  });
  return p;
}
function showDialog({ msg, okText = "Aceptar", cancelText = "Cancelar", danger = false, onOk = null }) {
  return new Promise((resolve) => {
    $("dialog-msg").textContent = msg;
    $("dialog-ok").textContent = okText;
    $("dialog-ok").className = `btn ${danger ? "danger" : "primary"}`;
    $("dialog-cancel").textContent = cancelText || "";
    show($("dialog-cancel"), !!cancelText);
    show($("dialog"));
    const done = (v) => {
      show($("dialog"), false);
      $("dialog-ok").onclick = $("dialog-cancel").onclick = null;
      resolve(v);
    };
    $("dialog-ok").onclick = () => {
      let r = true;
      if (onOk) {
        try {
          r = onOk();
        } catch (e) {
          r = false;
          console.error(e);
        }
      }
      done(r);
    };
    $("dialog-cancel").onclick = () => done(false);
  });
}
var info = (msg) => dialog({ msg, okText: "Entendido", cancelText: null });
function toast(msg, ms = 6e3) {
  const b = $("banner");
  b.textContent = msg;
  show(b);
  clearTimeout(toast.t);
  toast.t = setTimeout(() => show(b, false), ms);
}
async function login({ switchAccount = false } = {}) {
  try {
    const p = auth.signIn({ switchAccount });
    await p;
    const user = await drive.whoAmI();
    const allowed = CONFIG.ALLOWED_EMAILS.map((e) => e.toLowerCase());
    if (allowed.length && !allowed.includes(user.emailAddress.toLowerCase())) {
      auth.signOut();
      await info(`La cuenta ${user.emailAddress} no está autorizada en esta app.

Entra con ${CONFIG.ALLOWED_EMAILS.join(" o ")}.`);
      return false;
    }
    auth.setEmail(user.emailAddress);
    pauseNoticeShown = false;
    sync.resetBackoff();
    sync.kick();
    return true;
  } catch (e) {
    await info("No se pudo entrar con Google.\n\n" + (e?.message || e));
    return false;
  }
}
function renderAuth() {
  const ok = auth.isValid();
  const mins = auth.minutesLeft();
  $("auth-status").textContent = ok ? `${auth.email || "Conectado"} ✓` : auth.email ? `${auth.email} · hay que reconectar` : auth.ready ? "Google Drive sin conectar" : "Cargando…";
  $("btn-login").textContent = ok ? "Renovar" : auth.email ? "Reconectar" : "Entrar con Google";
  $("btn-login").disabled = !auth.ready;
  show($("btn-login"), !ok || mins < 10);
  show($("btn-logout"), ok || !!auth.email);
  $("btn-start").disabled = !ok || !!orphan;
  $("start-hint").textContent = !ok ? "Entra con Google para empezar." : orphan ? "Reanuda o termina primero la sesión pendiente." : "";
  renderDriveAlert();
}
function renderDriveAlert() {
  const ok = auth.isValid();
  const pending = sync.status.pendingPhotos + sync.status.pendingAudio;
  const txt = !auth.ready ? "Cargando Google…" : pending ? `⚠️ ${pending} archivo(s) SIN SUBIR a Drive
Toca aquí para conectar Google Drive` : "⚠️ Google Drive NO está conectado\nToca aquí para conectar";
  document.querySelectorAll(".drive-alert").forEach((b) => {
    b.textContent = txt;
    b.disabled = !auth.ready;
    show(b, !ok);
  });
  show($("status-row"), ok);
}
async function environmentWarnings() {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const caps = capabilities();
  const warns = [];
  if (isIOS && (/CriOS|FxiOS|EdgiOS|GSA\/|FBAN|FBAV|Instagram|Line\/|WhatsApp|TikTok|Twitter/.test(ua) || !/Safari\//.test(ua))) {
    warns.push("Estás abriendo la app desde otra aplicación o navegador. Ábrela en Safari (copia el enlace y pégalo en Safari): fuera de Safari, la cámara, el micrófono o el acceso a Google pueden fallar.");
  }
  if (navigator.standalone) warns.push("Estás usando la app desde el icono de la pantalla de inicio. De momento es más fiable abrirla desde Safari.");
  if (!caps.getUserMedia || !caps.mediaRecorder) warns.push("Este navegador no permite usar la cámara y grabar audio desde una página web. Actualiza iOS o usa Safari.");
  try {
    await db.check();
  } catch {
    warns.push("No se puede guardar en este navegador (¿navegación privada?). Usa una pestaña normal de Safari: sin almacenamiento local no hay copia de seguridad de la sesión.");
  }
  const est = await storageEstimate();
  if (est?.quota && est.quota - (est.usage || 0) < CONFIG.LOW_SPACE_BYTES) {
    warns.push(`Queda poco espacio para guardar la sesión en el móvil (${fmtBytes(est.quota - (est.usage || 0))}). Libera espacio en el iPhone antes de una sesión larga.`);
  }
  const box = $("env-warning");
  box.innerHTML = warns.map((w) => `<p>⚠️ ${escapeHtml(w)}</p>`).join("");
  show(box, warns.length > 0);
  const fmts = supportedAudioFormats();
  $("caps-info").textContent = [
    `Versión ${CONFIG.APP_VERSION}`,
    `Cámara y micrófono: ${caps.getUserMedia ? "sí" : "NO"}`,
    `Audio: ${caps.mediaRecorder ? pickAudioMime(radio("audiofmt")) || "formato por defecto" : "NO"} (WebM ${fmts.webm ? "sí" : "no"}, MP4 ${fmts.mp4 ? "sí" : "no"})`,
    `Foto completa (takePhoto): ${caps.imageCapture ? "sí" : "no, se usa fotograma"}`,
    `Pantalla siempre activa: ${caps.wakeLock ? "sí" : "no"}`,
    est?.quota ? `Espacio local: ${fmtBytes(est.usage || 0)} usados de ${fmtBytes(est.quota)}` : ""
  ].filter(Boolean).join(" · ");
}
var homeUrls = /* @__PURE__ */ new Set();
var homeUrlsOld = /* @__PURE__ */ new Set();
async function renderHome() {
  const my = ++renderSeq;
  renderAuth();
  const sessions = await loadSessions();
  const data = [];
  for (const s of sessions) {
    if (s.status === "failed") continue;
    const ph = validPhotos(await photosOf(s.id));
    const first = s.kind === "prenda" && s.status !== "draft" ? [...ph].sort((a, b) => (a.order || a.seq) - (b.order || b.seq))[0] : null;
    data.push({ s, photos: ph.length, thumb: first ? await thumbOf(first) : null });
  }
  if (my !== renderSeq) return;
  homeUrls.forEach((u) => homeUrlsOld.add(u));
  homeUrls.clear();
  orphan = sessions.find((s) => s.kind !== "prenda" && s.status === "active" && s !== controller?.s) || null;
  show($("resume-card"), !!orphan);
  if (orphan) {
    const n = data.find((d) => d.s === orphan)?.photos ?? 0;
    $("resume-info").textContent = `Iniciada el ${fmtDateTime(orphan.startEpoch)} · ${fmtDuration(orphan.heartbeatMs)} de sesión · ${n} fotos`;
    $("more").open = true;
    $("session-mode").open = true;
  }
  renderAuth();
  const draft = currentDraft();
  const dn = draft ? data.find((d) => d.s === draft)?.photos ?? 0 : 0;
  const da = draft ? draft.segments.filter((g) => g.endMs != null).length : 0;
  const hasDraft = !!draft && (dn > 0 || da > 0);
  $("btn-prenda").textContent = hasDraft ? "CONTINUAR PRENDA" : "EMPEZAR PRENDA";
  $("prenda-hint").textContent = hasDraft ? `A medias: ${dn} foto(s) y ${da} audio(s).` : "";
  show($("prenda-hint"), hasDraft);
  const list = $("session-list");
  const frag = document.createDocumentFragment();
  for (const { s, photos, thumb } of data) {
    if (s === controller?.s || s.status === "draft") continue;
    const li = document.createElement("li");
    const isPrenda = s.kind === "prenda";
    const dur = (s.endEpoch || s.startEpoch + (s.heartbeatMs || 0)) - s.startEpoch;
    const audios = s.segments.filter((g) => !g.full?.empty && (g.chunkCount || 0) > 0).length;
    const tag = s.verified ? '<span class="tag ok">en Drive ✓</span>' : s.lossy ? '<span class="tag pend">guardada con incidencias</span>' : s.status === "active" ? '<span class="tag bad">sin terminar</span>' : '<span class="tag pend">pendiente de subir</span>';
    const title = isPrenda ? `Prenda ${String(s.number || "").padStart(2, "0")} · ${s.tipo === "resubida" ? "RESUBIDA" : "NUEVA"} · ${fmtDateTime(s.endEpoch || s.startEpoch)}` : `Sesión · ${fmtDateTime(s.startEpoch)}`;
    const detail = isPrenda ? `${photos} foto(s) · ${audios} audio(s)` : `${fmtDuration(dur)} · ${photos} fotos · ${audios} audio(s)`;
    li.innerHTML = `${isPrenda ? '<img class="mini-thumb" alt="">' : ""}<div><div><b>${escapeHtml(title)}</b> ${tag}</div>
      <div class="muted">${escapeHtml(detail)}</div>
      <div class="session-actions"></div></div>`;
    if (isPrenda) {
      li.className = "with-thumb";
      if (thumb) {
        const u = URL.createObjectURL(thumb);
        homeUrls.add(u);
        li.querySelector("img").src = u;
      }
    }
    const actions = li.querySelector(".session-actions");
    if (s.drive?.folderId) {
      const a = document.createElement("a");
      a.href = drive.folderUrl(s.drive.folderId);
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Abrir en Drive";
      actions.appendChild(a);
    }
    if (s.status === "finishing") {
      const b = document.createElement("button");
      b.className = "btn mini primary";
      b.textContent = "Completar guardado";
      b.onclick = () => openSummary(s);
      actions.appendChild(b);
    }
    if (s.status !== "active") {
      const d = document.createElement("button");
      d.className = "btn mini secondary";
      d.textContent = "Eliminar";
      d.onclick = () => deleteSessionFlow(s, photos);
      actions.appendChild(d);
    }
    frag.appendChild(li);
  }
  homeUrlsOld.forEach((u) => URL.revokeObjectURL(u));
  homeUrlsOld.clear();
  list.innerHTML = "";
  if (frag.childNodes.length) list.appendChild(frag);
  show($("list-card"), frag.childNodes.length > 0 || list.childNodes.length > 0);
}
async function deleteSessionFlow(s, photos) {
  const inDrive = !!s.drive?.folderId;
  const needLogin = inDrive && !auth.isValid();
  const pending = !(s.verified || s.lossy);
  const what = s.kind === "prenda" ? `la prenda ${String(s.number || "").padStart(2, "0")} del ${fmtDateTime(s.endEpoch || s.startEpoch)}` : `la sesión del ${fmtDateTime(s.startEpoch)}`;
  const msg = `¿Eliminar ${what} (${photos} fotos)?

` + (inDrive ? `Su carpeta de Drive (${s.folderName}) se enviará a la papelera de Drive, donde Google la conserva 30 días por si te arrepientes. ` : "Todavía no se había subido nada a Drive. ") + "También se borrará de la app. No afecta a nada más: ni a otras prendas, ni a las fotos de la galería del iPhone." + (pending ? "\n\n⚠️ ATENCIÓN: tiene archivos que aún NO se han subido a Drive. Si la eliminas, esos archivos se pierden para siempre." : "") + (needLogin ? "\n\nPrimero se abrirá Google para confirmar tu cuenta." : "");
  const ok = await dialog({ msg, okText: "Eliminar", danger: true, onOk: () => needLogin ? login() : true });
  if (!ok) return;
  try {
    await sync.deleteSession(s);
  } catch (e) {
    await info("No se pudo eliminar.\n\n" + (e?.message || e));
  }
  renderHome();
}
function renderSync(st, justSaved) {
  renderDriveAlert();
  if (justSaved && currentScreen === "home") renderHome();
  const pending = st.pendingPhotos + st.pendingAudio;
  $("home-sync").textContent = !pending && !st.lastError ? auth.isValid() ? "Todo en Drive" : "" : !navigator.onLine ? `Sin conexión · ${pending} archivo(s) por subir` : !auth.isValid() ? `${pending} archivo(s) por subir: entra con Google` : st.lastError ? `Reintentando la subida…` : `Subiendo… quedan ${pending}`;
  $("sync-count").textContent = pending;
  $("sync-pill").classList.toggle("pause", pending > 0 && (!!st.paused || !!st.lastError));
  if (currentScreen === "summary" && st.working) $("sum-progress").textContent = `${st.working} · quedan ${pending} archivo(s)`;
  if (controller?.active && st.paused && !pauseNoticeShown && pending > 0) {
    pauseNoticeShown = true;
    toast(navigator.onLine ? "La subida a Drive está en pausa (el acceso de Google dura 1 hora). Sigue trabajando con normalidad: todo se guarda en el móvil y se subirá al terminar." : "Sin conexión. Sigue trabajando con normalidad: todo se guarda en el móvil y se subirá cuando vuelva la cobertura.", 9e3);
  }
  if (!st.paused) pauseNoticeShown = false;
}
var starting = false;
async function startSession() {
  if (controller.s || starting) return;
  starting = true;
  try {
    await startSessionInner();
  } finally {
    starting = false;
  }
}
async function startSessionInner() {
  const caps = capabilities();
  if (!caps.getUserMedia || !caps.mediaRecorder) {
    await info("Este navegador no permite usar la cámara y grabar audio desde una página web.\n\nAbre la app en Safari con iOS actualizado.");
    return;
  }
  if (auth.minutesLeft() < CONFIG.TOKEN_MIN_MINUTES_TO_START) {
    const ok = await dialog({
      msg: `Al acceso a Drive le quedan ${auth.minutesLeft()} min. Renuévalo antes de empezar para que las fotos y el audio se vayan subiendo durante la sesión.`,
      okText: "Renovar acceso",
      onOk: () => login()
    });
    if (!ok) return;
  }
  $("btn-start").disabled = true;
  $("start-hint").textContent = "Activando cámara y micrófono…";
  try {
    await controller.startNew(getOpts());
    enterSessionScreen([]);
    refreshCameras();
  } catch (e) {
    const denied = e?.name === "NotAllowedError";
    await info((denied ? "No hay permiso para usar la cámara o el micrófono." : "No se pudo activar la cámara o el micrófono: " + (e?.message || e)) + "\n\nPara permitirlo: toca el icono de la izquierda de la barra de direcciones de Safari › Ajustes del sitio web › Cámara y Micrófono › Permitir. Después recarga la página.");
    go("home");
  }
}
async function enterSessionScreen(photos) {
  const valid = validPhotos(photos);
  photoCount = valid.length;
  $("photo-count").textContent = photoCount;
  const last = valid[valid.length - 1];
  setLastThumb(last ? await thumbOf(last) : null);
  show($("recover-overlay"), false);
  $("rec-pill").classList.remove("bad");
  $("mic-pill").classList.remove("bad");
  $("timer").textContent = fmtDuration(controller.elapsed);
  pauseNoticeShown = false;
  go("session");
  try {
    history.pushState({ vw: "session" }, "");
  } catch {
  }
}
async function onPhotoTap() {
  controller.nudge();
  if (!controller.canShoot) {
    toast("La cámara se está reactivando. Espera un segundo y vuelve a pulsar.", 2500);
    return;
  }
  const f = $("flash");
  f.classList.add("on");
  setTimeout(() => f.classList.remove("on"), 60);
  try {
    await controller.takePhoto();
  } catch (e) {
    toast("No se pudo hacer la foto: " + (e?.message || e));
  }
}
var ui = {
  onTick: (ms) => {
    $("timer").textContent = fmtDuration(ms);
  },
  onLevel: (lvl) => {
    const m = document.querySelector(".meter");
    m.classList.toggle("idle", lvl == null);
    if (lvl != null) $("meter-bar").style.width = `${Math.round(lvl * 100)}%`;
  },
  onPhoto: (photo, thumb) => {
    photoCount++;
    const b = $("photo-count");
    b.textContent = photoCount;
    b.classList.remove("bump");
    void b.offsetWidth;
    b.classList.add("bump");
    if (thumb) setLastThumb(thumb);
  },
  onInterrupted: (msg, soft) => {
    $("recover-title").textContent = soft ? "Toca para reactivar la cámara" : "Grabación interrumpida";
    $("recover-msg").textContent = msg + (soft ? "." : ". Lo grabado hasta ahora está a salvo.");
    $("btn-recover").textContent = soft ? "REACTIVAR CÁMARA" : "REANUDAR GRABACIÓN";
    $("rec-pill").classList.toggle("bad", !soft);
    $("mic-pill").classList.toggle("bad", !soft);
    if (currentScreen === "gallery") go("session");
    show($("recover-overlay"));
  },
  onRecovered: (msg) => {
    show($("recover-overlay"), false);
    $("rec-pill").classList.remove("bad");
    $("mic-pill").classList.remove("bad");
    if (msg) toast(msg, 4e3);
  },
  onWarn: (msg) => toast(msg, 1e4),
  onCamera: ({ zoom, torch }) => {
    const z = $("btn-zoom");
    show(z, !!zoom);
    if (zoom) z.textContent = zoom;
    const t = $("btn-torch");
    show(t, !!torch);
    t.classList.remove("on");
  }
};
async function openGallery() {
  controller.nudge();
  go("gallery");
  const photos = validPhotos(await controller.photos());
  $("gal-title").textContent = photos.length === 1 ? "1 foto" : `${photos.length} fotos`;
  const grid = $("gallery-grid");
  grid.innerHTML = photos.length ? "" : '<p class="muted center">Todavía no hay fotos en esta sesión.</p>';
  for (const p of [...photos].reverse()) {
    const fig = document.createElement("figure");
    fig.innerHTML = `<img alt="Foto ${p.seq}" loading="lazy"><figcaption>#${p.seq} · ${fmtDuration(p.elapsedMs)}</figcaption><span class="st">${p.driveId ? "☁︎" : "⏳"}</span>`;
    fig.onclick = () => openViewer(p.id);
    grid.appendChild(fig);
    thumbOf(p).then((t) => {
      if (!t || currentScreen !== "gallery" || !fig.isConnected) return;
      const u = URL.createObjectURL(t);
      galleryUrls.add(u);
      fig.querySelector("img").src = u;
    });
  }
}
async function openViewer(id) {
  const p = await db.get("photos", id);
  if (!p) return;
  viewerPhoto = p;
  const full = (await db.get("blobs", id))?.blob || await thumbOf(p);
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = full ? URL.createObjectURL(full) : null;
  if (viewerUrl) $("viewer-img").src = viewerUrl;
  $("viewer-info").textContent = `Foto #${p.seq} · minuto ${fmtDuration(p.elapsedMs)} · ${p.width || "?"}×${p.height || "?"} · ${fmtBytes(p.size)} · ${p.driveId ? "ya está en Drive" : "pendiente de subir"}`;
  show($("viewer"));
}
async function deleteViewerPhoto() {
  const p = viewerPhoto;
  if (!p) return;
  const ok = await dialog({ msg: `¿Eliminar la foto #${p.seq}?

No se incluirá en la sesión.${p.driveId ? " Como ya estaba en Drive, se moverá a la carpeta FOTOS/_ELIMINADAS." : ""}`, okText: "Eliminar", danger: true });
  if (!ok) return;
  await controller.deletePhoto(p);
  const remaining = validPhotos(await controller.photos());
  photoCount = remaining.length;
  $("photo-count").textContent = photoCount;
  const last = remaining[remaining.length - 1];
  setLastThumb(last ? await thumbOf(last) : null);
  show($("viewer"), false);
  if (currentScreen === "gallery") openGallery();
}
async function endSession() {
  if (!controller.s) return;
  const ok = await dialog({ msg: "¿Terminar la sesión?\n\nSe detendrán la cámara y el micrófono y se guardará todo en Drive.", okText: "Terminar sesión", danger: true });
  if (!ok || !controller.s) return;
  $("btn-end").disabled = true;
  try {
    const s = await controller.finish();
    setLastThumb(null);
    show($("recover-overlay"), false);
    if (s) openSummary(s);
  } finally {
    $("btn-end").disabled = false;
  }
}
var incidentText = (s) => s.incidents.map((i) => `${i.elapsed_ms != null ? fmtDuration(i.elapsed_ms) : "--:--:--"}  ${i.type} ${i.detail}`).join("\n");
async function openSummary(s, { auto = false } = {}) {
  const my = ++summaryRun;
  if (!auto || !summaryState || summaryState.session !== s) summaryState = { session: s, attempts: 0 };
  summaryState.attempts++;
  go("summary");
  const isPrenda = s.kind === "prenda";
  const W = isPrenda ? "prenda" : "sesión";
  $("sum-title").textContent = `Guardando ${W}…`;
  $("sum-progress").textContent = isPrenda ? "Puedes seguir con la siguiente prenda: la subida continúa sola mientras Safari esté abierto." : "No cierres Safari hasta que termine.";
  show($("btn-sum-retry"), false);
  show($("btn-sum-drive"), false);
  show($("btn-sum-next"), isPrenda);
  const photos = await photosOf(s.id);
  const valid = validPhotos(photos);
  const audioMs = s.segments.reduce((a, g) => a + ((g.endMs ?? g.startMs) - g.startMs), 0);
  const audios = s.segments.filter((g) => (g.chunkCount || 0) > 0).length;
  $("sum-kv").innerHTML = isPrenda ? `
    <dt>Prenda</dt><dd>${String(s.number || "").padStart(2, "0")} · ${fmtDateTime(s.endEpoch || s.startEpoch)}</dd>
    <dt>Tipo</dt><dd>${s.tipo === "resubida" ? "🔁 RESUBIDA" : "✨ NUEVA"}</dd>
    <dt>Fotos</dt><dd>${valid.length}</dd>
    <dt>Audio</dt><dd>${audios ? `${audios} (${fmtDuration(audioMs)})` : "sin audio"}</dd>
    <dt>Carpeta</dt><dd>${escapeHtml(CONFIG.ROOT_FOLDER_NAME)}/${escapeHtml(s.dayFolder)}/${escapeHtml(s.folderName)}</dd>` : `
    <dt>Inicio</dt><dd>${fmtDateTime(s.startEpoch)}</dd>
    <dt>Fin</dt><dd>${s.endEpoch ? fmtDateTime(s.endEpoch) : "—"}</dd>
    <dt>Duración</dt><dd>${fmtDuration((s.endEpoch || Date.now()) - s.startEpoch)}</dd>
    <dt>Fotos válidas</dt><dd>${valid.length}${photos.length - valid.length ? ` (${photos.length - valid.length} eliminadas)` : ""}</dd>
    <dt>Audio</dt><dd>${fmtDuration(audioMs)}${s.gaps.length ? ` · ${s.gaps.length} corte(s)` : " · sin cortes"}</dd>
    <dt>Carpeta</dt><dd>${escapeHtml(CONFIG.ROOT_FOLDER_NAME)}/${escapeHtml(s.folderName)}</dd>`;
  $("sum-checks").innerHTML = "<li>⏳ Subiendo y comprobando archivos en Drive…</li>";
  $("sum-incidents").textContent = incidentText(s);
  let report;
  try {
    report = await sync.finalize(s);
  } catch (e) {
    report = { ok: false, checks: [{ ok: false, label: "Error inesperado al guardar", detail: (e?.message || e) + ". No se ha borrado nada del móvil; pulsa Reintentar." }] };
  }
  if (my !== summaryRun) return;
  summaryState.report = report;
  const icon = (c) => c.warn ? "⚠️" : c.ok ? "✅" : report.needsLogin || report.offline ? "⏳" : "❌";
  $("sum-checks").innerHTML = report.checks.map((c) => `<li>${icon(c)} ${escapeHtml(c.label)}${c.detail ? `<div class="muted small">${escapeHtml(c.detail)}</div>` : ""}</li>`).join("");
  const G = isPrenda ? "Prenda guardada" : "Sesión guardada";
  $("sum-title").textContent = report.ok ? report.lossy ? `${G} con incidencias` : G : report.needsLogin ? "Falta subir a Drive" : report.offline ? "Esperando conexión" : "Faltan archivos por guardar";
  $("sum-progress").textContent = report.ok ? "Todo está en tu Google Drive y comprobado." : isPrenda ? "No se ha perdido nada: sigue guardada en la app y se subirá en cuanto se pueda. Puedes continuar con la siguiente." : "No se ha perdido nada: lo pendiente sigue guardado en este móvil.";
  $("btn-sum-retry").textContent = report.needsLogin ? "Conectar con Google y subir" : "Reintentar ahora";
  show($("btn-sum-retry"), !report.ok);
  if (s.drive?.folderId) {
    $("btn-sum-drive").href = drive.folderUrl(s.drive.folderId);
    show($("btn-sum-drive"));
  }
  $("sum-incidents").textContent = incidentText(s);
  clearTimeout(openSummary.timer);
  if (!report.ok && !report.needsLogin && summaryState.attempts < 6) {
    openSummary.timer = setTimeout(() => {
      if (currentScreen === "summary" && summaryState?.session === s && my === summaryRun && navigator.onLine) openSummary(s, { auto: true });
    }, 2e4);
  }
}
async function openPrenda({ ask = false } = {}) {
  if (controller.s) return;
  if (ask && !auth.isValid()) {
    const r = await dialog({
      msg: "Google Drive NO está conectado.\n\nSi sigues sin conectar, las fotos y el audio se quedan solo en este móvil hasta que conectes.",
      okText: "Conectar ahora",
      cancelText: "Seguir sin conectar",
      onOk: () => auth.ready ? login() : false
    });
    if (r) await r;
  }
  await prenda.open(getTipo());
  renderTipo();
  go("prenda");
  try {
    history.pushState({ vw: "prenda" }, "");
  } catch {
  }
  await renderPrenda();
}
async function renderPrenda() {
  const my = ++prendaSeq;
  if (!prenda.s) return;
  const photos = await prenda.photos();
  const audios = prenda.audios();
  const thumbs = await Promise.all(photos.map((p) => thumbOf(p)));
  const blobs = await Promise.all(audios.map((g) => prenda.audioBlob(g)));
  if (my !== prendaSeq || !prenda.s || currentScreen !== "prenda") return;
  freePrendaUrls();
  $("prenda-photo-count").textContent = photos.length ? `(${photos.length})` : "";
  const grid = $("prenda-grid");
  grid.innerHTML = "";
  photos.forEach((p, i) => {
    const fig = document.createElement("figure");
    fig.innerHTML = `<img alt="Foto ${i + 1}"><figcaption>${i + 1}</figcaption><button class="rm" aria-label="Quitar foto ${i + 1}">✕</button>`;
    if (thumbs[i]) {
      const u = URL.createObjectURL(thumbs[i]);
      prendaUrls.add(u);
      fig.querySelector("img").src = u;
    }
    fig.querySelector(".rm").onclick = async () => {
      await prenda.removePhoto(p.id);
    };
    grid.appendChild(fig);
  });
  $("btn-pick").textContent = importing ? "Guardando foto…" : photos.length ? "📷 HACER OTRA FOTO" : "📷 HACER FOTO";
  const list = $("audio-list");
  list.innerHTML = "";
  audios.forEach((g, i) => {
    const li = document.createElement("li");
    const u = URL.createObjectURL(blobs[i]);
    prendaUrls.add(u);
    li.innerHTML = `<audio controls preload="metadata"></audio><span class="dur">${fmtDuration(g.endMs - g.startMs).slice(3)}</span><button class="btn mini secondary">Borrar</button>`;
    li.querySelector("audio").src = u;
    li.querySelector("button").onclick = async () => {
      const ok = await dialog({ msg: `¿Borrar el audio ${i + 1} (${fmtDuration(g.endMs - g.startMs).slice(3)})?`, okText: "Borrar audio", danger: true });
      if (ok) await prenda.removeAudio(g);
    };
    list.appendChild(li);
  });
  renderRecButton(audios.length);
  $("btn-save").disabled = photos.length === 0 || importing;
  $("prenda-title").textContent = photos.length || audios.length ? `Prenda: ${photos.length} foto(s), ${audios.length} audio(s)` : "Prenda nueva";
}
function renderRecButton(count = prenda.audios().length) {
  const rec = prenda.recording;
  const b = $("btn-rec");
  b.classList.toggle("recording", rec);
  b.classList.toggle("secondary", !rec);
  b.textContent = rec ? "■ PARAR GRABACIÓN" : count ? "🎙 GRABAR OTRO AUDIO" : "🎙 GRABAR AUDIO";
  show($("rec-live"), rec);
}
async function onPickFiles(e) {
  const files = [...e.target.files || []];
  e.target.value = "";
  if (!files.length || !prenda.s || importing) return;
  importing = true;
  $("btn-save").disabled = true;
  try {
    const r = await prenda.addFiles(files, (i, n) => {
      $("btn-pick").textContent = n > 1 ? `Añadiendo foto ${i} de ${n}…` : "Guardando foto…";
    });
    if (r.skipped) toast(`${r.skipped} archivo(s) no se han podido añadir (solo se admiten fotos).`);
  } catch (err) {
    toast("No se pudieron añadir las fotos: " + (err?.message || err));
  } finally {
    importing = false;
    renderPrenda();
  }
}
async function onRecTap() {
  if (!prenda.s) return;
  const b = $("btn-rec");
  if (b.disabled) return;
  b.disabled = true;
  try {
    if (prenda.recording) await prenda.stopRecording("usuario");
    else {
      $("rec-time").textContent = "00:00";
      await prenda.startRecording(radio("audiofmt") || "mp4");
      renderRecButton();
    }
  } catch (e) {
    const denied = e?.name === "NotAllowedError";
    await info((denied ? "No hay permiso para usar el micrófono." : "No se pudo grabar: " + (e?.message || e)) + (denied ? "\n\nPara permitirlo: toca el icono de la izquierda de la barra de direcciones de Safari › Ajustes del sitio web › Micrófono › Permitir." : ""));
  } finally {
    b.disabled = false;
  }
}
async function savePrenda() {
  if (!prenda.s || importing) return;
  const photos = await prenda.photos();
  if (!photos.length) return;
  if (!prenda.recording && prenda.audios().length === 0) {
    const ok = await dialog({ msg: "Esta prenda no tiene audio.\n\n¿Guardarla solo con las fotos?", okText: "Guardar sin audio", cancelText: "Volver" });
    if (!ok) return;
  }
  $("btn-save").disabled = true;
  try {
    const s = await prenda.save();
    sync.resetBackoff();
    openSummary(s);
  } catch (e) {
    await info("No se pudo guardar la prenda: " + (e?.message || e));
    renderPrenda();
  }
}
async function discardPrenda() {
  if (!prenda.s) return;
  const ok = await dialog({ msg: "¿Descartar esta prenda?\n\nSe quitan de la app las fotos elegidas y los audios grabados. Las fotos siguen en la galería de tu iPhone.", okText: "Descartar", danger: true });
  if (!ok) return;
  await prenda.discard();
  go("home");
}
async function leavePrenda() {
  if (prenda.recording) {
    const ok = await dialog({ msg: "Se está grabando un audio. ¿Pararlo y volver al inicio?\n\nLa prenda se queda guardada a medias para continuarla luego.", okText: "Parar y salir" });
    if (!ok) return;
  }
  await prenda.leave();
  go("home");
}
var prendaUi = {
  onChange: () => {
    if (currentScreen === "prenda") renderPrenda();
  },
  onLevel: (lvl) => {
    if (lvl != null) $("rec-meter-bar").style.width = `${Math.round(lvl * 100)}%`;
  },
  onRecTick: (ms) => {
    $("rec-time").textContent = fmtDuration(ms).slice(3);
  },
  onRecStopped: (reason, saved) => {
    renderRecButton();
    if (reason !== "usuario") toast(saved ? "La grabación se ha cortado (iOS ha parado el micrófono). Lo grabado está guardado: puedes escucharlo y grabar otro audio para continuar." : "iOS ha parado el micrófono antes de grabar nada. Vuelve a pulsar GRABAR AUDIO.", 9e3);
  },
  onWarn: (msg) => toast(msg, 1e4)
};
async function main() {
  $("app-version").textContent = `Versión ${CONFIG.APP_VERSION}`;
  restoreSettings();
  requestPersistence();
  environmentWarnings();
  refreshCameras();
  controller = new SessionController($("preview"), ui);
  prenda = new PrendaController(prendaUi);
  auth.onChange(renderAuth);
  sync.onStatus(renderSync);
  setInterval(renderAuth, 3e4);
  $("btn-login").onclick = () => login().then(renderHome);
  $("btn-logout").onclick = () => login({ switchAccount: true }).then(renderHome);
  $("btn-start").onclick = startSession;
  $("btn-prenda").onclick = () => openPrenda({ ask: true });
  document.querySelectorAll(".tipo-opt").forEach((b) => {
    b.onclick = () => setTipo(b.dataset.tipo);
  });
  $("tipo-badge").onclick = () => setTipo((prenda.s?.tipo || getTipo()) === "resubida" ? "nueva" : "resubida");
  renderTipo();
  document.querySelectorAll(".drive-alert").forEach((b) => {
    b.onclick = () => login().then(() => {
      if (currentScreen === "home") renderHome();
    });
  });
  $("btn-prenda-back").onclick = leavePrenda;
  $("file-input").onchange = onPickFiles;
  $("camera-input").onchange = onPickFiles;
  $("btn-rec").onclick = onRecTap;
  $("btn-save").onclick = savePrenda;
  $("btn-discard").onclick = discardPrenda;
  $("btn-sum-next").onclick = () => {
    clearTimeout(openSummary.timer);
    openPrenda();
  };
  $("btn-photo").onclick = onPhotoTap;
  $("btn-gallery").onclick = openGallery;
  $("btn-gal-back").onclick = () => go("session");
  $("btn-viewer-close").onclick = () => show($("viewer"), false);
  $("btn-viewer-delete").onclick = deleteViewerPhoto;
  $("btn-end").onclick = endSession;
  $("btn-recover-end").onclick = endSession;
  $("btn-zoom").onclick = async () => {
    const z = await controller.cycleZoom();
    if (z) $("btn-zoom").textContent = z;
  };
  $("btn-torch").onclick = async () => {
    $("btn-torch").classList.toggle("on", await controller.toggleTorch());
  };
  $("btn-recover").onclick = async () => {
    $("btn-recover").disabled = true;
    try {
      await controller.recoverManual();
    } catch (e) {
      $("recover-msg").textContent = "No se pudo reanudar: " + (e?.message || e) + ". Vuelve a intentarlo. Si sigue fallando, recarga la página y pulsa REANUDAR: no se pierde lo grabado.";
    } finally {
      $("btn-recover").disabled = false;
    }
  };
  $("sync-pill").onclick = () => {
    const st = sync.status, pending = st.pendingPhotos + st.pendingAudio;
    if (!auth.isValid()) {
      dialog({
        msg: "La subida a Drive está en pausa porque el acceso de Google dura 1 hora. No pasa nada: todo se guarda en el móvil y se subirá al terminar.\n\nSi prefieres reconectar ahora, se abrirá una ventana de Google y la grabación puede cortarse un par de segundos (se reanuda sola y el corte queda anotado).",
        okText: "Reconectar ahora",
        cancelText: "Seguir así",
        onOk: () => login()
      });
    } else toast(st.lastError ? `Reintentando la subida (${st.lastError}). Lo pendiente sigue guardado en el móvil.` : pending ? `Subiendo a Drive: quedan ${pending} archivo(s).` : "Todo lo capturado hasta ahora ya está en Drive.", 4e3);
  };
  $("btn-resume").onclick = async () => {
    const s = orphan;
    if (!s || controller.s || starting) return;
    starting = true;
    $("btn-resume").disabled = true;
    try {
      await controller.resume(s, getOpts());
      orphan = null;
      await enterSessionScreen(await photosOf(s.id));
    } catch (e) {
      await info("No se pudo reanudar: " + (e?.message || e) + "\n\nComprueba el permiso de cámara y micrófono y vuelve a intentarlo. También puedes pulsar TERMINAR Y GUARDAR: lo grabado no se pierde.");
      renderHome();
    } finally {
      $("btn-resume").disabled = false;
      starting = false;
    }
  };
  $("btn-finish-old").onclick = async () => {
    const s = orphan;
    if (!s) return;
    const ok = await dialog({ msg: "¿Terminar esta sesión sin reanudarla?\n\nSe guardará en Drive todo lo grabado hasta el corte.", okText: "Terminar y guardar" });
    if (!ok) return;
    await finishOrphan(s);
    orphan = null;
    openSummary(s);
  };
  $("btn-sum-retry").onclick = () => {
    const s = summaryState?.session;
    if (!s) return;
    if (!auth.isValid()) {
      login().then((ok) => {
        if (ok) openSummary(s);
      });
      return;
    }
    openSummary(s);
  };
  $("btn-sum-home").onclick = () => {
    clearTimeout(openSummary.timer);
    go("home");
  };
  window.addEventListener("online", () => {
    if (currentScreen === "summary" && summaryState?.report && !summaryState.report.ok && !summaryState.report.needsLogin) openSummary(summaryState.session, { auto: true });
  });
  window.addEventListener("popstate", () => {
    if (currentScreen === "prenda" && prenda.s) {
      if (prenda.recording) {
        try {
          history.pushState({ vw: "prenda" }, "");
        } catch {
        }
        toast("Se está grabando. Para salir, pulsa primero PARAR GRABACIÓN.", 3500);
      } else leavePrenda();
      return;
    }
    if (!controller.s) return;
    try {
      history.pushState({ vw: "session" }, "");
    } catch {
    }
    if (currentScreen === "gallery") go("session");
    else toast("Para salir, pulsa TERMINAR SESIÓN.", 3e3);
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) location.reload();
  });
  const note = (kind, detail) => {
    const s = controller?.s || prenda?.s;
    if (s) {
      addIncident(s, controller?.s ? controller.clock : null, kind, detail);
      saveSession(s);
    }
  };
  window.addEventListener("error", (e) => note("error_javascript", e.message));
  window.addEventListener("unhandledrejection", (e) => note("error_promesa", e.reason?.message || e.reason));
  await loadSessions().catch(() => {
  });
  go("home");
  sync.start();
  try {
    await auth.init();
  } catch (e) {
    $("auth-status").textContent = e.message;
  }
  renderAuth();
  if (auth.isValid() && !auth.email) {
    try {
      const user = await drive.whoAmI();
      const allowed = CONFIG.ALLOWED_EMAILS.map((x) => x.toLowerCase());
      if (allowed.length && !allowed.includes(user.emailAddress.toLowerCase())) auth.signOut();
      else auth.setEmail(user.emailAddress);
    } catch {
    }
  }
}
main();
