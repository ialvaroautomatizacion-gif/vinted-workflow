# Vinted Workflow — versión 0.2.0

Aplicación web para iPhone (Safari). La cámara se queda abierta, puedes hacer todas las fotos que quieras y el micrófono graba sin parar desde **EMPEZAR SESIÓN** hasta **TERMINAR SESIÓN**. Todo se guarda en tu Google Drive, con una carpeta por sesión.

**Enlace de la app:** https://ialvaroautomatizacion-gif.github.io/vinted-workflow/

## Cómo funciona

```
iPhone (Safari) ── página estática (GitHub Pages, HTTPS)
   │  cámara + micrófono (getUserMedia)  → fotos y audio
   │  guardado inmediato en el móvil (IndexedDB)
   └─ inicio de sesión oficial de Google (permiso drive.file)
        └─ subida directa a TU Google Drive:
           VINTED_WORKFLOW/SESION_AAAA-MM-DD_HHMMSS/
             FOTOS/            foto_0001_t00-01-23.456.jpg …
             FOTOS/_ELIMINADAS las fotos que borraste (no cuentan)
             AUDIO/            audio_seg01_completo_….webm (o .m4a)
             AUDIO/fragmentos/ trozos de 1 min (copia de seguridad progresiva)
             manifest.json     línea temporal completa para Claude
             resumen_sesion.txt
```

**Por qué no se usa Apps Script:** Google bloquea la cámara y el micrófono dentro de las web apps de Apps Script, y su propia documentación recomienda alojar esa parte fuera. No hace falta servidor propio: la página habla directamente con Drive usando tu cuenta.

## Seguridad: qué protege qué

| Riesgo | Protección |
|---|---|
| Que otra persona use la app con su cuenta | La app de Google Cloud está en modo **Prueba** y solo pueden entrar los **usuarios de prueba**. Además, `ALLOWED_EMAILS` (en `config.js`) hace que la página rechace cualquier otra cuenta. |
| Que la app toque otros archivos de tu Drive | Permiso **drive.file**: la app solo ve y modifica los archivos que ella misma ha creado. |
| Enlaces públicos | La app no comparte nada. Los archivos son privados de tu cuenta. |
| Claves en el código | No hay ninguna. El *Client ID* no es secreto: Google solo lo acepta desde el dominio autorizado. |
| Código ajeno inyectado | Política de seguridad (CSP): solo se ejecuta el código propio y el de accounts.google.com. |
| Borrados | La app **nunca borra nada por su cuenta**. Una foto eliminada se mueve a `FOTOS/_ELIMINADAS`. Una sesión solo se elimina si pulsas **Eliminar** y confirmas; su carpeta va a la papelera de Drive, donde Google la guarda 30 días. En el móvil solo se libera espacio después de comprobar que cada archivo está en Drive con el tamaño correcto. |

El código de la página es visible en GitHub (GitHub Pages gratis exige repositorio público), pero no contiene datos ni secretos. Para retirar el acceso de la app a tu cuenta: https://myaccount.google.com/permissions

## Configuración ya hecha

- **Google Cloud**, proyecto `vinted-workflow`: API de Drive activada; pantalla de consentimiento en modo Prueba; usuario de prueba `ialvaroautomatizacion@gmail.com`; permiso `drive.file`; cliente OAuth web con origen `https://ialvaroautomatizacion-gif.github.io`.
- **GitHub Pages**: rama `main`, carpeta raíz.

**Para añadir otro correo** (por ejemplo, el correo dedicado): añádelo en Google Cloud › Google Auth Platform › Público › Usuarios de prueba, y en `ALLOWED_EMAILS` de `config.js`; después hay que regenerar `bundle.js` (ver "Cambiar el código").

Dos cosas normales en modo Prueba: al entrar, Google avisa de que "no ha verificado esta app" (pulsa *Continuar*) y vuelve a pedir el permiso cada 7 días.

## Uso en el iPhone

1. Abre el enlace en **Safari** (no dentro de WhatsApp, Gmail u otra app).
2. **Entrar con Google** → *Continuar* → deja marcada la casilla de acceso a los archivos de Drive.
3. **EMPEZAR SESIÓN** → *Permitir* cámara y micrófono.
4. Trabaja: **HACER FOTO** cuando quieras, y habla con normalidad. La miniatura de la izquierda abre la galería, donde puedes revisar y eliminar fotos; el audio sigue grabando.
5. **TERMINAR SESIÓN** → espera a ver "Sesión guardada" con todas las comprobaciones en ✅.

Consejos: móvil enchufado, wifi, y no salir de Safari durante la sesión.

### Indicadores de la pantalla de sesión

- **● REC + cronómetro**: sesión activa. Si se pone rojo fijo, la grabación está interrumpida.
- **🎙 + barra**: nivel del micrófono. Si la barra parpadea en gris, iOS aún no deja medir el nivel (se activa al tocar la pantalla); la grabación no depende de ella.
- **☁︎ + número**: archivos pendientes de subir. En naranja = subida en pausa (sin cobertura o acceso de Google caducado). No se pierde nada: se sube al terminar.
- **1× / 🔦**: zoom y linterna, solo si el iPhone los ofrece a Safari.

### Ajustes (en la pantalla inicial)

- **Fotos**: automático (foto completa si Safari admite `takePhoto()`, si no fotograma) o siempre fotograma.
- **Calidad**: 4K o 1080p (menos batería y calor).
- **Cámara**: tras la primera sesión aparecen las cámaras del iPhone, por si prefieres otra lente.
- **Formato del audio**: automático (WebM/Opus si está disponible) o M4A.
- **Este dispositivo**: lo que admite tu iPhone. Útil para diagnosticar.

## Qué pasa si algo falla

| Situación | Qué hace la app |
|---|---|
| Sin cobertura | Guarda en el móvil y sube sola al volver la conexión. Si ocurre al terminar, la pantalla final espera y reintenta sola. |
| Llamada, bloqueo, cambio de app | iOS para cámara y micro. Al volver, la app reanuda sola (o pide un toque) en un segmento de audio nuevo. El corte queda anotado en el manifiesto. |
| iOS silencia el micrófono un momento | Cierra el segmento de audio y abre otro al volver el sonido, para que fotos y audio sigan cuadrando. |
| El grabador deja de entregar audio | Un vigilante lo detecta en 16 s y reinicia la captura. |
| Safari se cierra o se recarga la página | Al abrir la app sale **Sesión sin terminar → REANUDAR** (o *Terminar y guardar*), con las fotos y el cronómetro de antes. Se pierden como mucho los ~5 s de audio que no se habían guardado. |
| Pasa 1 h desde que entraste con Google | Google caduca el acceso cada hora. La subida se pausa, todo sigue guardándose en el móvil, y al terminar pulsas *Conectar con Google y subir*. |
| Drive devuelve errores pasajeros | Reintenta sola, sin duplicar archivos. |
| Alguien borra o manda a la papelera la carpeta de la sesión antes de terminar | Al cerrar la sesión se detecta, se crea de nuevo y se vuelven a subir los archivos desde el móvil. |
| Se borran los datos de Safari o se pierde el móvil antes de subir | Se pierde lo que no estuviera ya en Drive. Por eso se sube durante la sesión. |

## Comprobaciones al terminar

La pantalla final solo dice "Sesión guardada" si: (1) cada foto válida existe en Drive con su tamaño exacto, (2) cada fragmento y cada archivo completo de audio existe con su tamaño exacto, (3) el manifiesto y el resumen están subidos. Además mide la **duración real** de cada audio y avisa (⚠️) si no coincide con el tiempo grabado: es la forma de detectar un fallo de grabación de iOS.

## Cómo encajan audio y fotos (para Claude)

- Cada foto tiene `elapsed_ms`: milisegundos desde el inicio de la sesión, medidos en el instante del toque.
- Cada segmento de audio tiene `start_elapsed_ms`. Un instante T de la sesión está en el segundo `(T − start_elapsed_ms)/1000` de ese archivo.
- Normalmente hay **un único segmento**. Solo se abre otro si algo interrumpe la grabación, y el hueco queda en `audio.gaps` con su motivo.
- Los fragmentos de `AUDIO/fragmentos/`, unidos en orden, son idénticos byte a byte al archivo completo (`cat seg01_parte*.webm > seg01.webm`).
- `measured_audio_duration_ms` es la duración real del archivo; `incidents` es el registro técnico de todo lo ocurrido.

## Prueba de aceptación (30 minutos, iPhone 13 Pro + Safari)

| Min | Qué haces | Qué dices en voz alta |
|---|---|---|
| 0 | EMPEZAR SESIÓN | "Empieza la prueba" |
| 1 | Foto | "Foto uno", justo al pulsar |
| 3 | Foto | "Foto dos" |
| 4–9 | Nada (silencio 5 min) | — |
| 9 | Foto | "Foto tres" |
| 10 | Galería → elimina la foto dos | "He borrado la dos" |
| 12–20 | Una foto cada 2 min | "Foto cuatro", "Foto cinco"… |
| 20 | Sal a la pantalla de inicio del iPhone 10 s y vuelve a Safari | "Vuelvo de la interrupción" |
| 21–30 | Fotos sueltas, habla con normalidad | Describe una prenda inventada |
| 30+ | TERMINAR SESIÓN | — |

Debe pasar: cronómetro y REC activos todo el rato; al volver en el minuto 20 la grabación sigue o se reanuda; pantalla final con todo en ✅ (un ⚠️ por el corte del minuto 20 es normal).

Después envía: captura de *Ajustes › Este dispositivo*, captura de la pantalla final con *Diagnóstico* abierto, y el nombre de la carpeta de la sesión.

## Limitaciones conocidas

1. **La cámara nativa de iOS no se puede dejar abierta desde una web.** Por eso la cámara va integrada en la app.
2. **Calidad de foto:** foto completa del sensor si Safari admite `takePhoto()`; si no, fotograma de hasta 4K (8 MP), sin el procesado HDR de la app Cámara.
3. **Safari delante y pantalla encendida.** La app evita el bloqueo automático, pero si sales de Safari iOS corta la cámara y quizá el micro.
4. **Acceso de Google de 1 hora.** En sesiones más largas la subida se completa al terminar, con un toque.
5. **Batería y calor:** una hora de cámara activa consume mucho. Con calor, usa calidad 1080p.
6. **Precisión temporal:** ±0,5 s entre la foto y el audio.
7. **La lista de sesiones anteriores es la de este móvil.** Las carpetas de Drive siguen ahí aunque cambies de móvil o borres los datos de Safari.
8. **La integración con Claude** llega en la fase siguiente.

## Archivos

```
index.html     pantallas (inicio, sesión, galería, resumen)
app.css        estilos
bundle.js      ← lo que carga la página: todos los módulos unidos en un archivo (generado)
config.js      Client ID, correos autorizados y parámetros
app.js         interfaz y navegación
session.js     sesión: inicio, fotos, interrupciones, reanudación, fin
capture.js     cámara + micrófono, fotos, zoom, miniaturas, medidor de nivel
audio.js       grabación continua por segmentos
sync.js        subida a Drive, reintentos, comprobación final, eliminación manual
drive.js       llamadas a la API de Drive (sin duplicados)
auth.js        inicio de sesión de Google (drive.file)
manifest.js    manifest.json y resumen_sesion.txt
store.js       estado de sesiones y fotos
db.js          almacenamiento local (IndexedDB)
util.js        reloj de sesión, formatos, medición de audio
```

## Cambiar el código

La página carga `bundle.js`, que se genera a partir de los módulos (así el iPhone nunca mezcla archivos de versiones distintas):

```
npm install esbuild
npx esbuild app.js --bundle --format=esm --target=safari15 --charset=utf8 --outfile=bundle.js
```

Al publicar una versión nueva, sube el número en `config.js` (`APP_VERSION`) y en las dos referencias `?v=` de `index.html`. La versión se ve bajo el título de la app.
