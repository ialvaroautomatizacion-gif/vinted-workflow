# Vinted Workflow — prototipo 0.1

Aplicación web para iPhone (Safari). La cámara se queda abierta, puedes hacer todas las fotos que quieras y el micrófono graba sin parar desde **EMPEZAR SESIÓN** hasta **TERMINAR SESIÓN**. Todo se guarda en tu Google Drive, con una carpeta por sesión.

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
             AUDIO/            audio_seg01_completo_….webm/.m4a
             AUDIO/fragmentos/ trozos de 1 min (copia de seguridad progresiva)
             manifest.json     línea temporal completa para Claude
             resumen_sesion.txt
```

**Por qué no se usa Apps Script:** Google bloquea la cámara y el micrófono dentro de las web apps de Apps Script, y su propia documentación recomienda alojar esa parte fuera. No hace falta servidor propio ni Apps Script: la página habla directamente con Drive usando tu cuenta.

## Seguridad: qué protege qué

| Riesgo | Protección |
|---|---|
| Que otra persona use la app con su cuenta | La app de Google Cloud está en modo **Prueba** y solo pueden entrar los **usuarios de prueba** que añadas. Además, `ALLOWED_EMAILS` hace que la página rechace cualquier otra cuenta. |
| Que la app toque otros archivos de tu Drive | Permiso **drive.file**: la app solo ve y modifica los archivos que ella misma ha creado. No puede leer ni borrar nada más. |
| Enlaces públicos | La app no comparte nada. Los archivos son privados de tu cuenta. |
| Claves en el código | No hay ninguna. El *Client ID* no es secreto: Google solo lo acepta desde tu dominio autorizado. |
| Código malicioso inyectado | Hay una política de seguridad (CSP) que solo permite el código propio y el de accounts.google.com. |
| Borrados | La app **nunca borra nada de Drive**. Una foto eliminada se mueve a `FOTOS/_ELIMINADAS`. En el móvil solo se libera espacio después de comprobar que cada archivo está en Drive con el tamaño correcto. |

El código de la página es visible en GitHub (GitHub Pages gratis necesita un repositorio público), pero no contiene datos ni secretos. Para retirar el acceso en cualquier momento: https://myaccount.google.com/permissions

---

## Paso 1 — Google Cloud (unos 10 minutos)

Entra en https://console.cloud.google.com con la cuenta cuyo Drive vas a usar.

1. **Crea un proyecto:** selector de proyecto → *Proyecto nuevo* → nombre `vinted-workflow` → Crear.
2. **Activa la API de Drive:** *APIs y servicios › Biblioteca* → busca **Google Drive API** → *Habilitar*.
3. **Configura la pantalla de consentimiento:** *Google Auth Platform* (o *APIs y servicios › Pantalla de consentimiento de OAuth*) → *Comenzar*.
   - Nombre de la app: `Vinted Workflow`. Correo de asistencia: el tuyo.
   - Público: **Externo**.
   - Datos de contacto: el tuyo → Crear.
4. **Público / Audience:** comprueba que el estado de publicación es **Prueba** (*Testing*). **No pulses "Publicar".** En *Usuarios de prueba* → *Add users* → escribe tu correo actual (y más adelante el correo dedicado).
5. **Acceso a datos / Data access:** *Agregar o quitar permisos* → marca `.../auth/drive.file` → Actualizar → Guardar.
6. **Clientes / Credenciales:** *Crear cliente* → tipo **Aplicación web** → nombre `vinted-workflow-web`.
   - *Orígenes autorizados de JavaScript* → añade exactamente `https://ialvaroautomatizacion-gif.github.io` (sin barra al final).
   - Para pruebas en el ordenador, opcional: `http://localhost:8000`.
   - No hace falta ningún *URI de redireccionamiento*.
   - Crear → copia el **ID de cliente** (termina en `.apps.googleusercontent.com`).
7. Abre `config.js` y rellena:
   ```js
   CLIENT_ID: 'xxxxxxxx.apps.googleusercontent.com',
   ALLOWED_EMAILS: ['tu.correo@gmail.com'],
   ```

Como la app está en modo Prueba, al entrar por primera vez Google avisará de que "no ha verificado esta app". Es normal: pulsa *Continuar*.

## Paso 2 — Publicar en GitHub Pages

1. En GitHub crea un repositorio **público** y vacío llamado `vinted-workflow` (sin README).
2. Sube todos los archivos de esta carpeta a la raíz del repositorio.
3. En el repositorio: *Settings › Pages* → *Source*: **Deploy from a branch** → *Branch*: `main` / `(root)` → Save.
4. En 1-2 minutos la app estará en: **https://ialvaroautomatizacion-gif.github.io/vinted-workflow/**

Cada cambio que se suba al repositorio se publica solo.

## Paso 3 — Primera apertura en el iPhone

1. Abre el enlace en **Safari** (no en Chrome ni dentro de otra app).
2. Pulsa **Entrar con Google** → elige tu cuenta → Continuar → permite el acceso a los archivos de Drive creados por la app.
3. Abre **Ajustes de prueba**. La línea de abajo dice qué admite tu iPhone; mándame una captura.
4. Pulsa **EMPEZAR SESIÓN** → *Permitir* cámara y micrófono.
   - Si los rechazaste por error: icono **aA** de la barra de direcciones → *Ajustes del sitio web* → Cámara y Micrófono: Permitir.

---

## Prueba de aceptación (30 minutos, iPhone 13 Pro + Safari)

Hazla con el móvil **enchufado** y **wifi**. No cambies de app salvo en el paso 6.

| Min | Qué haces | Qué dices en voz alta |
|---|---|---|
| 0 | EMPEZAR SESIÓN | "Empieza la prueba" |
| 1 | Foto | "Foto uno", justo al pulsar |
| 3 | Foto | "Foto dos" |
| 4–9 | Nada (silencio 5 min) | — |
| 9 | Foto | "Foto tres" |
| 10 | Galería → borra la foto dos | "He borrado la dos" |
| 12–20 | Una foto cada 2 min | "Foto cuatro", "Foto cinco"… |
| 20 | Botón de inicio del iPhone 10 s y vuelve a Safari | "Vuelvo de la interrupción" |
| 21–30 | Fotos sueltas y habla con normalidad | Describe una prenda inventada |
| 30+ | TERMINAR SESIÓN | — |

**Qué debe pasar:**
- El cronómetro, el punto rojo y la barra del micrófono se mueven durante toda la sesión. La barra debe reaccionar cuando hablas.
- Al volver en el minuto 20, la grabación se reanuda sola o aparece **REANUDAR GRABACIÓN**. Las dos cosas son válidas: el corte queda anotado.
- En la pantalla final, todas las comprobaciones salen en ✅.
- En Drive aparece `VINTED_WORKFLOW/SESION_…` con fotos, audio, `manifest.json` y `resumen_sesion.txt`.

**Después, mándame:**
1. La captura de *Ajustes de prueba*.
2. La pantalla final, con *Diagnóstico* desplegado.
3. El nombre de la carpeta de la sesión.

Yo reviso los archivos en tu Drive, transcribo el audio y compruebo que cada "foto N" dicha en voz alta cae en el `elapsed_ms` de su foto (margen ±0,5 s).

---

## Cómo encaja audio y fotos (para Claude)

- Cada foto tiene `elapsed_ms`: milisegundos desde el inicio de la sesión, medidos en el instante del toque.
- Cada segmento de audio tiene `start_elapsed_ms`. Un instante T de la sesión está en el segundo `(T − start_elapsed_ms)/1000` de ese archivo.
- Normalmente hay **un único segmento**. Solo se abre otro si iOS corta la grabación, y el hueco queda en `audio.gaps`.
- Los fragmentos de `AUDIO/fragmentos/`, unidos en orden, son idénticos byte a byte al archivo completo (comprobado en las pruebas). Si el completo faltara, se reconstruye con `cat seg01_parte*.webm > seg01.webm`.

## Qué se recupera si algo falla

| Situación | Qué pasa |
|---|---|
| Sin cobertura | Todo se guarda en el móvil y se sube solo al volver la conexión. |
| Llamada, bloqueo, cambio de app | iOS para cámara y micro. Al volver, la app reanuda (o te lo pide con un toque) en un segmento nuevo. El hueco queda anotado. |
| Safari se cierra o se recarga la página | Al abrir la app sale **Sesión sin terminar → REANUDAR**, con las fotos y el cronómetro de antes. Se pierden como máximo los ~5 s de audio que no se habían guardado. |
| Se borran los datos de Safari o se pierde el móvil antes de subir | Se pierde lo que no estuviera ya en Drive. Por eso se sube durante la sesión. |
| Pasa más de ~1 h desde que entraste con Google | Google caduca el acceso cada hora. La subida se pausa (el icono ☁︎ se pone naranja), pero todo sigue guardándose en el móvil. Al terminar, *Reintentar* te pide entrar otra vez y se sube todo. Si reconectas en mitad de la sesión, la ventana de Google puede pausar un momento la cámara; la app la reanuda. |

## Limitaciones conocidas

1. **La cámara nativa de iOS no se puede dejar abierta desde una web.** Se cierra tras cada foto y vuelve a la página. Por eso la cámara va integrada en la app y no se cierra hasta TERMINAR.
2. **Calidad de foto:** si Safari admite `takePhoto()`, la foto sale a resolución completa del sensor. Si no, sale un fotograma de hasta 4K (8 MP), sin el procesado HDR de la app Cámara. La línea de *Ajustes de prueba* dice cuál de las dos usa tu iPhone.
3. **Hay que mantener Safari delante y la pantalla encendida.** La app evita el bloqueo automático, pero si sales de Safari, iOS corta la cámara y probablemente el micro.
4. **Batería y calor:** una hora de cámara activa consume mucho. Trabaja con el cargador puesto.
5. **No usar como app de pantalla de inicio** de momento. En modo app instalada iOS es más agresivo cortando el micro. Mejor desde Safari.
6. **Precisión temporal:** ±0,5 s entre la foto y el audio.
7. **Borrar sesiones** desde la app y la **integración con Claude** llegan en fases posteriores. Esta versión no borra nada.

## Estructura de archivos

```
index.html        pantallas (inicio, sesión, galería, resumen)
app.css           estilos móviles, uso con una mano
config.js         ← tu CLIENT_ID y correos autorizados
app.js            interfaz y navegación
session.js        sesión: inicio, fotos, interrupciones, reanudación, fin
capture.js        cámara + micrófono, fotos, miniaturas, medidor de nivel
audio.js          grabación continua por segmentos
sync.js           subida a Drive, reintentos, comprobación final
drive.js          llamadas a la API de Drive (sin duplicados)
auth.js           inicio de sesión de Google (drive.file)
manifest.js       manifest.json y resumen_sesion.txt
store.js          estado de sesiones
db.js             almacenamiento local (IndexedDB)
util.js           reloj de sesión y formatos
```
