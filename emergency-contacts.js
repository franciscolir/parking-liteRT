// ============================================================
// CONTACTOS DE EMERGENCIA POR DEFECTO (vista Llamadas)
// ------------------------------------------------------------
// Los 5 números por defecto son GLOBALES: se guardan en
// app_settings (clave `emergency_contacts`) para que el admin
// los edite una vez y todos los usuarios (y hasta los invitados)
// vean lo mismo.
//
// Este módulo es puro (sin dependencias) para poder testearlo:
//   - DEFAULT_EMERGENCY_CONTACTS: fallback si la clave aún no
//     existe en la BD o si esta no responde.
//   - normalizeEmergencyContacts: valida el JSON leído de
//     app_settings.
//   - mergeContactLists: arma la lista final que se renderiza
//     (los 5 por defecto + contactos propios del usuario que no
//     sean los antiguos defaults del trigger `is_default`).
// ============================================================

export const DEFAULT_EMERGENCY_CONTACTS = [
  { name: 'Carabineros',           phone: '133', type: 'police',    icon: '🚨' },
  { name: 'Bomberos',              phone: '132', type: 'fire',      icon: '🔥' },
  { name: 'Ambulancia',            phone: '131', type: 'emergency', icon: '🚑' },
  { name: 'Superintendente dpto.', phone: '',    type: 'office',    icon: '🏢' },
  { name: 'Auxiliar',              phone: '',    type: 'custom',    icon: '👮' },
];

/**
 * Valida el array guardado en app_settings.
 * Devuelve la lista saneada o null si el valor no sirve
 * (clave inexistente, JSON corrupto, etc.).
 */
export function normalizeEmergencyContacts(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const list = value
    .filter(c => c && typeof c.name === 'string' && c.name.trim())
    .map(c => ({
      name: String(c.name).trim(),
      phone: c.phone == null ? '' : String(c.phone).trim(),
      type: typeof c.type === 'string' && c.type ? c.type : 'custom',
      icon: typeof c.icon === 'string' && c.icon ? c.icon : '📞',
    }));
  return list.length ? list : null;
}

/**
 * Lista final de la vista Llamadas:
 *   1. Los 5 por defecto (globales; si `defaults` no sirve, el fallback).
 *   2. Los contactos agregados por el usuario que NO son los
 *      defaults antiguos que creaba el trigger (is_default).
 */
export function mergeContactLists(defaults, personal = []) {
  const base = normalizeEmergencyContacts(defaults) || DEFAULT_EMERGENCY_CONTACTS;
  const extras = (Array.isArray(personal) ? personal : [])
    .filter(c => c && !c.is_default);
  return [...base, ...extras];
}
