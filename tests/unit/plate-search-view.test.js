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
  MIN_QUERY_LENGTH,
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
const DIGITOS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

describe('plate-search-view.js', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  // ============================================================
  // sanitizeQuery (el dialer solo acepta dígitos)
  // ============================================================
  describe('sanitizeQuery', () => {
    it('deja solo los dígitos', () => {
      expect(sanitizeQuery('  123  ')).toBe('123');
    });

    it('saca letras, símbolos y comodines de SQL (%, _)', () => {
      // Con % o _ el `ilike` buscaría otra cosa distinto de lo tipeado.
      expect(sanitizeQuery('AB-12!@#%_')).toBe('12');
    });

    it('colapsa cualquier cosa que no sea número', () => {
      expect(sanitizeQuery('1 2-3')).toBe('123');
    });

    it('tolera null / undefined / números', () => {
      expect(sanitizeQuery(null)).toBe('');
      expect(sanitizeQuery(undefined)).toBe('');
      expect(sanitizeQuery(123)).toBe('123');
    });
  });

  // ============================================================
  // Dialer numérico
  // ============================================================
  describe('dialer numérico', () => {
    it('tiene los 10 dígitos repartidos en 4 filas de 3', () => {
      expect(KEYBOARD_ROWS).toHaveLength(4);
      for (const fila of KEYBOARD_ROWS) expect(fila).toHaveLength(3);

      const teclas = TODAS_LAS_TECLAS;
      for (const d of DIGITOS) expect(teclas).toContain(d);
      // Sin repetidos: 10 dígitos + 2 especiales.
      expect(new Set(teclas).size).toBe(teclas.length);
      expect(teclas).toHaveLength(12);
    });

    it('la última fila es Limpiar / 0 / Borrar', () => {
      expect(KEYBOARD_ROWS[3]).toEqual(['CLEAR', '0', 'BACKSPACE']);
    });

    it('no tiene letras (la búsqueda es solo numérica)', () => {
      for (const c of 'BCDFGHJKLMNPQRSTVWXYZ'.split('')) {
        expect(TODAS_LAS_TECLAS).not.toContain(c);
      }
      for (const v of ['A', 'E', 'I', 'O', 'U', 'SPACE']) {
        expect(TODAS_LAS_TECLAS).not.toContain(v);
      }
    });

    it('dibuja una tecla por cada tecla del dialer', () => {
      const dom = mountDom();
      const view = new PlateSearchView({ searchFn: vi.fn() });
      view.init(dom);

      const keys = dom.querySelectorAll('#manual-keyboard .vk-key');
      expect(keys.length).toBe(TODAS_LAS_TECLAS.length);
      expect(dom.querySelectorAll('#manual-keyboard .vk-row').length).toBe(KEYBOARD_ROWS.length);
      // El contenedor queda marcado para el estilo de dialer
      expect(dom.querySelector('#manual-keyboard').classList.contains('vk-dialer')).toBe(true);
    });

    it('las teclas especiales tienen etiqueta visible', () => {
      expect(KEY_LABELS.BACKSPACE).toBeTruthy();
      expect(KEY_LABELS.CLEAR).toBeTruthy();
    });

    it('el input queda readonly y sin teclado nativo', () => {
      const dom = mountDom();
      const view = new PlateSearchView({ searchFn: vi.fn() });
      expect(view.init(dom)).toBe(true);

      const input = dom.querySelector('#manual-plate-input');
      expect(input.readOnly).toBe(true);
      expect(input.getAttribute('inputmode')).toBe('none');
    });

    it('escribe, borra y limpia con el dialer', () => {
      const dom = mountDom();
      const view = new PlateSearchView({ searchFn: vi.fn() });
      view.init(dom);

      view.press('1');
      view.press('2');
      expect(view.query).toBe('12');
      expect(dom.querySelector('#manual-plate-input').value).toBe('12');

      view.press('BACKSPACE');
      expect(view.query).toBe('1');

      view.press('CLEAR');
      expect(view.query).toBe('');
    });

    it('ignora las letras (el dialer es solo numérico)', () => {
      const dom = mountDom();
      const view = new PlateSearchView({ searchFn: vi.fn() });
      view.init(dom);

      view.press('A');
      view.press('b');
      view.press('SPACE');
      view.press(' ');
      expect(view.query).toBe('');
    });

    it('no deja escribir más de MAX_LENGTH caracteres', () => {
      const dom = mountDom();
      const view = new PlateSearchView({ searchFn: vi.fn() });
      view.init(dom);

      for (let i = 0; i < MAX_LENGTH + 5; i++) view.press('7');
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

      view.press('1');
      view.press('2');
      expect(searchFn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(searchFn).toHaveBeenCalledTimes(1);
      expect(searchFn).toHaveBeenCalledWith({
        search: '12',
        limit: expect.any(Number),
      });
    });

    it('reinicia el debounce si se sigue tipeando', async () => {
      const searchFn = vi.fn().mockResolvedValue([]);
      const view = new PlateSearchView({ searchFn });
      view.init(mountDom());

      view.press('1');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);
      view.press('2');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);

      // Todavía no venció el debounce del último tecleo.
      expect(searchFn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(50);
      expect(searchFn).toHaveBeenCalledTimes(1);
      expect(searchFn).toHaveBeenCalledWith(expect.objectContaining({ search: '12' }));
    });

    it('no consulta si la consulta queda vacía', async () => {
      const searchFn = vi.fn().mockResolvedValue([]);
      const view = new PlateSearchView({ searchFn });
      view.init(mountDom());

      view.press('1');
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

      view.press('1');
      view.press('2');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      view.press('3');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      // La primera respuesta llega tarde: no debe pisar los resultados nuevos.
      resolveViejo([{ plate: 'ZZ999', type: 'unknown' }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(view.results.map(r => r.plate)).toEqual(['AB123']);
    });

    // ============================================================
    // Mínimo de dígitos para buscar (2° carácter)
    // ============================================================
    it('no consulta con un solo número', async () => {
      const searchFn = vi.fn().mockResolvedValue([]);
      const view = new PlateSearchView({ searchFn });
      view.init(mountDom());

      view.press('1');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(searchFn).not.toHaveBeenCalled();
      expect(view.state).toBe('short');
      expect(view.results).toEqual([]);
    });

    it('consulta recién cuando hay 2 números', async () => {
      const searchFn = vi.fn().mockResolvedValue([]);
      const view = new PlateSearchView({ searchFn });
      view.init(mountDom());

      view.press('1');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(searchFn).not.toHaveBeenCalled();

      view.press('2');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(searchFn).toHaveBeenCalledTimes(1);
      expect(searchFn).toHaveBeenCalledWith(expect.objectContaining({ search: '12' }));
    });

    it('el mínimo son 2 caracteres', () => {
      expect(MIN_QUERY_LENGTH).toBe(2);
    });

    it('avisa que hay que ingresar más números', async () => {
      const dom = mountDom();
      const status = dom.querySelector('#manual-status');
      const view = new PlateSearchView({ searchFn: vi.fn() });
      view.init(dom);

      view.press('1');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(status.textContent).toContain('2 números');
    });

    it('borrar hasta dejar 1 número vuelve a cortar la búsqueda', async () => {
      const searchFn = vi.fn().mockResolvedValue([]);
      const view = new PlateSearchView({ searchFn });
      view.init(mountDom());

      view.press('1');
      view.press('2');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(searchFn).toHaveBeenCalledTimes(1);

      view.press('BACKSPACE');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(searchFn).toHaveBeenCalledTimes(1);
      expect(view.state).toBe('short');
    });

    it('refresh() no consulta si la consulta es muy corta', async () => {
      const searchFn = vi.fn().mockResolvedValue([]);
      const view = new PlateSearchView({ searchFn });
      view.init(mountDom());

      view.press('1');
      await view.refresh();

      expect(searchFn).not.toHaveBeenCalled();
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

      view.press('1');
      view.press('2');
      // flush() arranca la búsqueda sin esperar el debounce.
      const pending = view.flush();
      expect(view.state).toBe('loading');
      expect(status.textContent).toContain('Buscando');

      await pending;
      expect(view.state).toBe('results');
      expect(status.textContent).toContain('1 resultado');
      expect(dom.querySelectorAll('.manual-result').length).toBe(1);

      view.press('3');
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

      view.press('1');
      view.press('2');
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

      view.press('1');
      view.press('2');
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

      view.press('1');
      view.press('2');
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

      view.press('1');
      view.press('2');
      await view.flush();

      expect(dom.querySelectorAll('.manual-result img').length).toBe(0);
      expect(dom.querySelector('.mr-owner').textContent).toContain('<img');
    });
  });
});
