// Service worker de la PWA de Club Almagro.
// Cachea el shell de la app (HTML/manifest) y las imágenes clave (escudo,
// fotos del estadio) apenas se instala, para que funcione sin conexión desde
// el principio. Las tipografías de Google Fonts se intentan precachear
// también, pero si fallan no rompen nada (el navegador cae a una tipografía
// de reemplazo del sistema).

const CACHE_NAME = "almagro-pwa-v2";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
];

const IMAGE_ASSETS = [
  "https://commons.wikimedia.org/wiki/Special:FilePath/Escudo_del_Club_Almagro.svg",
  "https://commons.wikimedia.org/wiki/Special:FilePath/Estadio%20Tres%20de%20Febrero%2C%20del%20Club%20Almagro..jpg",
  "https://commons.wikimedia.org/wiki/Special:FilePath/Estadio%20Tres%20de%20Febrero%2C%20vista%20oriental..jpg",
  "https://commons.wikimedia.org/wiki/Special:FilePath/Estadio%20Tres%20de%20Febrero%20popular.jpg",
];

const FONT_ASSETS = [
  "https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@400;600;700;900&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500;8..60,600&family=IBM+Plex+Mono:wght@400;500&display=swap",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // El shell de la propia app: si esto falla, preferimos que falle la
      // instalación entera antes que quedar con una app a medio cachear.
      await cache.addAll(CORE_ASSETS);

      // Las imágenes y tipografías son "best effort": si alguna falla (por
      // ejemplo, sin conexión durante la instalación), no bloqueamos el resto.
      await Promise.allSettled(
        [...IMAGE_ASSETS, ...FONT_ASSETS].map((url) =>
          cache.add(new Request(url, { mode: "cors" })).catch(() => {})
        )
      );
    })()
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
      self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Nunca cachear las llamadas al Worker de datos en vivo (fixture/standings)
  // ni al pronóstico del clima: siempre queremos la versión más reciente.
  if (request.url.includes("/fixture") || request.url.includes("/standings") || request.url.includes("open-meteo.com")) {
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        // Sin conexión y sin copia en caché: dejamos que el navegador muestre
        // su error de red por defecto en vez de simular una respuesta.
        throw err;
      }
    })()
  );
});
