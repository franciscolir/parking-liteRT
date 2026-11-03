/**
 * bulk-plates.js - Estado y validaciones del "Ingreso masivo por texto"
 *
 * Capa de sesión (sin DOM, sin Supabase) que vive entre el parser
 * (plate-parser.js) y la UI (admin.js):
 *
 *   analizar -> filas -> editar/revisar -> validar -> payload de guardado
 *
 * Reglas de estado de una fila:
 *   plateStatus: 'ok' | 'invalid' | 'existing' | 'duplicate'
 *     - 'duplicate': la patente aparece más de una vez en la lista; el
 *       usuario decide cuál se guarda (include) y el resto queda omitida.
 *   needsReview: falta el tipo o el contexto fue dudoso
 *   include: la fila entra en el lote a guardar.
 *
 * Nunca escribe en la base de datos: el guardado lo dispara admin.js
 * usando insertBulkPlates() (un único INSERT = atómico en Postgres).
 */

import { validatePlate, normalizePlate } from './validator.js';
import { isValidPlateType } from './plate-types.js';
import { parsePlateText } from './plate-parser.js';

/**
 * Tipo por defecto cuando el texto no indica uno: "no sé qué es" se
 * interpreta como necesidades especiales (regla del producto). Así una
 * fila recién analizada ya está lista para guardar.
 */
export const DEFAULT_PLATE_TYPE = 'special_needs';

/** Estados visibles en la columna "Estado". */
export const BULK_STATUS = {
  detected: { label: 'Detectada', cls: 'detected' },
  review: { label: 'Revisar', cls: 'review' },
  duplicate: { label: 'Duplicada', cls: 'duplicate' },
  existing: { label: 'Ya existente', cls: 'existing' },
  invalid: { label: 'Inválida', cls: 'invalid' },
};

/** Estado interno de la patente de la fila. */
export const PLATE_STATUS = {
  ok: 'ok',
  invalid: 'invalid',
  existing: 'existing',
  duplicate: 'duplicate',
};

/**
 * Estado visible de una fila (precedencia: inválida > ya existe >
 * duplicada > revisar > detectada).
 */
export function bulkRowStatus(row) {
  if (row.plateStatus === PLATE_STATUS.invalid) return BULK_STATUS.invalid;
  if (row.plateStatus === PLATE_STATUS.existing) return BULK_STATUS.existing;
  if (row.plateStatus === PLATE_STATUS.duplicate) return BULK_STATUS.duplicate;
  if (row.needsReview) return BULK_STATUS.review;
  return BULK_STATUS.detected;
}

export class BulkPlateSession {
  constructor() {
    this.rows = [];
    this.analyzed = false;
    this.existingMap = new Map(); // plate normalizada -> { plate, type }
    this.stats = null;
    this._seq = 0;
  }

  // ============================================================
  // ANÁLISIS (no toca la base de datos)
  // ============================================================

  /**
   * Analiza el texto pegado y crea las filas de la tabla.
   * @param {string} text
   * @param {Array<string|{plate:string,type?:string}>} existingPlates
   */
  analyze(text, existingPlates = []) {
    const parsed = parsePlateText(text, { existingPlates });

    this.existingMap = new Map();
    for (const p of existingPlates || []) {
      const plate = normalizePlate(typeof p === 'string' ? p : p?.plate || '');
      if (!plate) continue;
      const type = typeof p === 'string' ? null : p.type ?? null;
      this.existingMap.set(plate, { plate, type });
    }

    this.stats = parsed.stats;
    this.rows = parsed.rows.map(row => ({
      ...row,
      plateInput: row.plate,
      type: isValidPlateType(row.type) ? row.type : DEFAULT_PLATE_TYPE,
      include: !row.duplicateOf && !this.existingMap.has(row.plate),
      manual: false,
    }));

    this.analyzed = true;
    this.recompute();
    return this.rows;
  }

  /**
   * Actualiza el set de patentes ya existentes (verificado contra la base de
   * datos) y recalcula los estados de las filas.
   */
  setExistingPlates(existingPlates = []) {
    this.existingMap = new Map();
    for (const p of existingPlates || []) {
      const plate = normalizePlate(typeof p === 'string' ? p : p?.plate || '');
      if (!plate) continue;
      const type = typeof p === 'string' ? null : p.type ?? null;
      this.existingMap.set(plate, { plate, type });
    }
    for (const row of this.rows) {
      if (this.existingMap.has(row.plate)) row.include = false;
    }
    this.recompute();
  }

  // ============================================================
  // EDICIÓN
  // ============================================================

  /** Cambia la patente de una fila (el usuario la corrigió). */
  updatePlate(id, value) {
    const row = this.get(id);
    if (!row) return null;
    row.plateInput = String(value ?? '');
    // Si la patente sigue siendo válida, el usuario ya la revisó.
    const plate = normalizePlate(row.plateInput);
    if (plate && validatePlate(plate)) row.doubtful = false;
    this.recompute();
    return row;
  }

  /** Cambia el tipo de una fila. Un valor inválido vuelve al tipo por defecto. */
  updateType(id, value) {
    const row = this.get(id);
    if (!row) return null;
    row.type = isValidPlateType(value) ? value : DEFAULT_PLATE_TYPE;
    this.recompute();
    return row;
  }

  /** Marca una fila dudosa como revisada (el usuario la confirma). */
  markReviewed(id) {
    const row = this.get(id);
    if (!row) return null;
    row.doubtful = false;
    this.recompute();
    return row;
  }

  /** Marca la fila como incluida/omitida (duplicados). */
  setInclude(id, include) {
    const row = this.get(id);
    if (!row) return null;
    row.include = !!include;
    if (row.include && row.plate) {
      // Solo puede quedar una fila por patente en el lote a guardar.
      for (const other of this.rows) {
        if (other.id !== row.id && other.plate && other.plate === row.plate) {
          other.include = false;
        }
      }
    }
    this.recompute();
    return row;
  }

  /** Elimina una fila de la tabla. */
  removeRow(id) {
    const index = this.rows.findIndex(r => r.id === id);
    if (index === -1) return false;
    this.rows.splice(index, 1);
    this.recompute();
    return true;
  }

  /**
   * Limpia el lote: elimina las filas duplicadas (conservando la primera
   * aparición) Y las que ya existen en la base de datos. Es lo que hace la
   * píldora de limpieza del resumen, para dejar la lista lista para guardar.
   * @returns {{removed:number, duplicates:number, existing:number}}
   */
  removeDuplicates() {
    const seen = new Set();
    const toRemove = [];
    let duplicates = 0;
    let existing = 0;

    for (const row of this.rows) {
      // Ya está en la base: se elimina de la lista (no se puede guardar).
      if (row.plateStatus === PLATE_STATUS.existing) {
        toRemove.push(row.id);
        existing++;
        continue;
      }

      if (row.plateStatus !== PLATE_STATUS.duplicate || !row.plate) continue;
      if (seen.has(row.plate)) {
        toRemove.push(row.id);
        duplicates++;
      } else {
        seen.add(row.plate);
      }
    }

    for (const id of toRemove) this.removeRow(id);
    return { removed: toRemove.length, duplicates, existing };
  }

  /** Agrega una fila manual (el usuario la escribe a mano). */
  addManualRow(plate = '', type = null) {
    const id = `m${++this._seq}`;
    const row = {
      id,
      raw: plate,
      plate: normalizePlate(plate),
      plateInput: plate,
      type: isValidPlateType(type) ? type : DEFAULT_PLATE_TYPE,
      doubtful: false,
      duplicateOf: null,
      existing: false,
      line: null,
      snippetText: '',
      snippet: { before: '', match: '', after: '' },
      include: true,
      manual: true,
    };
    this.rows.push(row);
    this.recompute();
    return row;
  }

  /** Marca una patente como ya existente (por error de la base de datos). */
  markExisting(plate, type = null) {
    const normalized = normalizePlate(plate);
    if (!normalized) return;
    this.existingMap.set(normalized, { plate: normalized, type });
    this.recompute();
  }

  // ============================================================
  // ESTADO
  // ============================================================

  get(id) {
    return this.rows.find(r => r.id === id) || null;
  }

  /** Recalcula plateStatus / needsReview de todas las filas. */
  recompute() {
    const groups = new Map();

    for (const row of this.rows) {
      const plate = normalizePlate(row.plateInput);
      row.plate = plate;

      if (!plate || !validatePlate(plate)) {
        row.plateStatus = PLATE_STATUS.invalid;
        row.needsReview = false;
        row.duplicateOf = null;
        continue;
      }

      if (this.existingMap.has(plate)) {
        row.plateStatus = PLATE_STATUS.existing;
        row.needsReview = false;
        row.duplicateOf = null;
        continue;
      }

      if (!groups.has(plate)) groups.set(plate, []);
      groups.get(plate).push(row);
    }

    for (const group of groups.values()) {
      const duplicated = group.length > 1;
      for (const row of group) {
        row.plateStatus = duplicated ? PLATE_STATUS.duplicate : PLATE_STATUS.ok;
        row.duplicateOf = duplicated ? group[0].id : null;
        row.needsReview = !row.type || !!row.doubtful;
      }
    }
  }

  /** Resumen para mostrar en pantalla y en la confirmación. */
  summary() {
    const summary = {
      total: this.rows.length,
      ready: 0,
      review: 0,
      duplicate: 0,
      existing: 0,
      invalid: 0,
      manual: 0,
      discarded: this.stats?.discarded || 0,
    };

    for (const row of this.rows) {
      if (row.manual) summary.manual++;
      if (row.plateStatus === PLATE_STATUS.invalid) {
        summary.invalid++;
      } else if (row.plateStatus === PLATE_STATUS.existing) {
        summary.existing++;
      } else if (row.plateStatus === PLATE_STATUS.duplicate) {
        if (!row.include) {
          // La repetición que se queda fuera del lote.
          summary.duplicate++;
        } else if (row.needsReview) {
          // La que se conserva, pero todavía falta revisarla.
          summary.review++;
        } else {
          summary.ready++;
        }
      } else if (row.needsReview) {
        summary.review++;
      } else if (row.include) {
        summary.ready++;
      }
    }

    return summary;
  }

  /**
   * Valida todas las filas.
   * @returns {{ ok:boolean, toSave:Array, errors:Array, warnings:Array, summary:object }}
   */
  validate() {
    const errors = [];
    const warnings = [];
    const toSave = [];
    const inBatch = new Map();

    for (const row of this.rows) {
      if (row.plateStatus === PLATE_STATUS.invalid) {
        errors.push({
          rowId: row.id,
          message: `Patente inválida: "${row.plateInput || '(vacío)'}"`,
        });
        continue;
      }

      if (row.plateStatus === PLATE_STATUS.existing) {
        warnings.push({
          rowId: row.id,
          message: `${row.plate} ya existe en el sistema (no se guarda)`,
        });
        continue;
      }

      if (row.plateStatus === PLATE_STATUS.duplicate && !row.include) {
        warnings.push({
          rowId: row.id,
          message: `${row.plate} está duplicada en el texto (se omite)`,
        });
        continue;
      }

      if (!row.type) {
        errors.push({ rowId: row.id, message: `Falta el tipo de ${row.plate}` });
        continue;
      }

      if (row.doubtful) {
        errors.push({
          rowId: row.id,
          message: `${row.plate} requiere revisión (confírmala con ✓ para guardarla)`,
        });
        continue;
      }

      if (!row.include) {
        warnings.push({ rowId: row.id, message: `${row.plate} omitida` });
        continue;
      }

      if (inBatch.has(row.plate)) {
        errors.push({
          rowId: row.id,
          message: `${row.plate} está repetida en el lote`,
        });
        continue;
      }

      inBatch.set(row.plate, row.id);
      toSave.push(row);
    }

    const summary = this.summary();
    summary.ready = toSave.length;

    return {
      ok: errors.length === 0 && toSave.length > 0,
      toSave,
      errors,
      warnings,
      summary,
    };
  }

  /** Payload para el INSERT (un solo lote). */
  buildPayload(userId = null) {
    const { toSave } = this.validate();
    return toSave.map(row => ({
      plate: normalizePlate(row.plateInput),
      type: row.type,
      reported_by: userId || null,
      is_active: true,
    }));
  }

  /** Limpia la sesión (empezar de nuevo). */
  reset() {
    this.rows = [];
    this.analyzed = false;
    this.existingMap = new Map();
    this.stats = null;
    this._seq = 0;
  }
}

/**
 * Guarda el lote de patentes con un ÚNICO INSERT.
 *
 * Un solo statement en Postgres es atómico: si una fila falla, no se
 * guarda ninguna (no hay cargas parciales).
 *
 * @param {{ from: Function }} client cliente Supabase (o mock en tests)
 * @param {Array<{plate:string,type:string}>} payload
 * @returns {Promise<Array<object>>} filas insertadas
 */
export async function insertBulkPlates(client, payload) {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('No hay patentes para guardar');
  }

  const result = await client.from('plates').insert(payload).select();
  if (result?.error) {
    throw new Error(result.error.message || 'Error al guardar las patentes');
  }
  return result?.data || [];
}
