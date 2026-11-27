/**
 * Configuración de Vinted Workflow.
 * El Client ID no es un secreto: Google solo lo acepta desde el dominio autorizado
 * y solo para las cuentas añadidas como usuarios de prueba en Google Cloud.
 */
export const CONFIG = {
  APP_VERSION: '0.6.0',

  // ID de cliente OAuth (tipo "Aplicación web") del proyecto de Google Cloud "vinted-workflow".
  CLIENT_ID: '34737536696-u8js6hqusljsbs5v5b4i424b3ejuhto2.apps.googleusercontent.com',

  // Correos autorizados. Si entras con otra cuenta, la app se niega a trabajar
  // (capa extra; la protección real es la de Google: modo Prueba + usuarios de prueba).
  ALLOWED_EMAILS: ['ialvaroautomatizacion@gmail.com'],

  // Permiso mínimo: la app solo ve y modifica los archivos que ella misma crea.
  SCOPE: 'https://www.googleapis.com/auth/drive.file',

  ROOT_FOLDER_NAME: 'VINTED_WORKFLOW',

  // Audio: el grabador entrega un trozo cada AUDIO_TIMESLICE_MS (se guarda al momento en el móvil).
  // Cada AUDIO_CHUNKS_PER_PART trozos se sube un fragmento a Drive (12 x 5 s = 1 minuto).
  AUDIO_TIMESLICE_MS: 5000,
  AUDIO_CHUNKS_PER_PART: 12,
  AUDIO_BITRATE: 64000,
  // Si no llega ningún trozo de audio en este tiempo, se considera que el grabador se ha parado y se reinicia.
  AUDIO_WATCHDOG_MS: 16000,

  // Cámara
  PREVIEW_WIDTH: 1920, PREVIEW_HEIGHT: 1080,      // vista previa cuando las fotos salen de takePhoto()
  FRAME_HIGH: [3840, 2160],                       // fotos por fotograma, calidad alta (4K)
  FRAME_NORMAL: [1920, 1080],                     // fotos por fotograma, calidad normal (menos batería y calor)
  JPEG_QUALITY: 0.92,
  THUMB_SIZE: 320,

  // Sincronización
  SYNC_INTERVAL_MS: 5000,
  TOKEN_MIN_MINUTES_TO_START: 45,   // al empezar sesión, pedir renovar si quedan menos minutos de acceso
  LOW_SPACE_BYTES: 600 * 1024 * 1024,
};
