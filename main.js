/**
 * PlateDetect - Entry Point
 * Inicializa la aplicación y configura Supabase
 */

import './app-supabase.js';
import { SUPABASE_CONFIG } from './supabase-config.js';

// Validar configuración de Supabase al inicio
if (SUPABASE_CONFIG.url.includes('TU_PROYECTO') || SUPABASE_CONFIG.anonKey.includes('TU_ANON_KEY')) {
  console.warn('[PlateDetect] ⚠️ Supabase no configurado. Edita .env con tus credenciales.');
  console.warn('[PlateDetect] Ve a https://supabase.com/dashboard/project/_/settings/api');
} else {
  console.log('[PlateDetect] ✅ Supabase configurado correctamente');
}

// Log de versión y modo
console.log('[PlateDetect] v1.0.0 - ' + (import.meta.env.DEV ? 'DEV' : 'PROD'));
console.log('[PlateDetect] ONNX Runtime Web + Supabase + PWA ready');