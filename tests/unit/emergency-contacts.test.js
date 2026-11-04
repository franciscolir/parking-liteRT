import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EMERGENCY_CONTACTS,
  normalizeEmergencyContacts,
  mergeContactLists,
} from '../../emergency-contacts.js';

// ============================================================
// Contactos de emergencia por defecto (vista Llamadas)
// ============================================================

describe('Contactos de emergencia por defecto', () => {
  it('trae los 5 contactos en el orden pedido', () => {
    expect(DEFAULT_EMERGENCY_CONTACTS.map(c => c.name)).toEqual([
      'Carabineros',
      'Bomberos',
      'Ambulancia',
      'Superintendente dpto.',
      'Auxiliar',
    ]);
  });

  it('viene con los teléfonos precargados (133/132/131 y 2 vacíos)', () => {
    const phone = Object.fromEntries(DEFAULT_EMERGENCY_CONTACTS.map(c => [c.name, c.phone]));
    expect(phone['Carabineros']).toBe('133');
    expect(phone['Bomberos']).toBe('132');
    expect(phone['Ambulancia']).toBe('131');
    expect(phone['Superintendente dpto.']).toBe('');
    expect(phone['Auxiliar']).toBe('');
  });

  it('normalize acepta el JSON guardado en app_settings', () => {
    const fromDb = normalizeEmergencyContacts([
      { name: ' Carabineros ', phone: 133, type: 'police', icon: '🚨' },
      { name: 'Auxiliar', phone: null },
    ]);
    expect(fromDb).toEqual([
      { name: 'Carabineros', phone: '133', type: 'police', icon: '🚨' },
      { name: 'Auxiliar', phone: '', type: 'custom', icon: '📞' },
    ]);
  });

  it('normalize devuelve null si la clave no existe o el valor no sirve', () => {
    expect(normalizeEmergencyContacts(undefined)).toBeNull();
    expect(normalizeEmergencyContacts(null)).toBeNull();
    expect(normalizeEmergencyContacts([])).toBeNull();
    expect(normalizeEmergencyContacts('no soy array')).toBeNull();
    expect(normalizeEmergencyContacts([{ phone: '133' }])).toBeNull(); // sin name
  });

  it('merge pone los 5 por defecto primero y agrega los contactos propios', () => {
    const merged = mergeContactLists(DEFAULT_EMERGENCY_CONTACTS, [
      // Defaults antiguos del trigger: NO deben duplicar la lista
      { name: 'Policía', phone: '911', is_default: true },
      { name: 'Bomberos', phone: '100', is_default: true },
      // Contacto agregado por el usuario: sí se muestra
      { name: 'Comisaría', phone: '+56912345678', is_default: false },
    ]);

    expect(merged.map(c => c.name)).toEqual([
      'Carabineros',
      'Bomberos',
      'Ambulancia',
      'Superintendente dpto.',
      'Auxiliar',
      'Comisaría',
    ]);
  });

  it('si app_settings no tiene la clave, cae en los 5 por defecto', () => {
    expect(mergeContactLists(null, [])).toHaveLength(5);
    expect(mergeContactLists(undefined, []).map(c => c.name))
      .toEqual(DEFAULT_EMERGENCY_CONTACTS.map(c => c.name));
  });
});
