/**
 * Configuración de Supabase para PlateDetect
 * 
 * INSTRUCCIONES:
 * 1. Crea un proyecto en https://supabase.com
 * 2. Ve a Settings > API
 * 3. Copia "Project URL" y "anon public key"
 * 4. Reemplaza los valores abajo
 * 5. Ejecuta el SQL de supabase-schema.sql en el SQL Editor de Supabase
 */

export const SUPABASE_CONFIG = {
  // REEMPLAZA ESTOS VALORES CON LOS DE TU PROYECTO SUPABASE
  url: 'https://TU_PROYECTO.supabase.co',
  anonKey: 'TU_ANON_KEY_AQUI'
};

// Validación básica
if (SUPABASE_CONFIG.url.includes('TU_PROYECTO') || SUPABASE_CONFIG.anonKey.includes('TU_ANON_KEY')) {
  console.warn('[Supabase] ⚠️ Configuración no establecida. Edita supabase-config.js con tus credenciales.');
  console.warn('[Supabase] Ve a https://supabase.com/dashboard/project/_/settings/api');
}