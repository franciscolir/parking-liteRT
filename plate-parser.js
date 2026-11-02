/**
 * plate-parser.js - Parser de texto libre (WhatsApp) → patentes
 *
 * Reglas:
 *   - NO usa YOLO ni OCR: solo texto.
 *   - Reutiliza validator.js (validatePlate / normalizePlate) como única
 *     fuente de verdad sobre qué es una patente válida.
 *   - Minimiza falsos positivos: si el candidato no valida, se descarta.
 *     Si el contexto es dudoso, se marca para revisión (no se inventa).
 *
 * Estrategia de extracción: se tokeniza el texto (bloques de letras y de
 * dígitos) y se prueban combinaciones de 1-2 bloques de letras + 1-2 bloques
 * de dígitos unidos por espacios/guiones/puntos. Así "la casa 12" no se come
 * el texto anterior y "ABCD 12" / "AB-CD-12" / "AB CD 12" se normalizan
 * igual.
 *
 * Salida: filas con patente normalizada, tipo detectado (o null), estado
 * y el fragmento de texto original que permitió detectarla.
 */

import { validatePlate, normalizePlate } from './validator.js';
import { getTypeKeywords, PLATE_TYPE_VALUES } from './plate-types.js';

/** Tokens de letras o de dígitos. */
const TOKEN_RE = /[A-Za-z]+|[0-9]+/g;

/** Separadores admitidos entre partes de una patente (sin saltos de línea). */
const SEPARATOR_RE = /^[ \t.\-]*$/;

/**
 * Palabras que induce a pensar que el número NO es una patente
 * (teléfonos, códigos, direcciones, fechas, dinero, etc.).
 */
const NEGATIVE_KEYWORDS = [
  'tel', 'telf', 'telefono', 'cel', 'celular', 'movil', 'fono', 'whatsapp',
  'codigo', 'nro', 'numero', 'factura', 'boleta', 'dpto', 'depto', 'casa',
  'calle', 'direccion', 'domicilio', 'hora', 'fecha', 'anio', 'precio',
  'valor', 'cuota', 'piso', 'lote', 'ruta', 'mesa', 'agua', 'luz', 'patio',
  'hola', 'gracias', 'buenos dias', 'favor', 'atentamente', 'saludos',
];

/** Palabras que confirman que el token es una patente. */
const POSITIVE_KEYWORDS = [
  'patente', 'placa', 'vehiculo', 'camioneta', 'moto', 'camion', 'auto',
];

/**
 * Palabras comunes que, si forman parte del bloque de letras, hacen que la
 * detección sea dudosa ("la casa 12" -> CASA12 no es una patente real).
 * Solo de 3 letras o más: los bloques de 2 letras son Risk ("DE1234").
 */
const STOPWORDS = [
  'hola', 'gracias', 'vale', 'listo', 'lista', 'listas', 'entra', 'entran',
  'sale', 'salen', 'ingresa', 'ingresan', 'visita', 'visitas', 'proveedor',
  'proveedores', 'trabajador', 'trabajadores', 'vehiculo', 'patente',
  'placa', 'camioneta', 'camion', 'casa', 'calle', 'hora', 'horas', 'fecha',
  'mesa', 'agua', 'luz', 'patio', 'lote', 'lotes', 'piso', 'pisos', 'ruta',
  'norte', 'sur', 'oeste', 'este', 'esta', 'esto', 'esa', 'ese', 'eso',
  'todos', 'todo', 'para', 'pero', 'como', 'mas', 'con', 'sin', 'sobre',
  'entre', 'desde', 'hasta', 'donde', 'cuando', 'ahora', 'hoy', 'manana',
  'ayer', 'dias', 'dia', 'ano', 'mes', 'semana', 'vale',
];

const NEGATIVE_RE = new RegExp(`\\b(?:${NEGATIVE_KEYWORDS.join('|')})\\b`);
const POSITIVE_RE = new RegExp(`\\b(?:${POSITIVE_KEYWORDS.join('|')})\\b`);
const STOPWORD_SET = new Set(STOPWORDS);

/** Tamaño de la ventana (caracteres) usada para mirar el contexto. */
const CONTEXT_WINDOW = 30;

/** Distancia máxima (caracteres) para asociar una keyword a una patente. */
const MAX_KEYWORD_DISTANCE = 120;

/** Caracteres acentuados → base, conservando el largo del texto. */
const FOLD_MAP = {
  á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', ñ: 'n',
  Á: 'a', É: 'e', Í: 'i', Ó: 'o', Ú: 'u', Ü: 'u', Ñ: 'n',
};

/**
 * Normaliza el texto de entrada (espacios rare, guiones unicode, CRLF).
 */
function normalizeInput(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\r\n?/g, '\n');
}

/** Minúsculas sin acentos, conservando los índices del texto. */
function foldText(text) {
  return text
    .replace(/[áéíóúüñÁÉÍÓÚÜÑ]/g, c => FOLD_MAP[c] || c)
    .toLowerCase();
}

/** Límites de la línea que contiene `index`. */
function lineBounds(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  let end = text.indexOf('\n', index);
  if (end === -1) end = text.length;
  return { start, end };
}

/** Número de línea (1-based) de un índice. */
function lineNumber(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/** Divide el texto en bloques de letras / dígitos. */
function tokenize(text) {
  const re = new RegExp(TOKEN_RE.source, 'g');
  const tokens = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
      kind: /[0-9]/.test(match[0]) ? 'digits' : 'letters',
    });
  }
  return tokens;
}

/** ¿Se pueden unir estos dos tokens (separador simple, sin saltos de línea)? */
function canJoin(text, a, b) {
  return SEPARATOR_RE.test(text.slice(a.end, b.start));
}

function isAlnum(char) {
  return char != null && /[A-Za-z0-9]/.test(char);
}

/**
 * Genera todos los candidatos "tipo patente" posibles (antes de validarlos).
 * Cada candidato trae los bloques de letras que lo forman, para poder
 * detectar palabras comunes ("casa", "visita", ...).
 */
function findCandidates(text) {
  const tokens = tokenize(text);
  const found = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== 'letters') continue;

    for (let lettersCount = 1; lettersCount <= 2; lettersCount++) {
      const lastLetter = tokens[i + lettersCount - 1];
      if (!lastLetter || lastLetter.kind !== 'letters') continue;
      if (lettersCount === 2 && !canJoin(text, tokens[i], lastLetter)) continue;

      for (let digitsCount = 1; digitsCount <= 2; digitsCount++) {
        const firstDigit = tokens[i + lettersCount];
        const lastDigit = tokens[i + lettersCount + digitsCount - 1];
        if (!firstDigit || !lastDigit) continue;
        if (firstDigit.kind !== 'digits' || lastDigit.kind !== 'digits') continue;

        let joined = true;
        for (let k = i; k < i + lettersCount + digitsCount - 1; k++) {
          if (!canJoin(text, tokens[k], tokens[k + 1])) {
            joined = false;
            break;
          }
        }
        if (!joined) continue;

        const start = tokens[i].start;
        const end = lastDigit.end;
        // No puede quedar pegado a otro carácter alfanumérico.
        if (isAlnum(text[end])) continue;
        // "12/05/2026", "10:30", "12-34": el número sigue siendo más largo.
        if (/[/:.\-]/.test(text[end] || '') && /[0-9]/.test(text[end + 1] || '')) continue;

        const letterBlocks = [];
        for (let k = i; k < i + lettersCount; k++) letterBlocks.push(tokens[k].text);

        found.push({
          candidate: text.slice(start, end),
          start,
          end,
          letterBlocks,
          simple: lettersCount === 1 && digitsCount === 1,
        });
      }
    }
  }

  return found;
}

/** Distancia (en caracteres) entre dos spans que no se tocan. */
function spanDistance(a, b) {
  if (a.end <= b.start) return b.start - a.end;
  if (b.end <= a.start) return a.start - b.end;
  return 0; // se superponen
}

/**
 * A cada patente le asigna el tipo cuya keyword está más cerca.
 * Si le llegan keywords de 2 tipos distintos -> null (ambiguo).
 *
 * @param {string} text texto original
 * @param {Array<{start:number,end:number}>} candidates
 * @returns {Map<number,string|null>} índice de patente -> tipo
 */
function attributeTypes(text, candidates) {
  const folded = foldText(text);
  const keywords = getTypeKeywords();
  const hits = new Map(); // candidate index -> Set de tipos

  for (const type of PLATE_TYPE_VALUES) {
    for (const keyword of keywords[type]) {
      let from = 0;
      while (from <= folded.length) {
        const at = folded.indexOf(keyword, from);
        if (at === -1) break;
        from = at + keyword.length;

        const span = { start: at, end: at + keyword.length };

        // Preferir patentes de la misma línea.
        let best = -1;
        let bestDistance = Infinity;
        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          const { start: lineStart, end: lineEnd } = lineBounds(text, cand.start);
          if (span.start < lineStart || span.end > lineEnd) continue;
          const distance = spanDistance(span, cand);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
          }
        }

        // Si no hay en la misma línea, la más cercana (dentro del radio).
        if (best === -1) {
          for (let i = 0; i < candidates.length; i++) {
            const cand = candidates[i];
            const distance = spanDistance(span, cand);
            if (distance < bestDistance && distance <= MAX_KEYWORD_DISTANCE) {
              bestDistance = distance;
              best = i;
            }
          }
        }

        if (best === -1) continue;
        if (!hits.has(best)) hits.set(best, new Set());
        hits.get(best).add(type);
      }
    }
  }

  const result = new Map();
  candidates.forEach((_, i) => {
    const types = hits.get(i);
    result.set(i, types && types.size === 1 ? [...types][0] : null);
  });
  return result;
}

/**
 * Extrae los candidatos válidos del texto (sin interpretar tipos).
 * @returns {Array<{raw:string, plate:string, start:number, end:number}>}
 */
export function extractPlateCandidates(text) {
  const src = normalizeInput(text);
  const out = [];
  for (const c of findCandidates(src)) {
    const plate = normalizePlate(c.candidate);
    if (!validatePlate(plate)) continue;
    out.push({ raw: c.candidate, plate, start: c.start, end: c.end });
  }
  return out;
}

/**
 * Analiza un texto de WhatsApp y devuelve las filas para la tabla de revisión.
 *
 * @param {string} text texto pegado (uno o varios mensajes)
 * @param {{ existingPlates?: Array<string|{plate:string,type?:string}> }} options
 * @returns {{ rows: Array<object>, stats: object }}
 */
export function parsePlateText(text, options = {}) {
  const { existingPlates = [] } = options;

  const existing = new Set(
    existingPlates
      .map(p => normalizePlate(typeof p === 'string' ? p : p?.plate || ''))
      .filter(Boolean)
  );

  const src = normalizeInput(text);
  const rawCandidates = findCandidates(src);
  const candidates = [];
  let discarded = 0;

  for (const c of rawCandidates) {
    const plate = normalizePlate(c.candidate);
    if (!validatePlate(plate)) {
      // Solo se contabilizan los descartes "tipo patente" más simples.
      if (c.simple) discarded++;
      continue;
    }
    candidates.push({ ...c, plate });
  }

  const types = attributeTypes(src, candidates);

  const rows = [];
  const seen = new Map(); // plate -> id de la primera aparición

  candidates.forEach((cand, i) => {
    const { start: lineStart, end: lineEnd } = lineBounds(src, cand.start);

    // Ventana corta alrededor del candidato para detectar contexto dudoso.
    const window = src.slice(
      Math.max(0, cand.start - CONTEXT_WINDOW),
      Math.min(src.length, cand.end + CONTEXT_WINDOW)
    );
    const foldedWindow = foldText(window);

    const negative = NEGATIVE_RE.test(foldedWindow);
    const positive = POSITIVE_RE.test(foldedWindow);
    const wordLike = cand.letterBlocks.some(block =>
      STOPWORD_SET.has(foldText(block))
    );
    const doubtful = wordLike || (negative && !positive);

    const id = `r${i + 1}`;
    const duplicateOf = seen.has(cand.plate) ? seen.get(cand.plate) : null;
    if (!duplicateOf) seen.set(cand.plate, id);

    // Snippet: la línea original, recortada alrededor de la patente.
    const lineText = src.slice(lineStart, lineEnd);
    const relStart = cand.start - lineStart;
    const beforeRaw = lineText.slice(Math.max(0, relStart - 40), relStart);
    const afterRaw = lineText.slice(
      relStart + cand.candidate.length,
      relStart + cand.candidate.length + 50
    );
    const before = beforeRaw.length > 40 ? `…${beforeRaw.slice(-40)}` : beforeRaw;
    const after = afterRaw.length > 50 ? `${afterRaw.slice(0, 50)}…` : afterRaw;

    rows.push({
      id,
      raw: cand.candidate,
      plate: cand.plate,
      type: types.get(i) ?? null,
      doubtful,
      duplicateOf,
      existing: existing.has(cand.plate),
      line: lineNumber(src, cand.start),
      snippetText: `${before}${cand.candidate}${after}`.trim(),
      snippet: { before, match: cand.candidate, after },
    });
  });

  return {
    rows,
    stats: {
      candidates: rawCandidates.length,
      discarded,
      detected: rows.length,
      duplicates: rows.filter(r => r.duplicateOf).length,
      existing: rows.filter(r => r.existing).length,
      withoutType: rows.filter(r => !r.type).length,
    },
  };
}
