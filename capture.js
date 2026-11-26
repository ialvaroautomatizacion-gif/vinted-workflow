/**
 * Captura de cámara y micrófono con UNA sola llamada a getUserMedia
 * (en iOS, una segunda llamada silencia las pistas de la primera).
 *
 * Fotos:
 *  - 'takephoto': ImageCapture.takePhoto() → foto completa del sensor, sin cerrar la cámara (si el iPhone lo soporta).
 *  - 'frame':     fotograma de la vista previa (hasta 4K) dibujado en un canvas.
 */
import { CONFIG } from './config.js';

export function capabilities() {
  return {
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    imageCapture: typeof ImageCapture !== 'undefined' && 'takePhoto' in (ImageCapture.prototype || {}),
    wakeLock: 'wakeLock' in navigator,
  };
}

/** Cámaras disponibles (los nombres solo aparecen después de haber dado permiso de cámara). */
export async function listCameras() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter(d => d.kind === 'videoinput' && d.label).map(d => ({ id: d.deviceId, label: d.label }));
  } catch { return []; }
}

export class Capture {
  /**
   * @param {HTMLVideoElement} videoEl
   * @param {object} o { photoMode: 'auto'|'frame', quality: 'high'|'normal', deviceId, onTrackEvent(kind, ev) }
   */
  constructor(videoEl, { photoMode = 'auto', quality = 'high', deviceId = '', onTrackEvent = () => {} } = {}) {
    this.video = videoEl;
    this.requestedMode = photoMode;
    this.quality = quality;
    this.deviceId = deviceId;
    this.onTrackEvent = onTrackEvent;
    this.stream = null;
    this.imageCapture = null;
    this.mode = 'frame';
    this.takePhotoFailures = 0;
    this.zoomSteps = [];
    this.zoomIndex = 0;
    this.torchOn = false;
  }

  get audioTrack() { return this.stream?.getAudioTracks()[0] || null; }
  get videoTrack() { return this.stream?.getVideoTracks()[0] || null; }

  async start() {
    const useTakePhoto = this.requestedMode !== 'frame' && capabilities().imageCapture;
    const [fw, fh] = this.quality === 'normal' ? CONFIG.FRAME_NORMAL : CONFIG.FRAME_HIGH;
    const w = useTakePhoto ? CONFIG.PREVIEW_WIDTH : fw;
    const h = useTakePhoto ? CONFIG.PREVIEW_HEIGHT : fh;
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const size = { width: { ideal: w }, height: { ideal: h } };
    try {
      const video = this.deviceId ? { deviceId: { exact: this.deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size };
      this.stream = await navigator.mediaDevices.getUserMedia({ audio, video });
    } catch (e) {
      // La cámara elegida ya no existe o no admite esa resolución: usar la trasera por defecto
      if (e?.name !== 'OverconstrainedError' && e?.name !== 'NotFoundError') throw e;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: { facingMode: { ideal: 'environment' } } });
    }
    if (!this.audioTrack || !this.videoTrack) {
      this.stop();
      throw new Error('El navegador no ha entregado cámara y micrófono a la vez');
    }
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.ensurePlaying();

    this.mode = 'frame';
    if (useTakePhoto) {
      try { this.imageCapture = new ImageCapture(this.videoTrack); this.mode = 'takephoto'; }
      catch { this.imageCapture = null; }
    }

    for (const t of this.stream.getTracks()) {
      t.addEventListener('ended', () => this.onTrackEvent(t.kind, 'ended'));
      t.addEventListener('mute', () => this.onTrackEvent(t.kind, 'mute'));
      t.addEventListener('unmute', () => this.onTrackEvent(t.kind, 'unmute'));
    }
    this.setupZoom();
    return this.stream;
  }

  /** Intenta que la vista previa se esté reproduciendo. Devuelve true si lo consigue. */
  async ensurePlaying() {
    try { if (this.video.paused) await this.video.play(); } catch { /* iOS puede exigir un toque */ }
    return !this.video.paused;
  }

  get previewPlaying() { return !!this.stream && !this.video.paused && this.video.readyState >= 2; }

  // ---------- Zoom y linterna (solo si el dispositivo los ofrece) ----------
  setupZoom() {
    this.zoomSteps = []; this.zoomIndex = 0;
    try {
      const caps = this.videoTrack.getCapabilities?.() || {};
      this.hasTorch = !!caps.torch;
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        const cur = this.videoTrack.getSettings?.().zoom || caps.zoom.min;
        const steps = [cur, cur * 2, cur * 3].filter(z => z <= caps.zoom.max + 0.001);
        if (steps.length > 1) this.zoomSteps = steps;
      }
    } catch { /* sin zoom */ }
  }

  get zoomLabel() {
    if (!this.zoomSteps.length) return null;
    return `${Math.round((this.zoomSteps[this.zoomIndex] / this.zoomSteps[0]) * 10) / 10}×`;
  }

  async cycleZoom() {
    if (!this.zoomSteps.length) return null;
    const next = (this.zoomIndex + 1) % this.zoomSteps.length;
    try {
      await this.videoTrack.applyConstraints({ advanced: [{ zoom: this.zoomSteps[next] }] });
      this.zoomIndex = next;
    } catch (e) { this.onTrackEvent('video', 'zoom_error: ' + (e?.message || e)); }
    return this.zoomLabel;
  }

  async toggleTorch() {
    if (!this.hasTorch) return false;
    try {
      await this.videoTrack.applyConstraints({ advanced: [{ torch: !this.torchOn }] });
      this.torchOn = !this.torchOn;
    } catch (e) { this.onTrackEvent('video', 'linterna_error: ' + (e?.message || e)); }
    return this.torchOn;
  }

  info() {
    const s = this.videoTrack?.getSettings?.() || {};
    return { mode: this.mode, quality: this.quality, width: s.width, height: s.height, frameRate: s.frameRate, facing: s.facingMode, camera: this.videoTrack?.label || null, microphone: this.audioTrack?.label || null };
  }

  healthy() {
    const a = this.audioTrack, v = this.videoTrack;
    return {
      audio: !!a && a.readyState === 'live' && !a.muted,
      video: !!v && v.readyState === 'live' && !v.muted,
      audioLive: !!a && a.readyState === 'live',
    };
  }

  /** Devuelve { blob, width, height, method } */
  async takePhoto() {
    if (this.mode === 'takephoto' && this.imageCapture) {
      try {
        const blob = await withTimeout(this.imageCapture.takePhoto(), 8000, 'takePhoto no responde');
        if (!blob || !blob.size) throw new Error('foto vacía');
        this.takePhotoFailures = 0;
        const dims = await imageSize(blob);
        return { blob, ...dims, method: 'takePhoto' };
      } catch (e) {
        this.takePhotoFailures++;
        this.onTrackEvent('video', 'takephoto_error: ' + (e?.message || e));
        if (this.takePhotoFailures >= 2) { this.mode = 'frame'; this.onTrackEvent('video', 'takephoto_desactivado_se_usa_fotograma'); }
      }
    }
    return this.grabFrame();
  }

  async grabFrame() {
    const v = this.video;
    if (v.paused) await this.ensurePlaying();
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h || v.readyState < 2) throw new Error('La cámara todavía no muestra imagen');
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    const blob = await new Promise((res, rej) => c.toBlob(b => b && b.size ? res(b) : rej(new Error('No se pudo crear la foto')), 'image/jpeg', CONFIG.JPEG_QUALITY));
    c.width = c.height = 0; // liberar memoria (importante en iOS)
    return { blob, width: w, height: h, method: 'frame' };
  }

  stop() {
    this.stream?.getTracks().forEach(t => { try { t.stop(); } catch { /* */ } });
    if (this.video.srcObject === this.stream) this.video.srcObject = null;
    this.stream = null;
    this.imageCapture = null;
  }
}

function withTimeout(promise, ms, msg) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
}

export async function imageSize(blob) {
  try { const img = await loadImage(blob); return { width: img.naturalWidth, height: img.naturalHeight }; }
  catch { return { width: null, height: null }; }
}

/** Miniatura JPEG pequeña para la galería (se guarda en el móvil). Nunca lanza error: devuelve null si no puede. */
export async function makeThumb(blob, size = CONFIG.THUMB_SIZE) {
  try {
    const img = await loadImage(blob);
    const r = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * r)); c.height = Math.max(1, Math.round(img.naturalHeight * r));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const t = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.7));
    c.width = c.height = 0;
    return t;
  } catch { return null; }
}

/** Medidor de nivel del micrófono (solo visual). Si falla, la grabación no se ve afectada. */
export class LevelMeter {
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
    } catch (e) { console.warn('Medidor no disponible', e); }
  }
  /** Llamar dentro de un toque: iOS solo deja activar el análisis de audio tras un gesto. */
  nudge() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }
  get running() { return this.ctx?.state === 'running'; }
  tick() {
    if (!this.an) return;
    if (this.ctx.state !== 'running') { this.onLevel(null); return; }
    this.an.getByteTimeDomainData(this.buf);
    let peak = 0;
    for (const v of this.buf) peak = Math.max(peak, Math.abs(v - 128));
    this.onLevel(Math.min(1, peak / 64));
  }
  stop() { clearInterval(this.timer); try { this.ctx?.close(); } catch { /* */ } }
}
