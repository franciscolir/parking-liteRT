/**
 * Configuración de Supabase para PlateDetect (sin bundler)
 *
 * Los valores viven en config.js, que index.html carga con un <script>
 * clásico ANTES del módulo ES, y que define globalThis.__APP_CONFIG__.
 *
 * INSTRUCCIONES (local):
 * 1. Edita config.js con tu URL y anon key de Supabase
 * 2. npm run dev
 *
 * En producción config.js lo genera el CI a partir de los secrets
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (ver .github/workflows/deploy.yml).
 */

const cfg = (typeof globalThis !== 'undefined' && globalThis.__APP_CONFIG__) || {};

export const SUPABASE_CONFIG = {
  url: cfg.supabaseUrl || 'https://TU_PROYECTO.supabase.co',
  anonKey: cfg.supabaseAnonKey || 'TU_ANON_KEY',
};

// Validación básica
const isPlaceholder = SUPABASE_CONFIG.url.includes('TU_PROYECTO') ||
                      SUPABASE_CONFIG.anonKey.includes('TU_ANON_KEY');

if (isPlaceholder) {
  console.warn('[Supabase] ⚠️ Configuración no establecida.');
  console.warn('[Supabase] 1. Edita config.js con tus credenciales de Supabase');
  console.warn('[Supabase] 2. Recarga: npm run dev');
  console.warn('[Supabase] Dashboard: https://supabase.com/dashboard/project/_/settings/api');
} else {
  console.log('[Supabase] ✅ Conectado a:', SUPABASE_CONFIG.url);
}
