# Club Almagro — PWA

Estos tres archivos forman una Progressive Web App instalable:

- `index.html` — la app completa (HTML/CSS/JS, sin dependencias de build)
- `manifest.json` — nombre, ícono y colores para "agregar a pantalla de inicio"
- `sw.js` — service worker que cachea la app para que funcione offline

## Importante: necesita HTTPS

Los navegadores **no activan el service worker ni el botón de instalación si abrís `index.html` directamente desde tu computadora** (protocolo `file://`). Necesitás servir estos archivos desde un servidor con HTTPS (o `localhost` para probar).

## Cómo probarlo rápido en tu computadora

Con Python instalado, parado en la carpeta de estos 3 archivos:

```bash
python3 -m http.server 8000
```

Después abrí `http://localhost:8000` en Chrome o Safari desde tu celular (mismo Wi-Fi) o en tu computadora.

## Cómo publicarlo gratis (con HTTPS real)

Cualquiera de estas opciones sirve, subiendo los 3 archivos tal cual:

- **Netlify Drop**: arrastrás la carpeta a [app.netlify.com/drop](https://app.netlify.com/drop)
- **Vercel**: `vercel` desde la carpeta (requiere cuenta)
- **GitHub Pages**: subís los archivos a un repo y activás Pages

Una vez publicado, entrá desde el celular con Chrome (Android) o Safari (iPhone) y usá "Agregar a pantalla de inicio" — o esperá el cartel de instalación que aparece solo.

## Datos en vivo (fixture, resultados y tabla de posiciones)

`worker.js` es un Cloudflare Worker con dos rutas:

- **`/fixture`** — scrapea la página del equipo en Promiedos (próximos partidos y resultados)
- **`/standings?zona=A|B`** — trae la tabla de posiciones completa de la zona pedida, desde ESPN

(La tabla de Promiedos no se puede leer con un scraper simple porque se carga
con JavaScript del lado del cliente. ESPN sí sirve la tabla completa en el
HTML inicial, así que es la fuente usada acá.)

Almagro juega en la **Zona B** de la Primera Nacional, así que la app pide esa
zona por default para el resumen y el widget de posición. El botón "Ver tabla
completa de la zona" muestra primero la Zona B y después la Zona A, para
poder usar el comparador rápido entre cualquier par de los 36 equipos.

Sin desplegar el Worker, la app funciona igual pero con los resultados fijos
que están en el código, y el botón "Ver tabla completa de la zona" muestra un
aviso en vez de la tabla.

1. Entrá a [dash.cloudflare.com](https://dash.cloudflare.com) (cuenta gratis, sin tarjeta)
2. Workers & Pages → Create → Create Worker
3. Pegá todo el contenido de `worker.js` reemplazando el código de ejemplo
4. Deploy — te da una URL tipo `https://almagro-fixture.tu-nombre.workers.dev`
5. Probalo en el navegador: esa URL + `/fixture` y esa URL + `/standings?zona=B` (ambas deberían devolver JSON)
6. En `index.html`, buscá la línea `const WORKER_BASE = "..."` y poné tu URL ahí (sin barra al final, sin `/fixture`)
7. Volvé a subir `index.html` a donde tengas publicada la PWA

El Worker cachea cada respuesta 30 minutos de su lado, así que no golpea
Promiedos ni ESPN en cada visita. Si en algún momento alguno de los dos
sitios cambia el diseño de su página, ese scraper puede dejar de funcionar —
en ese caso esa parte puntual de la app deja de actualizarse (muestra un
aviso o los datos fijos), pero el resto sigue funcionando normalmente.

## Notas

- **Marcador en vivo:** cuando el próximo partido llega a su hora de inicio, la app sondea el Worker cada 60 segundos durante 3 horas buscando cambios. No hay ninguna fuente confiable de minuto a minuto, así que en el peor de los casos vas a ver "Almagro está jugando ahora" sin marcador hasta que termine, y recién ahí aparece el resultado final. No pude probar esto contra un partido real en curso todavía — si el formato que usa Promiedos durante un partido en vivo es distinto a lo esperado, puede necesitar un ajuste la primera vez que se dé el caso real.
- Para el marcador en vivo minuto a minuto de verdad, lo más simple sigue siendo preguntarme directamente en el chat ("¿cómo va Almagro?") — ahí busco en la web en el momento, sin las limitaciones del scraping.

- **Ícono con badge:** cuando instalás la app y hay resultados nuevos que todavía no viste en la pestaña Resultados, el ícono va a mostrar un numerito (como los mensajes sin leer). Se limpia solo apenas entrás a esa pestaña.
  - Funciona en Chrome/Edge de escritorio y en Android con la app instalada. En iPhone (Safari) todavía no está soportado — el ícono se queda sin badge, pero el resto de la app funciona igual.
  - Ojo: el badge solo se actualiza cuando **abrís la app** y ella misma chequea contra el Worker si hay resultados nuevos. No hay forma de que aparezca el número mientras la app está cerrada — eso requeriría notificaciones push con un servidor propio, que es un paso más grande (avisame si te interesa).
- El service worker precachea el escudo y las fotos del estadio apenas se instala la PWA (no espera a que las visites), así Historia, Identidad y Estadio se ven completos sin conexión desde el principio.
- Las tipografías de Google Fonts se intentan precachear también, pero si tu conexión es lenta esa parte puede fallar sin romper nada — en ese caso el texto se ve con la tipografía de reemplazo del sistema hasta la próxima vez que haya conexión.
- Sin desplegar el Worker, los datos de resultados quedan fijos en el código. Con el Worker desplegado, el fixture y los resultados se actualizan solos.
- El plantel (nombres, edades) sí queda fijo — no vale la pena scrapearlo tan seguido.
- A diferencia de otros datos de la historia del club (fechas de fundación, cambios de colores, ascensos, la hazaña ante Boca en 2019), no encontré una lista pública y confiable de todos los directores técnicos históricos de Almagro, así que la sección de "Cuerpo técnico" en Planteles históricos solo muestra al DT actual en vez de arriesgar nombres o fechas no verificadas.
