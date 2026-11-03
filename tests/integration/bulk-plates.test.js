import { describe, it, expect, vi } from 'vitest';
import {
  BulkPlateSession,
  bulkRowStatus,
  insertBulkPlates,
} from '../../bulk-plates.js';

const TEXTO = [
  'Buenos días, para hoy ingresan:',
  'ABCD12 visita',
  'BCDF34 proveedor',
  'También viene el vehículo patente AB-CD-13.',
].join('\n');

describe('bulk-plates.js', () => {
  describe('análisis', () => {
    it('crea una fila por patente detectada y no guarda nada', () => {
      const session = new BulkPlateSession();
      session.analyze(TEXTO, []);

      expect(session.analyzed).toBe(true);
      expect(session.rows).toHaveLength(3);
      expect(session.rows.map(r => r.plate)).toEqual(['ABCD12', 'BCDF34', 'ABCD13']);
      // Sin tipo detectable -> por defecto 'special_needs' (no bloquea el guardado)
      expect(session.rows.every(r => r.type === 'special_needs')).toBe(true);
      expect(session.rows.every(r => !r.needsReview)).toBe(true);
    });

    it('detecta duplicados dentro del texto y los deja fuera del guardado', () => {
      const session = new BulkPlateSession();
      session.analyze('ABCD12 ... AB-CD-12', []);

      expect(session.rows).toHaveLength(2);
      // Las dos filas son la misma patente: el usuario decide cuál guardar.
      expect(session.rows[0].plateStatus).toBe('duplicate');
      expect(session.rows[1].plateStatus).toBe('duplicate');
      expect(session.rows[0].include).toBe(true);
      expect(session.rows[1].include).toBe(false);
      expect(bulkRowStatus(session.rows[1]).label).toBe('Duplicada');
    });

    it('marca como ya existente las patentes que están en la base', () => {
      const session = new BulkPlateSession();
      session.analyze('ABCD12', [{ plate: 'ABCD12', type: 'first_aid' }]);

      expect(session.rows[0].plateStatus).toBe('existing');
      expect(session.rows[0].include).toBe(false);
      expect(bulkRowStatus(session.rows[0]).label).toBe('Ya existente');
    });
  });

  describe('edición (casos 14 a 17)', () => {
    it('14. permite editar la patente antes de guardar', () => {
      const session = new BulkPlateSession();
      session.analyze('ABCD12', []);
      const row = session.rows[0];

      session.updatePlate(row.id, 'ab-cd 99');
      expect(session.rows[0].plate).toBe('ABCD99');

      session.updateType(row.id, 'first_aid');
      const payload = session.buildPayload('user-1');
      expect(payload).toEqual([
        { plate: 'ABCD99', type: 'first_aid', reported_by: 'user-1', is_active: true },
      ]);
    });

    it('15. permite editar el tipo antes de guardar', () => {
      const session = new BulkPlateSession();
      session.analyze('ABCD12', []);
      const row = session.rows[0];

      // El tipo por defecto ya permite guardar sin tocar nada
      expect(session.rows[0].type).toBe('special_needs');
      expect(session.validate().ok).toBe(true);

      session.updateType(row.id, 'administration');
      expect(session.rows[0].type).toBe('administration');
      expect(session.rows[0].needsReview).toBe(false);
      expect(bulkRowStatus(session.rows[0]).label).toBe('Detectada');
      expect(session.validate().ok).toBe(true);
    });

    it('no acepta un tipo que no sea uno de los 3 válidos', () => {
      const session = new BulkPlateSession();
      session.analyze('ABCD12', []);
      session.updateType(session.rows[0].id, 'registered');
      // Un tipo inválido vuelve al tipo por defecto (no deja la fila sin tipo)
      expect(session.rows[0].type).toBe('special_needs');
    });

    it('16. permite eliminar una detección', () => {
      const session = new BulkPlateSession();
      session.analyze(TEXTO, []);

      session.removeRow(session.rows[1].id);
      expect(session.rows).toHaveLength(2);
      expect(session.rows.map(r => r.plate)).toEqual(['ABCD12', 'ABCD13']);
    });

    it('17. permite agregar manualmente una patente', () => {
      const session = new BulkPlateSession();
      session.analyze('', []);

      const row = session.addManualRow('WXYZ98', 'special_needs');
      expect(session.rows).toHaveLength(1);
      expect(session.rows[0].manual).toBe(true);
      expect(session.rows[0].plateStatus).toBe('ok');
      expect(session.rows[0].needsReview).toBe(false);

      const payload = session.buildPayload('user-1');
      expect(payload).toHaveLength(1);
      expect(payload[0]).toMatchObject({ plate: 'WXYZ98', type: 'special_needs' });
      expect(row.id).toBeTruthy();
    });

    it('una fila manual sin tipo toma el tipo por defecto', () => {
      const session = new BulkPlateSession();
      session.addManualRow('WXYZ98');
      expect(session.rows[0].type).toBe('special_needs');
      expect(session.rows[0].needsReview).toBe(false);
      expect(session.validate().ok).toBe(true);
    });
  });

  describe('duplicados', () => {
    it('permite conservar una sola fila de un grupo duplicado', () => {
      const session = new BulkPlateSession();
      session.analyze('ABCD12 ... AB-CD-12', []);
      session.updateType(session.rows[0].id, 'first_aid');
      session.updateType(session.rows[1].id, 'first_aid');

      // Por defecto se guarda la primera aparición.
      let { toSave } = session.validate();
      expect(toSave).toHaveLength(1);
      expect(toSave[0].id).toBe(session.rows[0].id);

      // Si el usuario elige la otra, la primera queda omitida.
      session.setInclude(session.rows[1].id, true);
      toSave = session.validate().toSave;
      expect(toSave).toHaveLength(1);
      expect(toSave[0].id).toBe(session.rows[1].id);
      expect(session.rows[0].include).toBe(false);
    });

    it('removeDuplicates elimina las repeticiones y conserva la primera', () => {
      const session = new BulkPlateSession();
      session.analyze('ABCD12 ... AB-CD-12 ... ABCD12', []);
      expect(session.rows).toHaveLength(3);
      expect(session.rows.every(r => r.plateStatus === 'duplicate')).toBe(true);

      const { removed, duplicates, existing } = session.removeDuplicates();
      expect(removed).toBe(2);
      expect(duplicates).toBe(2);
      expect(existing).toBe(0);
      expect(session.rows).toHaveLength(1);
      // La sobreviviente ya no está marcada como duplicada
      expect(session.rows[0].plateStatus).toBe('ok');
      expect(session.validate().toSave).toHaveLength(1);
    });

    it('removeDuplicates no toca las filas sin duplicados', () => {
      const session = new BulkPlateSession();
      session.analyze('ABCD12\nBCDF34', []);
      expect(session.removeDuplicates().removed).toBe(0);
      expect(session.rows).toHaveLength(2);
    });

    it('removeDuplicates también elimina las que ya existen en la base', () => {
      const session = new BulkPlateSession();
      session.analyze('ABCD12 ... BCDF34 ... ABCD12', [{ plate: 'BCDF34', type: 'administration' }]);

      const { removed, duplicates, existing } = session.removeDuplicates();
      expect(removed).toBe(2);
      expect(duplicates).toBe(1);
      expect(existing).toBe(1);
      // Solo queda la patente nueva: la lista queda limpia para guardar
      expect(session.rows).toHaveLength(1);
      expect(session.rows[0].plate).toBe('ABCD12');
      expect(session.validate().toSave).toHaveLength(1);
    });
  });

  describe('validación y resumen', () => {
    it('solo las filas dudosas requieren revisión', () => {
      // La línea limpia queda a >30 chars de "casa" (keyword negativa),
      // así que solo "la casa 12" se marca como dudosa.
      const session = new BulkPlateSession();
      session.analyze('ABCD12 entra temprano por la puerta principal\nla casa 12 queda al lado', []);

      const { errors, summary } = session.validate();
      // ABCD12 queda lista con el tipo por defecto; la dudosa pide revisión
      expect(summary.total).toBe(2);
      expect(summary.ready).toBe(1);
      expect(summary.review).toBe(1);
      expect(errors.some(e => e.message.includes('requiere revisión'))).toBe(true);
    });

    it('bloquea el guardado si la patente editada es inválida', () => {
      const session = new BulkPlateSession();
      session.analyze('ABCD12', []);
      session.updateType(session.rows[0].id, 'first_aid');
      session.updatePlate(session.rows[0].id, '123');

      const { ok, errors } = session.validate();
      expect(ok).toBe(false);
      expect(errors[0].message).toContain('Patente inválida');
    });

    it('exige confirmar las detecciones dudosas', () => {
      const session = new BulkPlateSession();
      session.analyze('la casa 12 queda al lado', []);
      session.updateType(session.rows[0].id, 'first_aid');

      expect(session.rows[0].doubtful).toBe(true);
      expect(session.validate().ok).toBe(false);

      session.markReviewed(session.rows[0].id);
      expect(session.validate().ok).toBe(true);
    });

    it('no guarda nada si no hay filas listas', () => {
      const session = new BulkPlateSession();
      session.analyze('texto sin patentes', []);
      expect(session.validate().ok).toBe(false);
      expect(session.validate().toSave).toHaveLength(0);
    });
  });

  describe('guardado (caso 18)', () => {
    it('18. informa el error y no guarda parcialmente cuando la BD rechaza', async () => {
      const insert = vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({
          data: null,
          error: { message: '23505 duplicate key value violates unique constraint "plates_plate_key"' },
        }),
      });
      const client = { from: vi.fn().mockReturnValue({ insert }) };

      await expect(
        insertBulkPlates(client, [{ plate: 'ABCD12', type: 'first_aid' }])
      ).rejects.toThrow(/duplicate key/);

      // Un solo INSERT: si falla, no queda nada guardado.
      expect(insert).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledWith([{ plate: 'ABCD12', type: 'first_aid' }]);
    });

    it('devuelve las filas insertadas cuando todo sale bien', async () => {
      const rows = [{ plate: 'ABCD12', type: 'first_aid' }];
      const insert = vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ data: rows, error: null }),
      });
      const client = { from: vi.fn().mockReturnValue({ insert }) };

      await expect(insertBulkPlates(client, rows)).resolves.toEqual(rows);
      expect(client.from).toHaveBeenCalledWith('plates');
    });

    it('rechaza un lote vacío', async () => {
      await expect(insertBulkPlates({}, [])).rejects.toThrow(/No hay patentes/);
    });
  });
});
