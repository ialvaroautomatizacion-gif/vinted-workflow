# Vinted Workflow — versión 0.4.0

Aplicación web para iPhone (Safari) que guarda en tu Google Drive las fotos y el audio de cada prenda, **una carpeta por prenda**.

**Enlace de la app:** https://ialvaroautomatizacion-gif.github.io/vinted-workflow/

## Uso normal: una prenda en tres pasos

1. Abre la app → **NUEVA PRENDA**.
2. **HACER FOTO**: se abre la cámara del iPhone (calidad nativa). Haz la foto → *Usar foto*. Repite con **HACER OTRA FOTO**. (También puedes elegir fotos ya hechas de la fototeca.)
3. **GRABAR AUDIO**: cuenta marca, talla, medidas, estado e instrucciones. Pulsa **PARAR**. Puedes escucharlo, borrarlo o grabar otro.
4. **GUARDAR PRENDA** → **SIGUIENTE PRENDA**.

Cada prenda queda así en Drive:

```
VINTED_WORKFLOW/
  2026-11-26/                 ← un día de trabajo
    PRENDA_01_11h32/
      foto_01.jpg  foto_02.jpg  foto_03.jpg     (archivos originales, sin recomprimir)
      audio_01.m4a                              (audio_02… si grabas más de uno)
      manifest.json                             (ficha para Claude)
    PRENDA_02_11h36/
      …
```

Detalles útiles:

- Las fotos se numeran por la **hora en que las hiciste** (según los metadatos de la cámara), no por el orden en que las marcas.
- La app sube los archivos **tal cual** los entrega el iPhone: no les baja la calidad.
- **No hace falta esperar** a que termine de subir: pulsa SIGUIENTE PRENDA y la subida sigue sola. En el inicio ves cada prenda con «en Drive ✓» o «pendiente de subir».
- Una prenda a medias **se guarda sola** en el móvil. Si cierras Safari, al volver el botón dice **CONTINUAR PRENDA**.
- Puedes preparar prendas **sin conexión o sin haber entrado con Google**: se suben en cuanto entres.
- Si iOS corta el micrófono (una llamada), lo grabado se conserva y puedes grabar otro audio para continuar.
- **Eliminar** una prenda guardada manda su carpeta a la papelera de Drive (30 días para recuperarla). **Descartar** una prenda sin guardar solo la quita de la app. En ningún caso se tocan las fotos de la galería del iPhone.

### Ficha de cada prenda (`manifest.json`)

Lista las fotos (orden, nombre, nombre original, fecha de la foto, tamaño) y los audios (orden, duración, duración real medida). Todo lo que hay en la carpeta pertenece a una sola prenda, así que Claude no tiene que adivinar qué audio va con qué fotos.

## Otro modo: sesión continua

En el inicio, **Más › Sesión continua**. La cámara se abre dentro de la app y el micrófono graba sin parar mientras haces fotos de muchas prendas seguidas. Todo va a una carpeta `SESION_fecha_hora/` con marcas de tiempo para cruzar audio y fotos. Contras: las fotos salen de la cámara web (hasta 4K, sin el procesado de la cámara del iPhone) y hay que mantener Safari abierto toda la sesión.

## Seguridad: qué protege qué

| Riesgo | Protección |
|---|---|
| Que otra persona use la app con su cuenta | La app de Google Cloud está en modo **Prueba** y solo pueden entrar los **usuarios de prueba**. Además, `ALLOWED_EMAILS` (en `config.js`) rechaza cualquier otra cuenta. |
| Que la app toque otros archivos de tu Drive | Permiso **drive.file**: la app solo ve y modifica los archivos que ella misma ha creado. |
| Enlaces públicos | La app no comparte nada. Los archivos son privados de tu cuenta. |
| Claves en el código | No hay ninguna. El *Client ID* no es secreto: Google solo lo acepta desde el dominio autorizado. |
| Código ajeno inyectado | Política de seguridad (CSP): solo se ejecuta el código propio y el de accounts.google.com. |
| Borrados | La app **nunca borra nada por su cuenta**. Solo se elimina algo si pulsas Eliminar y confirmas, y va a la papelera de Drive. En el móvil solo se libera espacio después de comprobar que cada archivo está en Drive con el tamaño exacto. |

El código es visible en GitHub (GitHub Pages gratis exige repositorio público), pero no contiene datos ni secretos. Para retirar el acceso de la app: https://myaccount.google.com/permissions

## Configuración ya hecha

- **Google Cloud**, proyecto `vinted-workflow`: API de Drive activada; pantalla de consentimiento en modo Prueba; usuario de prueba `ialvaroautomatizacion@gmail.com`; permiso `drive.file`; cliente OAuth web con origen `https://ialvaroautomatizacion-gif.github.io`.
- **GitHub Pages**: rama `main`, carpeta raíz.

**Para añadir otro correo** (el correo dedicado): añádelo en Google Cloud › Google Auth Platform › Público › Usuarios de prueba, y en `ALLOWED_EMAILS` de `config.js`; después hay que regenerar `bundle.js`.

Normal en modo Prueba: Google avisa de que "no ha verificado esta app" (pulsa *Continuar*) y vuelve a pedir el permiso cada 7 días. El acceso dura 1 hora; cuando caduca, la app sigue guardando en el móvil y sube al volver a pulsar *Entrar con Google*.

## Primera vez en el iPhone

1. Abre el enlace en **Safari** (no dentro de WhatsApp, Gmail u otra app).
2. **Entrar con Google** → *Continuar* → deja marcada la casilla de acceso a los archivos de Drive.
3. Al grabar el primer audio, *Permitir* el micrófono.

Si algo no va, abre **Ajustes › Este dispositivo** en la app y envía una captura, junto con la pantalla de guardado con *Diagnóstico* abierto.

## Prueba rápida (2 minutos)

1. Haz 3 fotos de cualquier cosa con la cámara del iPhone.
2. NUEVA PRENDA → ELEGIR FOTOS → marca las 3.
3. GRABAR AUDIO, di «prueba uno, dos, tres», PARAR, y escúchalo con el reproductor.
4. GUARDAR PRENDA → debe salir **Prenda guardada** con todo en ✅.
5. *Abrir carpeta en Drive* → deben estar las 3 fotos, el audio y `manifest.json`.

## Limitaciones conocidas

1. **Acceso de Google de 1 hora.** Al caducar, las prendas se quedan «pendientes de subir» hasta que vuelvas a pulsar *Entrar con Google*. No se pierde nada.
2. **Lo pendiente vive en este Safari.** Si borras los datos de Safari o pierdes el móvil antes de que se suba, eso se pierde. Las fotos originales siguen en tu galería.
3. **La lista de «Guardado» es la de este móvil.** Las carpetas de Drive siguen ahí aunque cambies de móvil.
4. **Formato de las fotos:** las que entrega el selector de iOS (normalmente JPEG). Si llegara un HEIC, la app lo convierte a JPEG.
5. **La integración con Claude** llega en la fase siguiente.

## Archivos

```
index.html     pantallas
app.css        estilos
bundle.js      ← lo que carga la página: todos los módulos unidos (generado)
config.js      Client ID, correos autorizados y parámetros
app.js         interfaz y navegación
prenda.js      modo prenda: importar fotos, grabar audios, guardar
session.js     modo sesión continua
capture.js     cámara + micrófono del modo sesión, miniaturas, medidor de nivel
audio.js       grabación de audio por trozos (a prueba de cierres)
sync.js        subida a Drive, reintentos, comprobación, eliminación manual
drive.js       llamadas a la API de Drive (sin duplicados)
auth.js        inicio de sesión de Google (drive.file)
manifest.js    fichas (manifest.json) y resumen
store.js       estado local
db.js          almacenamiento local (IndexedDB)
util.js        formatos, reloj, medición de audio
```

## Cambiar el código

La página carga `bundle.js`, generado a partir de los módulos:

```
npm install esbuild
npx esbuild app.js --bundle --format=esm --target=safari15 --charset=utf8 --outfile=bundle.js
```

Al publicar una versión nueva, sube el número en `config.js` (`APP_VERSION`) y en las dos referencias `?v=` de `index.html`.
