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
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./sw.js')
        .then((reg) => console.log('[PWA] Service Worker registrado:', reg.scope))
        .catch((err) => console.warn('[PWA] No se pudo registrar el Service Worker:', err));
    });
  }
}
