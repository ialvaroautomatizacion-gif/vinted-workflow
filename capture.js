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

export class Capture {
  constructor(videoEl, { photoMode = 'auto', onTrackEvent = () => {} } = {}) {
    this.video = videoEl;
    this.requestedMode = photoMode;
    this.onTrackEvent = onTrackEvent;
    this.stream = null;
    this.imageCapture = null;
    this.mode = 'frame';
  }

  get audioTrack() { return this.stream?.getAudioTracks()[0] || null; }
  get videoTrack() { return this.stream?.getVideoTracks()[0] || null; }

  async start() {
    const useTakePhoto = this.requestedMode !== 'frame' && capabilities().imageCapture;
    const w = useTakePhoto ? CONFIG.PREVIEW_WIDTH : CONFIG.FRAME_WIDTH;
    const h = useTakePhoto ? CONFIG.PREVIEW_HEIGHT : CONFIG.FRAME_HEIGHT;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { facingMode: { ideal: 'environment' }, width: { ideal: w }, height: { ideal: h } },
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    try { await this.video.play(); } catch { /* iOS a veces requiere otro toque; la vista se reanuda sola */ }

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
    return this.stream;
  }

  info() {
    const s = this.videoTrack?.getSettings?.() || {};
    return { mode: this.mode, width: s.width, height: s.height, facing: s.facingMode, deviceLabel: this.videoTrack?.label };
  }

  healthy() {
    const a = this.audioTrack, v = this.videoTrack;
    return {
      audio: !!a && a.readyState === 'live' && !a.muted,
      video: !!v && v.readyState === 'live' && !v.muted,
    };
  }

  /** Devuelve { blob, width, height, method } */
  async takePhoto() {
    if (this.mode === 'takephoto' && this.imageCapture) {
      try {
        const blob = await this.imageCapture.takePhoto();
        const dims = await imageSize(blob);
        return { blob, ...dims, method: 'takePhoto' };
      } catch (e) {
        console.warn('takePhoto falló, uso fotograma', e);
        this.onTrackEvent('video', 'takephoto_error: ' + (e?.message || e));
      }
    }
    return this.grabFrame();
  }

  async grabFrame() {
    const v = this.video;
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) throw new Error('La cámara todavía no muestra imagen');
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    const blob = await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('No se pudo crear la foto')), 'image/jpeg', CONFIG.JPEG_QUALITY));
    c.width = c.height = 0; // liberar memoria (importante en iOS)
    return { blob, width: w, height: h, method: 'frame' };
  }

  stop() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.video.srcObject = null;
    this.stream = null;
    this.imageCapture = null;
  }
}

async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export async function imageSize(blob) {
  try { const img = await loadImage(blob); return { width: img.naturalWidth, height: img.naturalHeight }; }
  catch { return { width: null, height: null }; }
}

/** Miniatura JPEG pequeña para la galería (se guarda en el móvil). */
export async function makeThumb(blob, size = CONFIG.THUMB_SIZE) {
  const img = await loadImage(blob);
  const r = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * r); c.height = Math.round(img.naturalHeight * r);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const t = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.7));
  c.width = c.height = 0;
  return t;
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
  tick() {
    if (!this.an) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.an.getByteTimeDomainData(this.buf);
    let peak = 0;
    for (const v of this.buf) peak = Math.max(peak, Math.abs(v - 128));
    this.onLevel(Math.min(1, peak / 64));
  }
  stop() { clearInterval(this.timer); try { this.ctx?.close(); } catch { /* */ } }
}
