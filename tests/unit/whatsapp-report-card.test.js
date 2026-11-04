import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// ============================================================
// Envío de registros por WhatsApp desde la vista Llamadas
// ------------------------------------------------------------
// La card con el número de destino SOLO la ve el admin: el resto
// de los usuarios (flotantes) no ven ni el input ni el botón.
//
// Se verifican los archivos fuente: si alguien saca el `hidden` o
// deja de filtrar por rol, este test falla.
// ============================================================

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const indexHtml = read('../../index.html');
const appJs = read('../../app-supabase.js');
const swJs = read('../../sw.js');

describe('Llamadas: enviar registros por WhatsApp (solo admin)', () => {
  it('la card existe y nace oculta', () => {
    expect(indexHtml).toMatch(/id="card-whatsapp-report" class="card hidden"|class="card hidden" id="card-whatsapp-report"/);
    expect(indexHtml).toMatch(/id="whatsapp-report-phone"/);
    expect(indexHtml).toMatch(/id="btn-whatsapp-report"/);
  });

  it('la card vive en la vista de llamadas', () => {
    const viewCall = indexHtml.slice(indexHtml.indexOf('id="view-call"'), indexHtml.indexOf('id="view-profile"'));
    expect(viewCall).toContain('card-whatsapp-report');
    expect(viewCall).toContain('whatsapp-report-phone');
    expect(viewCall).toContain('btn-whatsapp-report');
  });

  it('el acceso a la card depende del rol (solo admin)', () => {
    expect(appJs).toMatch(
      /document\.getElementById\('card-whatsapp-report'\)\?\.classList\.toggle\('hidden', !isAdmin\)/
    );
  });

  it('el botón manda el reporte al número escrito', () => {
    expect(appJs).toMatch(/getElementById\('btn-whatsapp-report'\)\.onclick = sendWhatsAppReportToNumber;/);
    expect(appJs).toMatch(/function sendWhatsAppReportToNumber\(\)/);
    expect(appJs).toMatch(/buildWhatsappUrl\(phone, msg\)/);
  });

  it('el botón de la vista Registro sigue usando el contacto de oficina', () => {
    expect(appJs).toMatch(/getElementById\('btn-send-whatsapp'\)\.onclick = sendWhatsAppReport;/);
    expect(appJs).toMatch(/c\.type === 'office'/);
  });

  it('el módulo de WhatsApp queda en el precache del Service Worker', () => {
    expect(swJs).toMatch(/'whatsapp\.js'/);
  });
});
