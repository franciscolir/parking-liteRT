import { describe, it, expect, beforeEach } from 'vitest';
import { Corrector } from '../../corrector.js';

describe('Corrector', () => {
  let corrector;

  beforeEach(() => {
    corrector = new Corrector();
  });

  describe('corrección SIN zonas detectadas (fallback: aplica AMBOS mapas a TODOS los chars)', () => {
    it('debe aplicar numberCorrections a letras (fallback behavior)', () => {
      // 'ABO' -> sin zonas (no termina en número) -> fallback
      // A: sin corrección -> A
      // B: numberCorrections[B] = 8 -> 8  <-- fallback aplica numberCorrections a todo
      // O: numberCorrections[O] = 0 -> 0
      expect(corrector.correct('ABO')).toBe('A80');
    });

    it('debe aplicar numberCorrections a Q -> 0', () => {
      expect(corrector.correct('ABQ')).toBe('A80');
    });

    it('debe aplicar numberCorrections a D -> 0', () => {
      expect(corrector.correct('ABD')).toBe('A80');
    });

    it('debe aplicar numberCorrections a I -> 1', () => {
      // I en numberCorrections = 1
      expect(corrector.correct('ABI')).toBe('A81');
    });

    it('debe aplicar numberCorrections a L -> 1', () => {
      expect(corrector.correct('ABL')).toBe('A81');
    });

    it('debe aplicar numberCorrections a Z -> 2', () => {
      expect(corrector.correct('ABZ')).toBe('A82');
    });

    it('debe aplicar numberCorrections a S -> 5', () => {
      expect(corrector.correct('ABS')).toBe('A85');
    });

    it('debe aplicar numberCorrections a B -> 8', () => {
      expect(corrector.correct('ABB')).toBe('A88');
    });

    it('debe aplicar numberCorrections a G -> 6', () => {
      expect(corrector.correct('ABG')).toBe('A86');
    });
  });

  describe('corrección CON zonas detectadas (solo strings: letras puras + números puros al final)', () => {
    it('formato AAAA00: 3 letras + 3 números - zona letras [0,2], números [3,5]', () => {
      // 'ABC123' -> numCount=3, leadCount=3
      // 'ABC012' -> 0 en índice 3 (zona números) -> NO se corrige
      expect(corrector.correct('ABC012')).toBe('ABC012');
    });

    it('formato AA0000: 2 letras + 4 números - números puros al final', () => {
      // 'AB1234' -> numCount=4, leadCount=2
      expect(corrector.correct('AB1234')).toBe('AB1234');
    });

    it('formato A00000: 1 letra + 5 números', () => {
      // 'A01234' -> numCount=5, leadCount=1
      expect(corrector.correct('A01234')).toBe('A01234');
    });

    it('la corrección de zona detecta "ABCO23" como letras[0-3]+números[4-5], O en zona letras', () => {
      // 'ABCO23' -> numCount=2, leadCount=4 -> zonas: letras[0,3], números[4,5]
      // O en índice 3 (zona letras) -> letterCorrections[O]? No -> se queda O
      // 2,3 en zona números -> sin corrección
      expect(corrector.correct('ABCO23')).toBe('ABCO23');
    });
  });

  describe('casos edge', () => {
    it('no debe modificar string ya correcto CON zonas', () => {
      expect(corrector.correct('ABCD12')).toBe('ABCD12');
      expect(corrector.correct('AB1234')).toBe('AB1234');
    });

    it('debe manejar string vacío', () => {
      expect(corrector.correct('')).toBe('');
    });

    it('debe normalizar removiendo espacios y guiones', () => {
      // 'AB-0 123' -> 'AB0123' -> numCount=4, leadCount=2 -> zonas detectadas
      // letterRange=[0,1], numberRange=[2,5], 0 en zona números -> no se corrige
      expect(corrector.correct('AB-0 123')).toBe('AB0123');
      // 'A B 1 2 3' -> 'AB123' -> numCount=3, leadCount=2 -> zonas
      expect(corrector.correct('A B 1 2 3')).toBe('AB123');
    });

    it('debe permitir correcciones personalizadas (fallback)', () => {
      const customCorrector = new Corrector({
        letter: { '4': 'A' },
        number: { 'A': '4' },
      });
      // '4BC' -> sin zonas -> fallback
      // 4 -> letterCorrections[4] = A
      // B -> numberCorrections[B] = 8 (fallback aplica numberCorrections a todo)
      // C -> sin corrección
      expect(customCorrector.correct('4BC')).toBe('A8C');
    });
  });
});