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
 * COLOR POR TIPO (fuente única de verdad):
 *   - Necesidades especiales (NE) → VERDE
 *   - Administración (AD)           → AZUL
 *   - Primeros auxilios (PA)        → ROJO
 *
 * El mismo color se usa en todos lados: la píldora de tipo en la
 * lista de patentes, el historial, las métricas (mini cards NE/AD/PA),
 * la tarjeta de resultado de la cámara y el frame del canvas.
 *
 * `cls`      → clase CSS del color del tipo (píldoras, badges, mini cards).
 * `stateCls` → alias de `cls` (antes el badge usaba el color del ESTADO).
 * `color`    → color en hex (para dibujar el frame en el canvas).
 */
export const PLATE_TYPES = [
  { value: 'special_needs', label: 'Necesidades especiales', abbr: 'NE', cls: 'ne', stateCls: 'ne', color: '#22c55e' },
  { value: 'administration', label: 'Administración', abbr: 'AD', cls: 'ad', stateCls: 'ad', color: '#3b82f6' },
  { value: 'first_aid', label: 'Primeros auxilios', abbr: 'PA', cls: 'pa', stateCls: 'pa', color: '#ef4444' },
];

/** Solo los valores válidos: ['special_needs', 'administration', 'first_aid'] */
export const PLATE_TYPE_VALUES = PLATE_TYPES.map(t => t.value);

/** Mapa { valor: { label, cls, color } } para pintar badges. */
export const TYPE_LABELS = PLATE_TYPES.reduce((acc, t) => {
  acc[t.value] = { label: t.label, cls: t.stateCls, color: t.color };
  return acc;
}, {});

/** Colores hex por tipo (para el frame del canvas de la cámara). */
export const PLATE_TYPE_COLORS = PLATE_TYPES.reduce((acc, t) => {
  acc[t.value] = t.color;
  return acc;
}, {});

/** Verde de confirmación: parpadea una vez cuando la patente está registrada. */
export const CONFIRM_FLASH_COLOR = '#00ff66';

/** Duración del parpadeo de confirmación (ms). */
export const CONFIRM_FLASH_MS = 500;

/** Color de una patente sin tipo / no registrada. */
export const UNKNOWN_PLATE_COLOR = '#ffcc00';

/** Color hex de un tipo de patente (null si no es un tipo válido). */
export function getTypeColor(type) {
  return PLATE_TYPE_COLORS[type] || null;
}

/** Clase CSS del color de un tipo de patente. */
export function getTypeClass(type) {
  return TYPE_LABELS[type]?.cls || 'unk';
}

/**
 * Color del frame de la patente en la cámara:
 *   - verde de confirmación mientras parpadea (una sola vez) al
 *     confirmar que la patente está registrada;
 *   - después, el color del tipo (NE verde / AD azul / PA rojo);
 *   - si no se sabe el tipo, ámbar de "no registrado".
 */
export function getFrameColor(type, confirmando = false) {
  if (confirmando) return CONFIRM_FLASH_COLOR;
  return PLATE_TYPE_COLORS[type] || UNKNOWN_PLATE_COLOR;
}

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
