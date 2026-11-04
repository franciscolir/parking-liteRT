/**
 * whatsapp.js - Reporte de incidente por WhatsApp
 * ------------------------------------------------------------
 * Módulo puro (sin dependencias) para armar el mensaje del reporte
 * y el link de WhatsApp.
 *
 * Lo usa:
 *   - la vista "Registro" (botón "Enviar por WhatsApp"): manda el
 *     reporte al contacto de tipo "oficina" si lo hay.
 *   - la vista "Llamadas" (solo admin): manda el reporte al número
 *     que escribe el admin.
 *
 * Módulo ES nativo, sin bundler ni dependencias extra.
 */

/** Código de país por defecto (Chile) para los números locales. */
export const DEFAULT_COUNTRY_CODE = '56';

/**
 * Deja el número en formato internacional, solo dígitos, como lo
 * necesita wa.me.
 *
 *   '+56 9 8765 4321' → '56987654321'
 *   '0056 9 8765 4321' → '56987654321'
 *   '9 8765 4321'      → '56987654321'  (número local de 9 dígitos)
 *   '133'              → '133'          (no se le inventa el país)
 *
 * @param {string} phone
 * @returns {string} dígitos del número (vacío si no hay nada usable)
 */
export function normalizeWhatsAppNumber(phone) {
  let s = String(phone ?? '').trim();
  if (!s) return '';

  // '00' es el prefijo internacional: se quita antes de contar los dígitos.
  if (s.startsWith('00')) s = s.slice(2);
  s = s.replace(/\D/g, '');
  if (!s) return '';

  // Un móvil local de 9 dígitos (9 8765 4321) va con el código de país.
  if (s.length === 9 && !s.startsWith(DEFAULT_COUNTRY_CODE)) {
    s = DEFAULT_COUNTRY_CODE + s;
  }

  return s;
}

/**
 * Arma el mensaje del reporte de incidente.
 *
 * @param {{plate?:string, vehicle?:string, incident?:string,
 *          location?:string, description?:string}} data
 * @returns {string|null} el mensaje, o null si faltan los datos
 *   obligatorios (patente, vehículo e incidente).
 */
export function buildIncidentReportMessage(data = {}) {
  const plate = String(data.plate || '').trim().toUpperCase();
  const vehicle = String(data.vehicle || '').trim();
  const incident = String(data.incident || '').trim();
  const location = String(data.location || '').trim();
  const description = String(data.description || '').trim();

  if (!plate || !vehicle || !incident) return null;

  return [
    '🚨 *REPORTE DE INCIDENTE*',
    '',
    '*Patente:* ' + plate,
    '*Vehículo:* ' + vehicle,
    '*Incidente:* ' + incident,
    location ? '*Ubicación:* ' + location : '',
    description ? '*Descripción:* ' + description : '',
    '',
    'Enviado desde PlateDetect',
  ].filter(Boolean).join('\n');
}

/**
 * Link de WhatsApp con el mensaje listo para enviar.
 *
 * @param {string} phone número de destino ('' abre WhatsApp sin destino)
 * @param {string} message
 * @returns {string}
 */
export function buildWhatsappUrl(phone, message) {
  const num = normalizeWhatsAppNumber(phone);
  return 'https://wa.me/' + num + '?text=' + encodeURIComponent(String(message || ''));
}
