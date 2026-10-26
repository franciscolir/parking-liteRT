import { describe, it, expect } from 'vitest';
import { validatePlate, normalizePlate } from '../../validator.js';

describe('validator.js', () => {
  describe('normalizePlate', () => {
    it('debe convertir a mayúsculas y remover caracteres no alfanuméricos', () => {
      expect(normalizePlate('ab-123 cd')).toBe('AB123CD');
      expect(normalizePlate('AB 123')).toBe('AB123');
      expect(normalizePlate('a.b.c.1.2.3')).toBe('ABC123');
    });

    it('debe mantener solo letras y números', () => {
      expect(normalizePlate('ABC-123!@#')).toBe('ABC123');
    });

    it('debe manejar string vacío', () => {
      expect(normalizePlate('')).toBe('');
    });
  });

  describe('validatePlate', () => {
    it('debe validar formato AAAA00 (4 letras + 2 números)', () => {
      expect(validatePlate('ABCD12')).toBe(true);
      expect(validatePlate('ZZZZ99')).toBe(true);
      expect(validatePlate('AAAA00')).toBe(true);
    });

    it('debe validar formato AA0000 (2 letras + 4 números)', () => {
      expect(validatePlate('AB1234')).toBe(true);
      expect(validatePlate('XY9999')).toBe(true);
    });

    it('debe validar formato con guiones AA-0000 (se normaliza)', () => {
      expect(validatePlate('AB-1234')).toBe(true);
    });

    it('debe validar formato AA-00-00 (se normaliza)', () => {
      expect(validatePlate('AB-12-34')).toBe(true);
    });

    it('debe validar formato A0000 (1 letra + 4 números)', () => {
      expect(validatePlate('A1234')).toBe(true);
    });

    it('debe validar formato CDJ0000 (C/D/J + 4 números)', () => {
      // El patrón es ^C[DJ][0-9]{4}$ -> C + D/J + 4 dígitos
      expect(validatePlate('CD1234')).toBe(true);
      expect(validatePlate('CJ5678')).toBe(true);
      expect(validatePlate('CD-1234')).toBe(true); // con guión se normaliza
    });

    it('debe rechazar formatos inválidos', () => {
      // 3 letras + 3 números NO es válido
      expect(validatePlate('ABC123')).toBe(false);
      expect(validatePlate('A1')).toBe(false);
      expect(validatePlate('123456')).toBe(false);
      expect(validatePlate('ABCDEF')).toBe(false);
      expect(validatePlate('AB12')).toBe(false);
      expect(validatePlate('ABC12345')).toBe(false);
      expect(validatePlate('')).toBe(false);
    });

    it('debe rechazar strings con caracteres especiales (antes de normalizar)', () => {
      expect(validatePlate('AB@123')).toBe(false);
      expect(validatePlate('AB 123')).toBe(false);
    });
  });
});