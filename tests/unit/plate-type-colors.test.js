import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// ============================================================
// Colores por tipo de patente (tripwire estático)
// ------------------------------------------------------------
// Cada tipo de patente tiene UN color en toda la app:
//   - Primeros auxilios (PA)        → ROJO
//   - Administración (AD)           → AZUL
//   - Necesidades especiales (NE)  → VERDE
//
// El frame de la cámara que confirma que una patente está
// REGISTRADA parpadea en verde UNA vez y después queda con el
// color de su tipo.
//
// Se verifican los archivos fuente (CSS y JS): si alguien cambia
// una clase o un color sin actualizar el mapa de plate-types.js,
// estos tests fallan.
// ============================================================

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const styleCss = read('../../style.css');
const appJs = read('../../app-supabase.js');
const adminJs = read('../../admin.js');
const plateTypesJs = read('../../plate-types.js');

// Colores esperados (los mismos de plate-types.js)
const NE = 'rgba\\(34,197,94';   // verde  #22c55e
const AD = 'rgba\\(59,130,246';  // azul   #3b82f6
const PA = 'rgba\\(239,68,68';   // rojo   #ef4444

describe('CSS: color por tipo en cada lugar', () => {
  it('la píldora de tipo de la lista de patentes', () => {
    expect(styleCss).toMatch(new RegExp(`\\.plate-row-badge\\.ne\\s*\\{[^}]*${NE}`));
    expect(styleCss).toMatch(new RegExp(`\\.plate-row-badge\\.ad\\s*\\{[^}]*${AD}`));
    expect(styleCss).toMatch(new RegExp(`\\.plate-row-badge\\.pa\\s*\\{[^}]*${PA}`));
  });

  it('la etiqueta de tipo del historial de escaneos', () => {
    expect(styleCss).toMatch(new RegExp(`\\.history-item \\.h-status\\.ne\\s*\\{[^}]*${NE}`));
    expect(styleCss).toMatch(new RegExp(`\\.history-item \\.h-status\\.ad\\s*\\{[^}]*${AD}`));
    expect(styleCss).toMatch(new RegExp(`\\.history-item \\.h-status\\.pa\\s*\\{[^}]*${PA}`));
  });

  it('las mini tarjetas de métricas (NE / AD / PA)', () => {
    expect(styleCss).toMatch(/\.mini-card\.mini-ne \.mini-card-value \{ color: var\(--success\); \}/);
    expect(styleCss).toMatch(/\.mini-card\.mini-ad \.mini-card-value \{ color: var\(--primary\); \}/);
    expect(styleCss).toMatch(/\.mini-card\.mini-pa \.mini-card-value \{ color: var\(--danger\); \}/);
  });

  it('la tarjeta de resultado de la cámara', () => {
    expect(styleCss).toMatch(/\.camera-result\.ne \.result-card-inner \{/);
    expect(styleCss).toMatch(/\.camera-result\.ad \.result-card-inner \{/);
    expect(styleCss).toMatch(/\.camera-result\.pa \.result-card-inner \{/);
    expect(styleCss).toMatch(/\.camera-result\.ne \.plate-number \{ color: var\(--success\); \}/);
    expect(styleCss).toMatch(/\.camera-result\.ad \.plate-number \{ color: var\(--primary\); \}/);
    expect(styleCss).toMatch(/\.camera-result\.pa \.plate-number \{ color: var\(--danger\); \}/);
  });

  it('el destello verde de confirmación existe y es verde', () => {
    expect(styleCss).toMatch(/@keyframes confirmFlashGreen/);
    expect(styleCss).toMatch(/\.camera-result \.result-card-inner\.flash-confirm \{/);
    expect(styleCss).toMatch(/confirmFlashGreen[\s\S]{0,200}#00ff66/);
  });

  it('conserva las clases legacy (.reg / .stolen / .unk)', () => {
    expect(styleCss).toMatch(/\.plate-row-badge\.reg \{/);
    expect(styleCss).toMatch(/\.plate-row-badge\.stolen \{/);
    expect(styleCss).toMatch(/\.history-item \.h-status\.reg \{/);
  });
});

describe('JS: el frame de la cámara usa el color del tipo', () => {
  it('dibuja el frame con getFrameColor (verde al confirmar, color del tipo después)', () => {
    expect(appJs).toMatch(/getFrameColor\(lastPlateType, confirmando\)/);
    expect(appJs).toMatch(/ctx\.strokeStyle = frameColor;/);
  });

  it('el verde de confirmación dura una sola vez por patente/tipo', () => {
    expect(appJs).toMatch(/plateConfirmUntil = Date\.now\(\) \+ CONFIRM_FLASH_MS;/);
    expect(appJs).toMatch(/if \(lastConfirmed !== key\)/);
  });

  it('el resultado de la cámara usa la clase del tipo (pa / ad / ne)', () => {
    expect(appJs).toMatch(/css: getTypeClass\('first_aid'\)/);
    expect(appJs).toMatch(/css: getTypeClass\('administration'\)/);
    expect(appJs).toMatch(/css: getTypeClass\('special_needs'\)/);
  });

  it('limpia el estado del frame al perder la patente', () => {
    expect(appJs).toMatch(/function resetPlateTracking\(\)/);
    expect(appJs).toMatch(/lastPlateType = null;\s*plateConfirmUntil = 0;\s*lastConfirmed = null;/);
  });
});

describe('JS: los badges de todas las vistas salen del mapa único', () => {
  it('plate-types.js define las clases ne / ad / pa y sus colores', () => {
    expect(plateTypesJs).toMatch(/value: 'special_needs'.*cls: 'ne'.*color: '#22c55e'/);
    expect(plateTypesJs).toMatch(/value: 'administration'.*cls: 'ad'.*color: '#3b82f6'/);
    expect(plateTypesJs).toMatch(/value: 'first_aid'.*cls: 'pa'.*color: '#ef4444'/);
  });

  it('la lista de patentes y el historial usan t.cls / st.cls', () => {
    expect(appJs).toMatch(/plate-row-badge \$\{t\.cls\}/);
    expect(appJs).toMatch(/h-status \$\{st\.cls\}/);
    expect(adminJs).toMatch(/plate-row-badge \$\{st\.cls\}/);
    expect(adminJs).toMatch(/plate-row-badge \$\{t\.cls\}/);
  });

  it('las mini tarjetas del admin usan la clase del tipo', () => {
    expect(adminJs).toMatch(/mini-card mini-\$\{t\.cls\}/);
  });
});
