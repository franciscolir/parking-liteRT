import { describe, it, expect } from 'vitest';
import {
  DEFAULT_COUNTRY_CODE,
  normalizeWhatsAppNumber,
  buildIncidentReportMessage,
  buildWhatsappUrl,
} from '../../whatsapp.js';

describe('whatsapp.js', () => {
  describe('normalizeWhatsAppNumber', () => {
    it('deja el número en formato internacional (solo dígitos)', () => {
      expect(normalizeWhatsAppNumber('+56 9 8765 4321')).toBe('56987654321');
      expect(normalizeWhatsAppNumber('+56987654321')).toBe('56987654321');
      // 9 dígitos sin código de país: es un móvil local → se le pone el 56.
      expect(normalizeWhatsAppNumber('(9) 8765-4321')).toBe('56987654321');
    });

    it('quita el prefijo internacional 00', () => {
      expect(normalizeWhatsAppNumber('0056 9 8765 4321')).toBe('56987654321');
    });

    it('le pone el código de país a un móvil local de 9 dígitos', () => {
      expect(normalizeWhatsAppNumber('9 8765 4321')).toBe(DEFAULT_COUNTRY_CODE + '987654321');
    });

    it('no inventa el código de país en números cortos', () => {
      expect(normalizeWhatsAppNumber('133')).toBe('133');
      expect(normalizeWhatsAppNumber('123')).toBe('123');
    });

    it('devuelve vacío si no hay número usable', () => {
      expect(normalizeWhatsAppNumber('')).toBe('');
      expect(normalizeWhatsAppNumber('   ')).toBe('');
      expect(normalizeWhatsAppNumber(null)).toBe('');
      expect(normalizeWhatsAppNumber('abc')).toBe('');
    });
  });

  describe('buildIncidentReportMessage', () => {
    const datos = {
      plate: 'abcd12',
      vehicle: 'Auto',
      incident: 'Robo/Hurto',
      location: 'Av. Siempre Viva 742',
      description: 'Auto gris',
    };

    it('arma el reporte con patente, vehículo e incidente', () => {
      const msg = buildIncidentReportMessage(datos);
      expect(msg).toContain('REPORTE DE INCIDENTE');
      expect(msg).toContain('ABCD12');
      expect(msg).toContain('Auto');
      expect(msg).toContain('Robo/Hurto');
      expect(msg).toContain('Av. Siempre Viva 742');
      expect(msg).toContain('Auto gris');
    });

    it('omite la ubicación y la descripción si están vacías', () => {
      const msg = buildIncidentReportMessage({ ...datos, location: '', description: '' });
      expect(msg).not.toContain('Ubicación');
      expect(msg).not.toContain('Descripción');
    });

    it('devuelve null si faltan patente, vehículo o incidente', () => {
      expect(buildIncidentReportMessage({ ...datos, plate: '' })).toBeNull();
      expect(buildIncidentReportMessage({ ...datos, vehicle: '' })).toBeNull();
      expect(buildIncidentReportMessage({ ...datos, incident: '' })).toBeNull();
      expect(buildIncidentReportMessage({})).toBeNull();
      expect(buildIncidentReportMessage()).toBeNull();
    });
  });

  describe('buildWhatsappUrl', () => {
    it('arma el link de wa.me con el número y el mensaje', () => {
      const url = buildWhatsappUrl('+56 9 8765 4321', 'hola');
      expect(url.startsWith('https://wa.me/56987654321?text=')).toBe(true);
      expect(decodeURIComponent(url.split('?text=')[1])).toBe('hola');
    });

    it('permite abrir WhatsApp sin destino (elige el contacto)', () => {
      expect(buildWhatsappUrl('', 'hola')).toBe('https://wa.me/?text=hola');
    });
  });
});
