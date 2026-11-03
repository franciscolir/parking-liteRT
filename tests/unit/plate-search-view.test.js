import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// El módulo real de Supabase exige `globalThis.supabase` al importarse:
// acá se reemplaza por un mock (el buscador usa `searchFn` inyectable).
vi.mock('../../supabase-client.js', () => ({
  searchPlates: vi.fn(),
}));

import {
  PlateSearchView,
  sanitizeQuery,
  KEYBOARD_ROWS,
  KEY_LABELS,
  DEBOUNCE_MS,
  MAX_LENGTH,
} from '../../plate-search-view.js';

/** Monta el DOM mínimo que usa la vista de búsqueda manual. */
function mountDom() {
  document.body.innerHTML = `
    <input id="manual-plate-input" type="text" />
    <div id="manual-status"></div>
    <div id="manual-results"></div>
    <div id="manual-keyboard"></div>
  `;
  return document;
}

const TODAS_LAS_TECLAS = KEYBOARD_ROWS.flat();

describe('plate-search-view.js', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  // ============================================================
  // sanitizeQuery
  // ============================================================
  describe('sanitizeQuery', () => {
    it('pasa a mayúsculas y recorta los espacios', () => {
      expect(sanitizeQuery('  ab123  ')).toBe('AB123');
    });

    it('quita los caracteres que no sirven para una patente', () => {
      expect(sanitizeQuery('AB-12!@#')).toBe('AB12');
    });

    it('quita los comodines de SQL (%, _)', () => {
      // Con % o _ el `ilike` buscaría otra cosa distinto de lo tipeado.
      expect(sanitizeQuery('A%B_C')).toBe('ABC');
    });

    it('colapsa espacios seguidos', () => {
      expect(sanitizeQuery('AB   12')).toBe('AB 12');
    });

    it('tolera null / undefined / números', () => {
      expect(sanitizeQuery(null)).toBe('');
      expect(sanitizeQuery(undefined)).toBe('');
      expect(sanitizeQuery(123)).toBe('123');
    });
  });

  // ============================================================
  // Teclado virtual
  // ============================================================
  describe('teclado virtual', () => {
    it('tiene letras, números, borrar y espacio', () => {
      expect(TODAS_LAS_TECLAS).toContain('A');
      expect(TODAS_LAS_TECLAS).toContain('Z');
      expect(TODAS_LAS_TECLAS).toContain('0');
      expect(TODAS_LAS_TECLAS).toContain('9');
      expect(TODAS_LAS_TECLAS).toContain('BACKSPACE');
      expect(TODAS_LAS_TECLAS).toContain('SPACE');
    });

    it('las teclas especiales tienen etiqueta visible', () => {
      expect(KEY_LABELS.BACKSPACE).toBeTruthy();
      expect(KEY_LABELS.SPACE).toBeTruthy();
      expect(KEY_LABELS.CLEAR).toBeTruthy();
    });

    it('dibuja una tecla por cada tecla del teclado', () => {
      const dom = mountDom();
      const view = new PlateSearchView({ searchFn: vi.fn() });
      view.init(dom);

      const keys = dom.querySelectorAll('#manual-keyboard .vk-key');
      expect(keys.length).toBe(TODAS_LAS_TECLAS.length);
      expect(dom.querySelectorAll('#manual-keyboard .vk-row').length).toBe(KEYBOARD_ROWS.length);
    });

    it('el input queda readonly y sin teclado nativo', () => {
      const dom = mountDom();
      const view = new PlateSearchView({ searchFn: vi.fn() });
      expect(view.init(dom)).toBe(true);

      const input = dom.querySelector('#manual-plate-input');
      expect(input.readOnly).toBe(true);
      expect(input.getAttribute('inputmode')).toBe('none');
    });

    it('escribe, borra y limpia con el teclado virtual', () => {
      const dom = mountDom();
      const view = new PlateSearchView({ searchFn: vi.fn() });
      view.init(dom);

      view.press('a');
      view.press('b');
      expect(view.query).toBe('AB');
      expect(dom.querySelector('#manual-plate-input').value).toBe('AB');

      view.press('BACKSPACE');
      expect(view.query).toBe('A');

      view.press('CLEAR');
      expect(view.query).toBe('');
    });

    it('no deja escribir más de MAX_LENGTH caracteres', () => {
      const dom = mountDom();
      const view = new PlateSearchView({ searchFn: vi.fn() });
      view.init(dom);

      for (let i = 0; i < MAX_LENGTH + 5; i++) view.press('1');
      expect(view.query.length).toBe(MAX_LENGTH);
    });
  });

  // ============================================================
  // Búsqueda con debounce
  // ============================================================
  describe('búsqueda', () => {
    it('espera el debounce antes de consultar a Supabase', async () => {
      const searchFn = vi.fn().mockResolvedValue([]);
      const view = new PlateSearchView({ searchFn });
      view.init(mountDom());

      view.press('A');
      view.press('B');
      expect(searchFn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(searchFn).toHaveBeenCalledTimes(1);
      expect(searchFn).toHaveBeenCalledWith({
        search: 'AB',
        limit: expect.any(Number),
      });
    });

    it('reinicia el debounce si se sigue tipeando', async () => {
      const searchFn = vi.fn().mockResolvedValue([]);
      const view = new PlateSearchView({ searchFn });
      view.init(mountDom());

      view.press('A');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);
      view.press('B');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);

      // Todavía no venció el debounce del último tecleo.
      expect(searchFn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(50);
      expect(searchFn).toHaveBeenCalledTimes(1);
      expect(searchFn).toHaveBeenCalledWith(expect.objectContaining({ search: 'AB' }));
    });

    it('no consulta si la consulta queda vacía', async () => {
      const searchFn = vi.fn().mockResolvedValue([]);
      const view = new PlateSearchView({ searchFn });
      view.init(mountDom());

      view.press('A');
      view.press('BACKSPACE');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(searchFn).not.toHaveBeenCalled();
      expect(view.state).toBe('idle');
    });

    it('descarta las respuestas de consultas viejas', async () => {
      let resolveViejo;
      const searchFn = vi.fn()
        .mockImplementationOnce(() => new Promise(res => { resolveViejo = res; }))
        .mockResolvedValueOnce([{ plate: 'AB123', type: 'administration' }]);

      const view = new PlateSearchView({ searchFn });
      view.init(mountDom());

      view.press('A');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      view.press('B');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      // La primera respuesta llega tarde: no debe pisar los resultados nuevos.
      resolveViejo([{ plate: 'ZZ999', type: 'unknown' }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(view.results.map(r => r.plate)).toEqual(['AB123']);
    });
  });

  // ============================================================
  // Estados visibles
  // ============================================================
  describe('estados', () => {
    it('muestra cargando, resultados y sin resultados', async () => {
      const dom = mountDom();
      const status = dom.querySelector('#manual-status');
      const searchFn = vi.fn()
        .mockResolvedValueOnce([{ plate: 'AB123', type: 'administration' }])
        .mockResolvedValueOnce([]);

      const view = new PlateSearchView({ searchFn });
      view.init(dom);

      view.press('A');
      // flush() arranca la búsqueda sin esperar el debounce.
      const pending = view.flush();
      expect(view.state).toBe('loading');
      expect(status.textContent).toContain('Buscando');

      await pending;
      expect(view.state).toBe('results');
      expect(status.textContent).toContain('1 resultado');
      expect(dom.querySelectorAll('.manual-result').length).toBe(1);

      view.press('B');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(view.state).toBe('empty');
      expect(status.textContent).toContain('Sin resultados');
    });

    it('muestra el error si la consulta falla', async () => {
      const dom = mountDom();
      const status = dom.querySelector('#manual-status');
      const searchFn = vi.fn().mockRejectedValue(new Error('sin red'));

      const view = new PlateSearchView({ searchFn });
      view.init(dom);

      view.press('A');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(view.state).toBe('error');
      expect(status.classList.contains('error')).toBe(true);
      expect(status.textContent).toContain('sin red');
    });

    it('refresca sin cambiar el estado visible (Realtime / polling)', async () => {
      const dom = mountDom();
      const status = dom.querySelector('#manual-status');
      const searchFn = vi.fn().mockResolvedValue([{ plate: 'AB123', type: 'administration' }]);

      const view = new PlateSearchView({ searchFn });
      view.init(dom);

      view.press('A');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(view.state).toBe('results');

      await view.refresh();
      expect(view.state).toBe('results');
      expect(status.textContent).toContain('resultado');
    });
  });

  // ============================================================
  // Selección de un resultado
  // ============================================================
  describe('selección', () => {
    it('entrega la patente elegida al callback (historial compartido)', async () => {
      const dom = mountDom();
      const onSelect = vi.fn();
      const searchFn = vi.fn().mockResolvedValue([
        { plate: 'AB123', type: 'first_aid', owner_name: 'Ambulancia' },
      ]);

      const view = new PlateSearchView({ searchFn, onSelect });
      view.init(dom);

      view.press('A');
      await view.flush();

      dom.querySelector('.manual-result').click();

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ plate: 'AB123' }));
    });

    it('escapa el texto que viene de la base', async () => {
      const dom = mountDom();
      const searchFn = vi.fn().mockResolvedValue([
        { plate: 'AB123', type: 'administration', owner_name: '<img src=x onerror=alert(1)>' },
      ]);

      const view = new PlateSearchView({ searchFn });
      view.init(dom);

      view.press('A');
      await view.flush();

      expect(dom.querySelectorAll('.manual-result img').length).toBe(0);
      expect(dom.querySelector('.mr-owner').textContent).toContain('<img');
    });
  });
});
