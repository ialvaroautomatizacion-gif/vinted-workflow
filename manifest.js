/**
 * Manifiesto de sesión (manifest.json) y resumen legible (resumen_sesion.txt).
 * Pensado para que Claude u otro programa reconstruya la línea temporal: todas las marcas
 * usan elapsed_ms = milisegundos desde el inicio de la sesión, más la hora absoluta.
 */
import { CONFIG } from './config.js';
import { isoLocal, fmtDuration, fmtDateTime } from './util.js';

export function buildManifest(s, photos) {
  const valid = photos.filter(p => p.status !== 'deleted');
  const deleted = photos.filter(p => p.status === 'deleted');
  const endEpoch = s.endEpoch || (s.startEpoch + (s.heartbeatMs || 0));
  const photoOut = p => ({
    photo_id: p.id,
    seq: p.seq,
    file_name: p.fileName,
    drive_path: `${CONFIG.ROOT_FOLDER_NAME}/${s.folderName}/FOTOS/${p.status === 'deleted' ? '_ELIMINADAS/' : ''}${p.fileName}`,
    drive_file_id: p.driveId || null,
    elapsed_ms: p.elapsedMs,
    captured_at: isoLocal(p.epoch),
    captured_epoch_ms: p.epoch,
    width: p.width, height: p.height, bytes: p.size, mime_type: p.mime,
    capture_method: p.method,
    status: p.status === 'deleted' ? 'eliminada' : (p.driveId ? 'guardada_en_drive' : 'pendiente_de_subir'),
    ...(p.status === 'deleted' ? { deleted_at: isoLocal(p.deletedAt) } : {}),
  });

  const segments = s.segments.map(g => ({
    segment: g.seg,
    mime_type: g.mimeType,
    start_elapsed_ms: g.startMs,
    end_elapsed_ms: g.endMs ?? null,
    start_at: isoLocal(s.startEpoch + g.startMs),
    end_at: g.endMs != null ? isoLocal(s.startEpoch + g.endMs) : null,
    duration_ms: g.endMs != null ? g.endMs - g.startMs : null,
    end_reason: g.endReason || 'grabando',
    chunks_recorded: g.chunkCount,
    full_file: g.full ? {
      file_name: g.full.fileName,
      drive_path: `${CONFIG.ROOT_FOLDER_NAME}/${s.folderName}/AUDIO/${g.full.fileName}`,
      drive_file_id: g.full.driveId || null, bytes: g.full.size || null,
      status: g.full.driveId ? 'guardado_en_drive' : 'pendiente',
    } : { status: g.endMs != null ? 'pendiente' : 'se_genera_al_terminar' },
    parts: (g.parts || []).map(pt => ({
      part: pt.part + 1, file_name: pt.fileName,
      drive_path: `${CONFIG.ROOT_FOLDER_NAME}/${s.folderName}/AUDIO/fragmentos/${pt.fileName}`,
      drive_file_id: pt.driveId || null,
      start_elapsed_ms: pt.startMs, end_elapsed_ms: pt.endMs, bytes: pt.size,
    })),
  }));

  const pendingPhotos = valid.filter(p => !p.driveId).length;
  const pendingAudio = s.segments.filter(g => g.endMs != null && !g.full?.driveId).length;

  return {
    schema: 'vinted-workflow/manifest@1',
    app_version: CONFIG.APP_VERSION,
    generated_at: isoLocal(Date.now()),
    session: {
      session_id: s.id,
      folder: `${CONFIG.ROOT_FOLDER_NAME}/${s.folderName}`,
      status: s.status === 'finished' ? 'terminada' : s.status === 'finishing' ? 'guardando' : 'en_curso_o_interrumpida',
      start_at: isoLocal(s.startEpoch),
      start_epoch_ms: s.startEpoch,
      end_at: s.endEpoch ? isoLocal(s.endEpoch) : null,
      end_epoch_ms: s.endEpoch || null,
      timezone: s.timezone,
      utc_offset_minutes: s.utcOffsetMin,
      duration_ms: s.endEpoch ? s.endEpoch - s.startEpoch : endEpoch - s.startEpoch,
    },
    timeline_notes: [
      'elapsed_ms = milisegundos desde el inicio de la sesión (reloj monotónico del navegador; se re-ancla con la hora del sistema solo si la página se recargó).',
      'Para situar un instante dentro de un archivo de audio: posición_en_archivo_ms = elapsed_ms - start_elapsed_ms del segmento.',
      'Los fragmentos (parts) de un segmento, unidos en orden byte a byte, forman exactamente el archivo completo del segmento.',
      'Entre segmentos puede haber huecos sin audio (ver audio.gaps). Precisión esperada de las marcas: ±0,5 s.',
    ],
    photos: valid.map(photoOut),
    deleted_photos: deleted.map(photoOut),
    audio: {
      segments,
      gaps: s.gaps.map(g => ({ from_elapsed_ms: g.fromMs, to_elapsed_ms: g.toMs, duration_ms: g.toMs - g.fromMs, reason: g.reason })),
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
  const gapMs = s.gaps.reduce((a, g) => a + (g.toMs - g.fromMs), 0);
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
    `Huecos sin audio: ${s.gaps.length} (${fmtDuration(gapMs)})`,
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
