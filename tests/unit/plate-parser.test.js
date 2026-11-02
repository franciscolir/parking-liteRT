import { describe, it, expect } from 'vitest';
import { parsePlateText, extractPlateCandidates } from '../../plate-parser.js';

describe('plate-parser.js', () => {
  describe('extracción', () => {
    it('1. detecta una patente claramente escrita', () => {
      const { rows } = parsePlateText('ABCD12');
      expect(rows).toHaveLength(1);
      expect(rows[0].plate).toBe('ABCD12');
    });

    it('2. detecta varias patentes en diferentes líneas', () => {
      const text = ['ABCD12 visita', 'BCDF34 proveedor', 'EFGH56'].join('\n');
      const { rows } = parsePlateText(text);
      expect(rows.map(r => r.plate)).toEqual(['ABCD12', 'BCDF34', 'EFGH56']);
      expect(rows.map(r => r.line)).toEqual([1, 2, 3]);
    });

    it('3. detecta varias patentes dentro de un mismo mensaje', () => {
      const { rows } = parsePlateText('ABCD12 y BCDF34 entran temprano');
      expect(rows.map(r => r.plate)).toEqual(['ABCD12', 'BCDF34']);
    });

    it('4. normaliza patente con guiones', () => {
      const { rows } = parsePlateText('ingresa AB-CD-12');
      expect(rows).toHaveLength(1);
      expect(rows[0].plate).toBe('ABCD12');
      expect(rows[0].raw).toBe('AB-CD-12');
    });

    it('5. normaliza patente con espacios', () => {
      expect(parsePlateText('ingresa AB CD 12').rows[0].plate).toBe('ABCD12');
      expect(parsePlateText('ingresa ABCD 12').rows[0].plate).toBe('ABCD12');
    });

    it('6. detecta la misma patente repetida con formatos diferentes', () => {
      const { rows, stats } = parsePlateText('ABCD12 ... AB-CD-12 ... ABCD 12');
      expect(rows).toHaveLength(3);
      expect(rows[0].duplicateOf).toBeNull();
      expect(rows[1].duplicateOf).toBe('r1');
      expect(rows[2].duplicateOf).toBe('r1');
      expect(stats.duplicates).toBe(2);
    });

    it('7. no detecta números que no son patentes', () => {
      const text = [
        'Llámame al 912345678 por favor',
        'Código 12345 y boleta 987654',
        'Fecha 12/05/2026 a las 10:30',
        'Casa N° 88, calle principal',
        'Valor $45000 en 3 cuotas',
      ].join('\n');
      const { rows } = parsePlateText(text);
      expect(rows).toHaveLength(0);
    });

    it('7b. no detecta fragmentos dentro de palabras más largas', () => {
      expect(parsePlateText('xABCD12').rows).toHaveLength(0);
      expect(parsePlateText('ABCD12x').rows).toHaveLength(0);
      expect(parsePlateText('camioneta2').rows).toHaveLength(0);
    });

    it('8. deja el tipo sin determinar cuando no hay evidencia', () => {
      const { rows } = parsePlateText('ABCD12');
      expect(rows[0].type).toBeNull();
    });

    it('8b. no inventa tipos para roles que no existen en el sistema', () => {
      const { rows } = parsePlateText('ABCD12 visita\nBCDF34 proveedor\nEFGH56 trabajador');
      expect(rows.every(r => r.type === null)).toBe(true);
    });

    it('9. detecta el tipo según las reglas del sistema', () => {
      const { rows } = parsePlateText(
        ['ABCD12 ambulancia', 'BCDF34 de la administración', 'EFGH56 silla de ruedas'].join('\n')
      );
      expect(rows.map(r => r.type)).toEqual(['first_aid', 'administration', 'special_needs']);
    });

    it('9b. asigna el tipo a la patente más cercana en la misma línea', () => {
      const { rows } = parsePlateText('ABCD12 ambulancia, BCDF34 administración');
      expect(rows[0].type).toBe('first_aid');
      expect(rows[1].type).toBe('administration');
    });

    it('11. devuelve 0 filas con texto vacío', () => {
      expect(parsePlateText('').rows).toHaveLength(0);
      expect(parsePlateText('   \n  ').rows).toHaveLength(0);
      expect(parsePlateText(null).rows).toHaveLength(0);
    });

    it('12. tolera caracteres especiales', () => {
      const { rows } = parsePlateText('!!! @@@ ABCD12 ### (visita)');
      expect(rows).toHaveLength(1);
      expect(rows[0].plate).toBe('ABCD12');
    });

    it('13. procesa muchos mensajes pegados a la vez', () => {
      const messages = Array.from(
        { length: 50 },
        (_, i) => `Mensaje ${i + 1}: patente ABCD${String(i).padStart(2, '0')}`
      );
      const { rows } = parsePlateText(messages.join('\n'));
      expect(rows).toHaveLength(50);
      expect(rows[49].line).toBe(50);
    });

    it('debe marcar como dudoso un token en contexto no patentable', () => {
      const { rows } = parsePlateText('la casa 12 queda al lado');
      expect(rows).toHaveLength(1);
      expect(rows[0].doubtful).toBe(true);
    });

    it('no marca como dudoso cuando el texto dice "patente"', () => {
      const { rows } = parsePlateText('patente de la casa: ABCD12');
      expect(rows[0].doubtful).toBe(false);
    });

    it('marca como ya existente la patente presente en la base', () => {
      const { rows, stats } = parsePlateText('ABCD12', { existingPlates: ['ABCD12'] });
      expect(rows[0].existing).toBe(true);
      expect(stats.existing).toBe(1);
    });
  });

  describe('extractPlateCandidates', () => {
    it('devuelve solo los candidatos con formato válido', () => {
      const candidates = extractPlateCandidates('ABCD12 y AB-CD-34 y hola');
      expect(candidates.map(c => c.plate)).toEqual(['ABCD12', 'ABCD34']);
    });
  });

  describe('snippets', () => {
    it('guarda el fragmento de texto original con la patente', () => {
      const { rows } = parsePlateText('Buenos días, para hoy ingresan: ABCD12 visita');
      expect(rows[0].snippetText).toContain('ABCD12');
      expect(rows[0].snippet.match).toBe('ABCD12');
      expect(rows[0].snippet.before).toContain('Buenos días');
    });
  });
});
