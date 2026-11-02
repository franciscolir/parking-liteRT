/**
 * PlateDetect - Entry Point
 * Inicializa la aplicación y configura Supabase
 *
 * Sin bundler: esto es un módulo ES nativo, todos los imports son
 * rutas relativas y las librerías de terceros viven en ./vendor.
 */

import './app-supabase.js';
import { SUPABASE_CONFIG } from './supabase-config.js';

const isDevHost = ['localhost', '127.0.0.1', ''].includes(location.hostname);

// Validar configuración de Supabase al inicio
if (SUPABASE_CONFIG.url.includes('TU_PROYECTO') || SUPABASE_CONFIG.anonKey.includes('TU_ANON_KEY')) {
  console.warn('[PlateDetect] ⚠️ Supabase no configurado. Edita config.js con tus credenciales.');
  console.warn('[PlateDetect] Ve a https://supabase.com/dashboard/project/_/settings/api');
} else {
  console.log('[PlateDetect] ✅ Supabase configurado correctamente');
}

// Log de versión y modo
console.log('[PlateDetect] v1.0.0 - ' + (isDevHost ? 'DEV' : 'PROD'));
console.log('[PlateDetect] ONNX Runtime Web + Supabase + PWA ready');

// ============================================================
// SERVICE WORKER (PWA) — sw.js escrito a mano, sin Workbox
// ============================================================
// En dev (npm run dev) NO se registra: sin build no hay "revisión" de
// archivos y el caché del SW dejaría versiones viejas mientras editás.
// La versión del caché la inyecta el CI en sw.js (const VERSION) a partir
// de un hash del sitio: cualquier cambio publicado = sw.js nuevo = SW nuevo.
if ('serviceWorker' in navigator) {
  if (isDevHost) {
    console.log('[PWA] Service Worker deshabilitado en dev (npm run dev). Verificá la PWA en el deploy.');
  } else {
    // El Service Worker es el que agrega COOP/COEP (GitHub Pages no deja
    // mandar headers custom). Una navegación servida por la red no queda
    // aislada y ONNX corre single-thread, así que hay que recargar para
    // que la navegación pase por el SW.
    //
    // El guard en sessionStorage evita bucles: una sola recarga por
    // sesión y solo si de verdad hace falta.
    let reloading = false;
    const reloadForIsolation = (reason) => {
      if (reloading || crossOriginIsolated) return;
      try {
        if (sessionStorage.getItem('platedetect:iso-reload')) return;
        sessionStorage.setItem('platedetect:iso-reload', '1');
      } catch (e) { return; }   // sin sessionStorage no recargamos
      reloading = true;
      console.log('[PWA] Recargando (' + reason + ') para activar el modo multi-hilo...');
      location.reload();
    };

    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./sw.js')
        .then((reg) => console.log('[PWA] Service Worker registrado:', reg.scope))
        .catch((err) => console.warn('[PWA] No se pudo registrar el Service Worker:', err));
    });

    // El SW avisó que se activó una versión nueva (o es la primera
    // instalación): hay que recargar para tomar el shell nuevo.
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'sw-updated') {
        reloadForIsolation('sw-updated');
      }
    });

    // El SW tomó control de esta página (primera visita o versión nueva).
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      reloadForIsolation('controllerchange');
    });

    navigator.serviceWorker.ready
      .then(async () => {
        // El SW (en Chrome/Edge) ya recargó la pestaña al activarse. Este
        // camino es el respaldo para los navegadores sin Client.navigate()
        // (Safari). El margen deja que el SW haga su trabajo primero.
        await new Promise((r) => setTimeout(r, 1200));
        reloadForIsolation('sw-ready');
      })
      .catch(() => {});
  }
}
