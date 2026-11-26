/**
 * Configuración de Vinted Workflow.
 * Lo ÚNICO que tienes que cambiar es CLIENT_ID (ver README, paso 1).
 * El Client ID no es un secreto: Google solo lo acepta desde el dominio autorizado
 * y solo para las cuentas que hayas añadido como usuarios de prueba.
 */
export const CONFIG = {
  APP_VERSION: '0.1.0-prototipo',

  // ID de cliente OAuth (tipo "Aplicación web") de tu proyecto de Google Cloud.
  CLIENT_ID: '34737536696-u8js6hqusljsbs5v5b4i424b3ejuhto2.apps.googleusercontent.com',

  // Opcional: correos autorizados. Si la lista no está vacía y entras con otra cuenta,
  // la app se niega a trabajar (capa extra; la protección real es la de Google, ver README).
  ALLOWED_EMAILS: ['ialvaroautomatizacion@gmail.com'],

  // Permiso mínimo: la app solo ve y modifica los archivos que ella misma crea.
  SCOPE: 'https://www.googleapis.com/auth/drive.file',

  ROOT_FOLDER_NAME: 'VINTED_WORKFLOW',

  // Audio: el grabador entrega un trozo cada AUDIO_TIMESLICE_MS (se guarda al momento en el móvil).
  // Cada AUDIO_CHUNKS_PER_PART trozos se sube un fragmento a Drive (12 x 5 s = 1 minuto).
  AUDIO_TIMESLICE_MS: 5000,
  AUDIO_CHUNKS_PER_PART: 12,
  AUDIO_BITRATE: 64000,

  // Cámara
  PREVIEW_WIDTH: 1920, PREVIEW_HEIGHT: 1080,      // cuando las fotos salen de takePhoto()
  FRAME_WIDTH: 3840, FRAME_HEIGHT: 2160,          // cuando las fotos salen de un fotograma
  JPEG_QUALITY: 0.92,
  THUMB_SIZE: 320,

  // Sincronización
  SYNC_INTERVAL_MS: 5000,
  TOKEN_MIN_MINUTES_TO_START: 45,   // al empezar sesión, pedir renovar si quedan menos minutos de acceso
};
