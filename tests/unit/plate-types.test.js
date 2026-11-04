import { describe, it, expect } from 'vitest';
import {
  PLATE_TYPES,
  PLATE_TYPE_VALUES,
  TYPE_LABELS,
  REVIEW_LABEL,
  SCAN_STATUS_LABELS,
  PLATE_TYPE_COLORS,
  CONFIRM_FLASH_COLOR,
  CONFIRM_FLASH_MS,
  UNKNOWN_PLATE_COLOR,
  isValidPlateType,
  getTypeLabel,
  getTypeClass,
  getTypeColor,
  getFrameColor,
  getScanStatus,
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

  describe('getScanStatus', () => {
    it('muestra el tipo de la patente, no "Desconocido"', () => {
      // Bug: el historial comparaba el status contra 'success'/'danger'
      // (clases CSS) y toda patente registrada salía como desconocida.
      expect(getScanStatus('special_needs').label).toBe('Necesidades especiales');
      expect(getScanStatus('administration').label).toBe('Administración');
      expect(getScanStatus('first_aid').label).toBe('Primeros auxilios');
      expect(getScanStatus('unknown').label).toBe('Desconocido');
      expect(getScanStatus('error').label).toBe('Error');
    });

    it('una patente registrada no se pinta como desconocida', () => {
      expect(getScanStatus('special_needs').cls).not.toBe('unk');
      expect(getScanStatus('administration').cls).not.toBe('unk');
      expect(getScanStatus('first_aid').cls).not.toBe('unk');
      expect(getScanStatus('unknown').cls).toBe('unk');
    });

    it('acepta los valores antiguos guardados en la base', () => {
      expect(getScanStatus('success').label).toBe('Registrado');
      expect(getScanStatus('danger').label).toBe('Denunciado');
      expect(getScanStatus('warning').label).toBe('Desconocido');
    });

    it('cae en Desconocido si el status no existe', () => {
      expect(getScanStatus('raro').label).toBe('raro');
      expect(getScanStatus('raro').cls).toBe('unk');
      expect(getScanStatus(null).label).toBe('Desconocido');
      expect(getScanStatus(undefined).cls).toBe('unk');
    });

    it('el mapa cubre los 3 tipos y los estados especiales', () => {
      expect(Object.keys(SCAN_STATUS_LABELS)).toEqual(
        expect.arrayContaining([
          'special_needs', 'administration', 'first_aid', 'unknown', 'error',
        ])
      );
    });
  });

  describe('colores por tipo de patente', () => {
    it('NE = verde, AD = azul, PA = rojo', () => {
      expect(getTypeColor('special_needs')).toBe('#22c55e'); // verde
      expect(getTypeColor('administration')).toBe('#3b82f6');  // azul
      expect(getTypeColor('first_aid')).toBe('#ef4444');      // rojo
    });

    it('la clase CSS de cada tipo es ne / ad / pa', () => {
      expect(getTypeClass('special_needs')).toBe('ne');
      expect(getTypeClass('administration')).toBe('ad');
      expect(getTypeClass('first_aid')).toBe('pa');
    });

    it('un tipo desconocido no tiene color ni clase válida', () => {
      expect(getTypeColor('raro')).toBeNull();
      expect(getTypeColor(undefined)).toBeNull();
      expect(getTypeClass('raro')).toBe('unk');
      expect(getTypeClass(null)).toBe('unk');
    });

    it('el mapa TYPE_LABELS lleva el color y la clase del tipo', () => {
      for (const t of PLATE_TYPES) {
        expect(TYPE_LABELS[t.value].cls).toBe(t.cls);
        expect(TYPE_LABELS[t.value].color).toBe(t.color);
        expect(PLATE_TYPE_COLORS[t.value]).toBe(t.color);
      }
    });

    it('el badge del historial usa la clase del tipo, no la del estado', () => {
      expect(getScanStatus('special_needs').cls).toBe('ne');
      expect(getScanStatus('administration').cls).toBe('ad');
      expect(getScanStatus('first_aid').cls).toBe('pa');
    });
  });

  describe('getFrameColor', () => {
    it('sin confirmación devuelve el color del tipo', () => {
      expect(getFrameColor('special_needs')).toBe('#22c55e');
      expect(getFrameColor('administration')).toBe('#3b82f6');
      expect(getFrameColor('first_aid')).toBe('#ef4444');
    });

    it('durante la confirmación devuelve el verde de parpadeo', () => {
      expect(getFrameColor('special_needs', true)).toBe(CONFIRM_FLASH_COLOR);
      expect(getFrameColor('administration', true)).toBe(CONFIRM_FLASH_COLOR);
      expect(getFrameColor('first_aid', true)).toBe(CONFIRM_FLASH_COLOR);
      expect(CONFIRM_FLASH_COLOR).toBe('#00ff66');
    });

    it('una patente sin tipo usa el ámbar de "no registrado"', () => {
      expect(getFrameColor('unknown')).toBe(UNKNOWN_PLATE_COLOR);
      expect(getFrameColor(null)).toBe(UNKNOWN_PLATE_COLOR);
      expect(UNKNOWN_PLATE_COLOR).toBe('#ffcc00');
    });

    it('el parpadeo dura medio segundo', () => {
      expect(CONFIRM_FLASH_MS).toBe(500);
    });
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
