/**
 * Configuración de Supabase para PlateDetect (Vite)
 * 
 * Las variables se definen en .env (basado en .env.example)
 * 
 * INSTRUCCIONES:
 * 1. Copia .env.example a .env
 * 2. Completa con tus credenciales de Supabase
 * 3. Reinicia el servidor de desarrollo (npm run dev)
 */

// Vite expone variables de entorno con prefijo VITE_ en import.meta.env
export const SUPABASE_CONFIG = {
  url: import.meta.env.VITE_SUPABASE_URL || 'https://TU_PROYECTO.supabase.co',
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || 'TU_ANON_KEY_AQUI',
};

// Validación básica
const isPlaceholder = SUPABASE_CONFIG.url.includes('TU_PROYECTO') ||
                      SUPABASE_CONFIG.anonKey.includes('TU_ANON_KEY');

if (isPlaceholder) {
  console.warn('[Supabase] ⚠️ Configuración no establecida.');
  console.warn('[Supabase] 1. Copia .env.example a .env');
  console.warn('[Supabase] 2. Edita .env con tus credenciales de Supabase');
  console.warn('[Supabase] 3. Reinicia: npm run dev');
  console.warn('[Supabase] Dashboard: https://supabase.com/dashboard/project/_/settings/api');
} else {
  console.log('[Supabase] ✅ Conectado a:', SUPABASE_CONFIG.url);
}