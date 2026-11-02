// ============================================================
// Configuración pública de Supabase
// ------------------------------------------------------------
// La anon key es pública por diseño (viaja en el bundle del
// navegador de todos modos), así que este archivo se puede
// editar a mano en local.
//
// En CI este archivo se sobrescribe con los secrets
// VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// (.github/workflows/deploy.yml → paso "Generar config.js").
// Ver .env.example para la referencia de secrets.
// ============================================================
globalThis.__APP_CONFIG__ = {
  supabaseUrl: 'https://TU_PROYECTO.supabase.co',
  supabaseAnonKey: 'TU_ANON_KEY',
};
