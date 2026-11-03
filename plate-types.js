/**
 * plate-types.js - Tipos de patente del sistema (fuente única de verdad)
 *
 * Los 3 tipos válidos son exactamente los que ya usa la aplicación:
 *   - admin.js (modal de ingreso individual) -> <select id="admin-plate-type">
 *   - app-supabase.js (cache + escaneo)    -> platesCache / processPlate()
 *
 * NO inventar valores nuevos: el tipo se guarda tal cual en `plates.type`.
 */

/**
 * Los 3 tipos de patente válidos, con su etiqueta y clase de color.
 *
 * `cls`      → color del CONTADOR por tipo (mini cards NE/AD/PA): cada
 *              tipo tiene su color para distinguirlos de un vistazo.
 * `stateCls` → color de los BADGES: ahí el color indica el ESTADO de la
 *              patente (verde = registrada, rojo = primeros auxilios),
 *              no el tipo. El tipo se lee en la etiqueta de texto.
 */
export const PLATE_TYPES = [
  { value: 'special_needs', label: 'Necesidades especiales', abbr: 'NE', cls: 'warn', stateCls: 'reg' },
  { value: 'administration', label: 'Administración', abbr: 'AD', cls: 'reg', stateCls: 'reg' },
  { value: 'first_aid', label: 'Primeros auxilios', abbr: 'PA', cls: 'stolen', stateCls: 'stolen' },
];

/** Solo los valores válidos: ['special_needs', 'administration', 'first_aid'] */
export const PLATE_TYPE_VALUES = PLATE_TYPES.map(t => t.value);

/** Mapa { valor: { label, cls } } para pintar badges. */
export const TYPE_LABELS = PLATE_TYPES.reduce((acc, t) => {
  acc[t.value] = { label: t.label, cls: t.stateCls };
  return acc;
}, {});

/** Texto mostrado cuando el tipo no se pudo determinar. */
export const REVIEW_LABEL = 'Revisión necesaria';

/**
 * Estados de un escaneo (columna `scan_history.status`).
 *
 * El valor guardado es el TIPO de la patente (special_needs /
 * administration / first_aid) o 'unknown' / 'error'. Se aceptan también los
 * valores antiguos ('success' / 'danger' / 'warning') por si quedaron filas
 * viejas en la base.
 */
export const SCAN_STATUS_LABELS = {
  ...TYPE_LABELS,
  unknown: { label: 'Desconocido', cls: 'unk' },
  error: { label: 'Error', cls: 'unk' },
  success: { label: 'Registrado', cls: 'reg' },
  danger: { label: 'Denunciado', cls: 'stolen' },
  warning: { label: 'Desconocido', cls: 'unk' },
};

/** Etiqueta y color de un escaneo a partir de su status. */
export function getScanStatus(status) {
  return SCAN_STATUS_LABELS[status] || { label: status || 'Desconocido', cls: 'unk' };
}

/** ¿El valor corresponde a uno de los 3 tipos válidos? */
export function isValidPlateType(value) {
  return PLATE_TYPE_VALUES.includes(value);
}

/** Etiqueta legible de un tipo (o el valor crudo si no se conoce). */
export function getTypeLabel(value) {
  return TYPE_LABELS[value]?.label || value || '';
}

/**
 * Keywords por tipo. Se comparan contra el texto normalizado
 * (minúsculas y sin acentos), por eso van sin tildes.
 */
const TYPE_KEYWORDS = {
  special_needs: [
    'necesidades especiales',
    'necesidad especial',
    'silla de ruedas',
    'discapacidad',
    'movilidad reducida',
    'movilidad',
    'pmr',
    'accesibilidad',
  ],
  administration: [
    'administracion',
    'oficina',
    'comite',
    'organizacion',
    'directivo',
    'autoridad',
    'dirigente',
    'junta',
  ],
  first_aid: [
    'primeros auxilios',
    'ambulancia',
    'emergencia',
    'medico',
    'enfermer',
    'cruz roja',
    'ambulanciero',
    'urgencia',
    'bomberos',
  ],
};

/** Normaliza texto para comparar keywords (minúsculas, sin acentos). */
export function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Determina el tipo de patente a partir del contexto textual.
 *
 * Reglas:
 *   - 0 coincidencias  -> null (el usuario debe revisarlo)
 *   - 1 coincidencia   -> ese tipo
 *   - >1 coincidencias -> null (ambiguo, no se inventa)
 *
 * @param {string} text contexto (mensaje, línea o fragmento)
 * @returns {string|null} valor de tipo válido o null
 */
export function detectPlateType(text) {
  const haystack = normalizeForMatch(text);
  if (!haystack) return null;

  const hits = PLATE_TYPE_VALUES.filter(value =>
    TYPE_KEYWORDS[value].some(keyword => haystack.includes(keyword))
  );

  return hits.length === 1 ? hits[0] : null;
}

/** Keywords por tipo (copia) para tests / ajustes. */
export function getTypeKeywords() {
  return { ...TYPE_KEYWORDS };
}
