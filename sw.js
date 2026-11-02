/* ============================================================
 * Service Worker de PlateDetect — escrito a mano (sin Workbox)
 *
 * Estrategias:
 *  - Precache (app shell + vendor + modelos ONNX): se descargan una vez
 *    en `install` con `cache: 'reload'`, dentro de un caché con nombre
 *    VERSIONED. Como no hay build que genere hashes por archivo, el CI
 *    escribe el VERSION = hash de todo el sitio en este archivo: si cambia
 *    cualquier cosa publicada, cambian los bytes de sw.js → el navegador
 *    instala un SW nuevo → se precachea todo fresco en un caché nuevo y
 *    se borra el viejo. Así nunca conviven versiones mezcladas.
 *  - Navegaciones y assets del propio origen: cache-first (shell atómico;
 *    si no está cacheado, va a red).
 *  - jsDelivr (WASM de ONNX Runtime): cache-first, 30 días.
 *  - Supabase: network-first con timeout de 10 s (mismo comportamiento
 *    que el Workbox anterior).
 *
 * En dev (localhost) main.js NO registra este SW, para que ediciones en
 * vivo no se queden dormidas en el caché.
 * ============================================================ */

// El CI lo reemplaza por un hash del sitio: sed "s/^const VERSION = ..."
const VERSION = 'v1';
const SHELL_CACHE = `parking-lite-shell-${VERSION}`;
const CDN_CACHE = 'cdn-cache';
const SUPABASE_CACHE = 'supabase-api';

const CDN_MAX_ENTRIES = 20;
const SUPABASE_MAX_ENTRIES = 100;
const SUPABASE_TIMEOUT_MS = 10000;

// GitHub Pages no permite mandar headers custom, pero el Service Worker
// sí puede agregarlos a la respuesta de la navegación. Con COOP + COEP el
// documento queda "cross-origin isolated" y ONNX Runtime puede usar
// SharedArrayBuffer → inferencia multi-hilo (medido: ~2x más rápida que
// en single-thread: 304 ms → 143 ms por inferencia de YOLOv8).
//
// "credentialless" (y no "require-corp") porque las peticiones a
// jsDelivr (el WASM de ORT) son cross-origin: con credentialless se
// permiten sin tener que mandar CORS/CORP en cada recurso.
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

// App shell + código + modelos. Mantener sincronizado con los archivos
// que copia el paso "Armar sitio estatico" de .github/workflows/deploy.yml
const PRECACHE = [
  './',
  'index.html',
  'style.css',
  'config.js',
  'main.js',
  'app-supabase.js',
  'admin.js',
  'bulk-plates.js',
  'camera.js',
  'corrector.js',
  'detector.js',
  'guest-auth.js',
  'ocr.js',
  'plate-parser.js',
  'plate-types.js',
  'supabase-client.js',
  'supabase-config.js',
  'validator.js',
  'vendor/ort-setup.js',
  'vendor/ort.all.bundle.min.mjs',
  'vendor/ort.wasm.bundle.min.mjs',
  'vendor/ort-wasm-simd-threaded.jsep.mjs',
  'vendor/ort-wasm-simd-threaded.mjs',
  'vendor/supabase.js',
  'manifest.json',
  'favicon.svg',
  'icon-192.svg',
  'icon-512.svg',
  'icons.svg',
  'plate-icon.png',
  'en_dict.txt',
  'models/yolov8_plate.onnx',
  'models/ppocr_rec.onnx',
  'models/ppocr_keys.json',
];

// ------------------------------------------------------------
// Install: precache del shell (los modelos pesan ~16 MB, pero la
// app ya los necesitaba en el primer arranque).
// ------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const failures = [];

      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: 'reload' }));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await cache.put(url, res);
          } catch (err) {
            failures.push(`${url}: ${err.message}`);
          }
        })
      );

      // Si falta el shell mínimo no tiene sentido instalar el SW.
      const critical = ['index.html', 'main.js', 'style.css'];
      const missing = [];
      for (const url of critical) {
        if (!(await cache.match(url))) missing.push(url);
      }
      if (missing.length) {
        throw new Error(`Precache incompleto, faltan: ${missing.join(', ')}`);
      }
      if (failures.length) {
        console.warn('[SW] Archivos que no se pudieron precachear:', failures);
      }

      await self.skipWaiting();
    })()
  );
});

// ------------------------------------------------------------
// Activate: borra caches de versiones anteriores y toma control.
// ------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, CDN_CACHE, SUPABASE_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => !keep.has(n)).map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  // keys() respeta el orden de inserción: se descarta lo más viejo.
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k)));
}

/** Devuelve la respuesta con las cabeceras de aislamiento agregadas. */
function withIsolationHeaders(res) {
  if (!res || res.type === 'error' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(ISOLATION_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

async function putStamped(cache, request, res) {
  // Guardamos el momento de la cachada en una cabecera propia para poder
  // decidir frescura después (Date no siempre es legible en cross-origin).
  const headers = new Headers(res.headers);
  headers.set('x-sw-cached-at', String(Date.now()));
  const copy = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  await cache.put(request, copy);
}

function ageSeconds(res) {
  const at = res.headers.get('x-sw-cached-at');
  if (!at) return 0;
  return (Date.now() - Number(at)) / 1000;
}

async function cacheFirst(request, cacheName, { maxEntries = 0, maxAgeSeconds = 0 } = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fresh = cached && (!maxAgeSeconds || ageSeconds(cached) < maxAgeSeconds);
  if (fresh) return cached;

  try {
    const res = await fetch(request);
    if (res && res.ok) {
      await putStamped(cache, request, res.clone());
      if (maxEntries) await trimCache(cacheName, maxEntries);
    }
    return res;
  } catch (err) {
    // Sin red: sirve lo cacheado aunque esté vencido.
    if (cached) return cached;
    return Response.error();
  }
}

async function networkFirst(request, { timeoutMs, cacheName, maxEntries = 0 } = {}) {
  const cache = cacheName ? await caches.open(cacheName) : null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(request, { signal: controller.signal });
    if (res && res.ok && cache) {
      await cache.put(request, res.clone());
      if (maxEntries) await trimCache(cacheName, maxEntries);
    }
    return res;
  } catch (err) {
    const cached = cache && (await cache.match(request));
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline', detail: String(err && err.message) }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------
// Fetch
// ------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1) Navegaciones (HTML): el shell cacheado es atómico (mismo VERSION
  //    que los JS/CSS), así que nunca se mezclan versiones. Si no está
  //    cacheado, va a red.
  //
  //    La respuesta se devuelve con COOP/COEP para que el documento quede
  //    cross-origin isolated (ver ISOLATION_HEADERS).
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const res = await cacheFirst(request, SHELL_CACHE);
        return withIsolationHeaders(res);
      })()
    );
    return;
  }

  // 2) jsDelivr (WASM de ONNX Runtime): inmutable, cache-first.
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(
      cacheFirst(request, CDN_CACHE, { maxEntries: CDN_MAX_ENTRIES, maxAgeSeconds: 30 * 24 * 3600 })
    );
    return;
  }

  // 3) API de Supabase: red con timeout, fallback a caché.
  if (url.hostname.endsWith('.supabase.co')) {
    event.respondWith(
      networkFirst(request, {
        timeoutMs: SUPABASE_TIMEOUT_MS,
        cacheName: SUPABASE_CACHE,
        maxEntries: SUPABASE_MAX_ENTRIES,
      })
    );
    return;
  }

  // 4) Assets del propio sitio (JS, CSS, modelos, imágenes...): cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});
