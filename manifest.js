/**
 * Manifiesto de sesión (manifest.json) y resumen legible (resumen_sesion.txt).
 * Pensado para que Claude u otro programa reconstruya la línea temporal: todas las marcas
 * usan elapsed_ms = milisegundos desde el inicio de la sesión, más la hora absoluta.
 */
import { CONFIG } from './config.js';
import { isoLocal, fmtDuration, fmtDateTime } from './util.js';

/** Segmentos de audio que deberían tener archivo completo en Drive y aún no lo tienen */
export const pendingAudioSegments = s => s.segments.filter(g => g.endMs != null && !g.full?.empty && !g.full?.driveId);

export function buildManifest(s, photos) {
  const valid = photos.filter(p => p.status !== 'deleted');
  const deleted = photos.filter(p => p.status === 'deleted');
  const lastKnown = s.startEpoch + Math.max(s.heartbeatMs || 0, ...s.segments.map(g => g.endMs || 0));
  const base = `${CONFIG.ROOT_FOLDER_NAME}/${s.userDir ? s.userDir + '/' : ''}${s.folderName}`;
  const photoOut = p => {
    const isDel = p.status === 'deleted';
    return {
      photo_id: p.id,
      seq: p.seq,
      file_name: p.fileName,
      drive_path: p.driveId ? `${base}/FOTOS/${isDel ? '_ELIMINADAS/' : ''}${p.fileName}` : null,
      drive_file_id: p.driveId || null,
      elapsed_ms: p.elapsedMs,
      captured_at: isoLocal(p.epoch),
      captured_epoch_ms: p.epoch,
      width: p.width, height: p.height, bytes: p.size, mime_type: p.mime,
      capture_method: p.method,
      status: isDel ? 'eliminada' : (p.driveId ? 'guardada_en_drive' : 'pendiente_de_subir'),
      ...(isDel ? { deleted_at: isoLocal(p.deletedAt), was_uploaded: !!p.driveId } : {}),
    };
  };

  const segments = s.segments.map(g => ({
    segment: g.seg,
    mime_type: g.mimeType,
    start_elapsed_ms: g.startMs,
    end_elapsed_ms: g.endMs ?? null,
    start_at: isoLocal(s.startEpoch + g.startMs),
    end_at: g.endMs != null ? isoLocal(s.startEpoch + g.endMs) : null,
    duration_ms: g.endMs != null ? g.endMs - g.startMs : null,
    measured_audio_duration_ms: g.measuredMs ?? null,
    end_reason: g.endReason || 'grabando',
    chunks_recorded: g.chunkCount,
    full_file: g.full?.empty ? { status: 'sin_datos' } : g.full ? {
      file_name: g.full.fileName,
      drive_path: `${base}/AUDIO/${g.full.fileName}`,
      drive_file_id: g.full.driveId || null, bytes: g.full.size || null,
      status: g.full.driveId ? 'guardado_en_drive' : 'pendiente',
    } : { status: g.endMs != null ? 'pendiente' : 'se_genera_al_terminar' },
    parts: (g.parts || []).map(pt => ({
      part: pt.part + 1, file_name: pt.fileName,
      drive_path: `${base}/AUDIO/fragmentos/${pt.fileName}`,
      drive_file_id: pt.driveId || null,
      start_elapsed_ms: pt.startMs, end_elapsed_ms: pt.endMs, bytes: pt.size,
    })),
  }));

  const pendingPhotos = valid.filter(p => !p.driveId).length;
  const pendingAudio = pendingAudioSegments(s).length;

  return {
    schema: 'vinted-workflow/manifest@1',
    app_version: CONFIG.APP_VERSION,
    generated_at: isoLocal(Date.now()),
    session: {
      session_id: s.id,
      folder: base,
      status: s.status === 'finished' ? 'terminada' : s.status === 'finishing' ? 'guardando' : 'en_curso_o_interrumpida',
      start_at: isoLocal(s.startEpoch),
      start_epoch_ms: s.startEpoch,
      end_at: s.endEpoch ? isoLocal(s.endEpoch) : null,
      end_epoch_ms: s.endEpoch || null,
      timezone: s.timezone,
      utc_offset_minutes: s.utcOffsetMin,
      duration_ms: (s.endEpoch || lastKnown) - s.startEpoch,
      google_account: s.accountEmail || null,
    },
    timeline_notes: [
      'elapsed_ms = milisegundos desde el inicio de la sesión (reloj monotónico del navegador).',
      'Para situar un instante dentro de un archivo de audio: posición_en_archivo_ms = elapsed_ms - start_elapsed_ms del segmento que lo contiene.',
      'Los fragmentos (parts) de un segmento, unidos en orden byte a byte, forman exactamente el archivo completo del segmento.',
      'Entre segmentos puede haber huecos sin audio (ver audio.gaps). Precisión esperada de las marcas: ±0,5 s.',
      'measured_audio_duration_ms es la duración real del archivo medida al cerrar la sesión; si difiere de duration_ms en más de unos segundos, las marcas de ese segmento son menos fiables hacia el final.',
    ],
    photos: valid.map(photoOut),
    deleted_photos: deleted.map(photoOut),
    audio: {
      segments,
      gaps: s.gaps.map(g => ({ from_elapsed_ms: g.fromMs, to_elapsed_ms: g.toMs, duration_ms: Math.max(0, g.toMs - g.fromMs), reason: g.reason })),
    },
    storage: {
      all_saved: pendingPhotos === 0 && pendingAudio === 0 && s.status === 'finished',
      verified_against_drive: !!s.verified,
      pending_photos: pendingPhotos,
      pending_audio_files: pendingAudio,
    },
    incidents: s.incidents,
    device: { user_agent: s.userAgent, capture: s.captureInfo || null },
  };
}

export function buildSummaryText(s, photos) {
  const valid = photos.filter(p => p.status !== 'deleted');
  const deleted = photos.filter(p => p.status === 'deleted');
  const dur = (s.endEpoch || Date.now()) - s.startEpoch;
  const audioMs = s.segments.reduce((a, g) => a + ((g.endMs ?? g.startMs) - g.startMs), 0);
  const gapMs = s.gaps.reduce((a, g) => a + Math.max(0, g.toMs - g.fromMs), 0);
  const lines = [
    'VINTED WORKFLOW — RESUMEN DE SESIÓN',
    '====================================',
    `Sesión:        ${s.id}`,
    `Carpeta:       ${CONFIG.ROOT_FOLDER_NAME}/${s.folderName}`,
    `Inicio:        ${fmtDateTime(s.startEpoch)} (${s.timezone})`,
    `Fin:           ${s.endEpoch ? fmtDateTime(s.endEpoch) : '—'}`,
    `Duración:      ${fmtDuration(dur)}`,
    `Fotos válidas: ${valid.length}`,
    `Fotos eliminadas: ${deleted.length}`,
    `Audio grabado: ${fmtDuration(audioMs)} en ${s.segments.length} segmento(s)`,
    `Cortes de audio: ${s.gaps.length} (${fmtDuration(gapMs)} sin grabar)`,
    `Estado: ${s.verified ? 'Todo guardado y comprobado en Drive' : 'Pendiente de comprobar'}`,
    '',
    'LÍNEA TEMPORAL',
    '--------------',
  ];
  const events = [
    ...valid.map(p => ({ t: p.elapsedMs, txt: `Foto ${p.seq}  ${p.fileName}` })),
    ...s.segments.map(g => ({ t: g.startMs, txt: `▶ Audio segmento ${g.seg} empieza` })),
    ...s.segments.filter(g => g.endMs != null).map(g => ({ t: g.endMs, txt: `■ Audio segmento ${g.seg} termina (${g.endReason})` })),
  ].sort((a, b) => a.t - b.t);
  for (const e of events) lines.push(`${fmtDuration(e.t)}  ${e.txt}`);
  if (s.incidents.length) {
    lines.push('', 'INCIDENCIAS', '-----------');
    for (const i of s.incidents) lines.push(`${i.elapsed_ms != null ? fmtDuration(i.elapsed_ms) : '--:--:--'}  ${i.type} ${i.detail}`);
  }
  return lines.join('\n') + '\n';
}

/** Manifiesto de una prenda (modo sencillo): fotos + audios de la misma carpeta. */
export function buildPrendaManifest(s, photos) {
  const valid = photos.filter(p => p.status !== 'deleted').sort((a, b) => (a.order || a.seq) - (b.order || b.seq));
  const audios = s.segments.filter(g => g.endMs != null && !g.full?.empty).sort((a, b) => (a.order || a.seg) - (b.order || b.seg));
  const base = `${CONFIG.ROOT_FOLDER_NAME}/${s.userDir ? s.userDir + '/' : ''}${s.dayFolder}/${s.folderName}`;
  return {
    schema: 'vinted-workflow/prenda@1',
    app_version: CONFIG.APP_VERSION,
    generated_at: isoLocal(Date.now()),
    item: {
      id: s.id,
      number_of_day: s.number,
      tipo: s.tipo === 'resubida' ? 'resubida' : 'nueva',
      tipo_descripcion: s.tipo === 'resubida'
        ? 'RESUBIDA: la prenda ya existe en el sistema. Hay que buscar su anuncio anterior, eliminarlo y volver a publicarla.'
        : 'NUEVA: la prenda nunca se ha subido. Hay que crearla y añadirla a su lote o bala.',
      folder: base,
      status: s.status === 'finished' ? 'guardada' : 'guardando',
      created_at: isoLocal(s.startEpoch),
      saved_at: s.endEpoch ? isoLocal(s.endEpoch) : null,
      timezone: s.timezone,
      utc_offset_minutes: s.utcOffsetMin,
      google_account: s.accountEmail || null,
      uploaded_by: s.userDir || 'propietario',
    },
    notes: [
      'Todas las fotos y todos los audios de esta carpeta pertenecen a UNA sola prenda.',
      'item.tipo indica si la prenda es nueva (crear) o resubida (buscar la anterior, eliminarla y volver a subir). También aparece al final del nombre de la carpeta.',
      'Las fotos se hicieron con la cámara del iPhone; taken_at es la fecha de la foto según sus metadatos (null si no se pudo leer).',
      'Los audios se grabaron después de hacer las fotos: describen la prenda (marca, talla, medidas, defectos, instrucciones).',
    ],
    photos: valid.map(p => ({
      order: p.order || p.seq,
      file_name: p.fileName,
      drive_path: p.driveId ? `${base}/${p.fileName}` : null,
      drive_file_id: p.driveId || null,
      original_name: p.originalName || null,
      taken_at: p.takenAt ? isoLocal(p.takenAt) : null,
      width: p.width, height: p.height, bytes: p.size, mime_type: p.mime,
      status: p.driveId ? 'guardada_en_drive' : 'pendiente_de_subir',
    })),
    audio: audios.map(g => ({
      order: g.order || g.seg,
      file_name: g.fileName,
      drive_path: g.full?.driveId ? `${base}/${g.fileName}` : null,
      drive_file_id: g.full?.driveId || null,
      mime_type: g.mimeType,
      recorded_at: g.recordedAt ? isoLocal(g.recordedAt) : null,
      duration_ms: g.endMs - g.startMs,
      measured_audio_duration_ms: g.measuredMs ?? null,
      bytes: g.full?.size || g.bytes || null,
      end_reason: g.endReason === 'usuario' ? 'detenido_por_el_usuario' : g.endReason,
      status: g.full?.driveId ? 'guardado_en_drive' : 'pendiente_de_subir',
    })),
    storage: {
      all_saved: valid.every(p => p.driveId) && audios.every(g => g.full?.driveId) && s.status === 'finished',
      verified_against_drive: !!s.verified,
    },
    incidents: s.incidents,
    device: { user_agent: s.userAgent },
  };
}
