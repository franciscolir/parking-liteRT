import { describe, it, expect } from 'vitest';
import {
  PLATE_TYPES,
  PLATE_TYPE_VALUES,
  TYPE_LABELS,
  REVIEW_LABEL,
  isValidPlateType,
  getTypeLabel,
  detectPlateType,
} from '../../plate-types.js';

describe('plate-types.js', () => {
  it('debe definir exactamente los 3 tipos existentes en la app', () => {
    expect(PLATE_TYPE_VALUES).toEqual([
      'special_needs',
      'administration',
      'first_aid',
    ]);
    expect(PLATE_TYPES).toHaveLength(3);
  });

  it('debe exponer las etiquetas usadas por los badges', () => {
    expect(TYPE_LABELS.special_needs.label).toBe('Necesidades especiales');
    expect(TYPE_LABELS.administration.label).toBe('Administración');
    expect(TYPE_LABELS.first_aid.label).toBe('Primeros auxilios');
    expect(REVIEW_LABEL).toBe('Revisión necesaria');
  });

  it('debe validar los tipos', () => {
    expect(isValidPlateType('special_needs')).toBe(true);
    expect(isValidPlateType('administration')).toBe(true);
    expect(isValidPlateType('first_aid')).toBe(true);
    expect(isValidPlateType('registered')).toBe(false);
    expect(isValidPlateType('stolen')).toBe(false);
    expect(isValidPlateType('')).toBe(false);
    expect(isValidPlateType(null)).toBe(false);
  });

  it('debe obtener la etiqueta de un tipo', () => {
    expect(getTypeLabel('first_aid')).toBe('Primeros auxilios');
    expect(getTypeLabel('desconocido')).toBe('desconocido');
    expect(getTypeLabel(null)).toBe('');
  });

  describe('detectPlateType', () => {
    it('debe detectar primeros auxilios', () => {
      expect(detectPlateType('llega la ambulancia')).toBe('first_aid');
      expect(detectPlateType('es para primeros auxilios')).toBe('first_aid');
      expect(detectPlateType('Cruz Roja')).toBe('first_aid');
    });

    it('debe detectar administración', () => {
      expect(detectPlateType('auto de la administración')).toBe('administration');
      expect(detectPlateType('comité organizador')).toBe('administration');
    });

    it('debe detectar necesidades especiales', () => {
      expect(detectPlateType('silla de ruedas')).toBe('special_needs');
      expect(detectPlateType('persona con discapacidad')).toBe('special_needs');
    });

    it('debe ignorar acentos y mayúsculas', () => {
      expect(detectPlateType('AMBULANCIA')).toBe('first_aid');
      expect(detectPlateType('Administración')).toBe('administration');
    });

    it('debe devolver null si no hay coincidencia', () => {
      expect(detectPlateType('visita de proveedor')).toBeNull();
      expect(detectPlateType('')).toBeNull();
      expect(detectPlateType(null)).toBeNull();
    });

    it('debe devolver null si el contexto es ambiguo', () => {
      expect(detectPlateType('ambulancia de la administración')).toBeNull();
    });
  });
});
