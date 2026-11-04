// ============================================================
// plate-search-view.js - Buscador de patentes con teclado virtual
// ------------------------------------------------------------
// Modo "Manual" de la vista unificada (Cámara / Manual).
//
// - El input es `readonly` + `inputmode="none"`: en el celular NUNCA se
//   abre el teclado nativo. Toda la escritura se hace con el teclado
//   virtual que se arma en esta misma vista.
// - La búsqueda va contra Supabase con `ilike` (coincidencia parcial),
//   con debounce de 300 ms para no saturar la base.
// - No depende del modo cámara: el resultado se entrega por callback
//   (`onSelect`) para que la app lo procese con el mismo camino que una
//   detección por cámara (resultado + historial compartido).
//
// Módulo ES nativo, sin bundler ni dependencias extra.
// ============================================================

import { searchPlates } from './supabase-client.js';
import { TYPE_LABELS } from './plate-types.js';

// ------------------------------------------------------------
// Teclado virtual
// ------------------------------------------------------------
// 'BACKSPACE' = borrar, 'CLEAR' = limpiar todo.
//
// SIN VOCALES: el formato de patente vigente (BB·BB·10) usa solo
// consonantes y números, así que A, E, I, O y U no están en el teclado
// (evita tipear letras que después no van a existir).
// Las 21 consonantes del español van repartidas en 3 filas de 7.
// No hay tecla de espacio: las patentes no llevan espacios y el lugar de
// la barra de espacio lo ocupa la tecla de borrar.
export const KEYBOARD_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['Q', 'W', 'R', 'T', 'Y', 'P', 'L'],
  ['S', 'D', 'F', 'G', 'H', 'J', 'K'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
  ['CLEAR', 'BACKSPACE'],
];

/** Texto visible de las teclas especiales. */
export const KEY_LABELS = {
  BACKSPACE: '⌫',
  CLEAR: 'Limpiar',
};

/** Espera antes de consultar a Supabase (ms). */
export const DEBOUNCE_MS = 200;

/** Máximo de resultados que se muestran. */
export const MAX_RESULTS = 30;

/** Largo máximo de la patente. */
export const MAX_LENGTH = 10;

/**
 * Limpia lo que el usuario escribe: solo letras, números y espacios.
 * Además de evitar caracteres raros, saca los comodines de SQL ('%', '_')
 * que en `ilike` transformarían la búsqueda en otra cosa.
 */
export function sanitizeQuery(text) {
  return String(text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escapa texto para insertarlo en HTML. */
const HTML_ESCAPES = {
  '&': '&' + 'amp;',
  '<': '&' + 'lt;',
  '>': '&' + 'gt;',
  '"': '&' + 'quot;',
  "'": '&' + '#39;',
};

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Vista de búsqueda manual de patentes.
 *
 * Estados posibles (`state`): 'idle' | 'loading' | 'results' | 'empty' | 'error'
 */
export class PlateSearchView {
  constructor({
    onSelect,
    searchFn = searchPlates,
    debounceMs = DEBOUNCE_MS,
    maxResults = MAX_RESULTS,
  } = {}) {
    this.onSelect = typeof onSelect === 'function' ? onSelect : () => {};
    this.searchFn = searchFn;
    this.debounceMs = debounceMs;
    this.maxResults = maxResults;

    this.query = '';
    this.results = [];
    this.state = 'idle';
    this.error = null;

    this._timer = null;
    this._token = 0;      // invalida respuestas de búsquedas viejas

    this.input = null;
    this.resultsEl = null;
    this.statusEl = null;
    this.keyboardEl = null;
  }

  /**
   * Conecta el componente con el DOM.
   * @param {ParentNode} root
   * @returns {boolean} false si no encuentra el input
   */
  init(root = document) {
    this.input = root.querySelector('#manual-plate-input');
    this.resultsEl = root.querySelector('#manual-results');
    this.statusEl = root.querySelector('#manual-status');
    this.keyboardEl = root.querySelector('#manual-keyboard');
    if (!this.input) return false;

    // El input es readonly para que el celular no abra su teclado.
    this.input.readOnly = true;
    this.input.setAttribute('inputmode', 'none');

    // Algunos navegadores móviles abren el teclado al tocar un readonly:
    // se saca el foco en el acto.
    this.input.addEventListener('focus', (e) => e.target.blur());
    this.input.addEventListener('click', (e) => e.preventDefault());

    // Teclado físico (opcional, no molesta en el celular): permite escribir
    // desde una PC aunque el input sea readonly.
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') { this.press('BACKSPACE'); e.preventDefault(); }
      else if (e.key === 'Enter') { this.flush(); e.preventDefault(); }
      else if (e.key.length === 1) { this.press(e.key); e.preventDefault(); }
    });

    this._renderKeyboard();
    this._setState('idle');
    return true;
  }

  /** Dibuja el teclado virtual. */
  _renderKeyboard() {
    if (!this.keyboardEl) return;
    this.keyboardEl.innerHTML = '';

    for (const row of KEYBOARD_ROWS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'vk-row';

      for (const key of row) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vk-key';
        // La tecla de borrar ocupa el lugar de la barra de espacio: es la
        // tecla ancha de la última fila.
        if (key === 'BACKSPACE') btn.classList.add('vk-wide');
        if (key === 'CLEAR') btn.classList.add('vk-clear');
        btn.textContent = KEY_LABELS[key] || key;
        btn.dataset.key = key;
        btn.addEventListener('click', () => this.press(key));
        rowEl.appendChild(btn);
      }

      this.keyboardEl.appendChild(rowEl);
    }
  }

  /** Presiona una tecla del teclado virtual. */
  press(key) {
    if (key === 'BACKSPACE') this.query = this.query.slice(0, -1);
    else if (key === 'CLEAR') this.query = '';
    else if (key === 'SPACE' || key === ' ') return;  // las patentes no llevan espacios
    else this.query += String(key).toUpperCase();

    if (this.query.length > MAX_LENGTH) this.query = this.query.slice(0, MAX_LENGTH);

    this._syncInput();
    this._schedule();
  }

  /** Copia la consulta al input (readonly, solo para mostrar). */
  _syncInput() {
    if (this.input) this.input.value = this.query;
  }

  /** Agenda la búsqueda con debounce. */
  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._runSearch(); }, this.debounceMs);
  }

  /** Ejecuta la búsqueda ahora (sin esperar el debounce). */
  flush() {
    clearTimeout(this._timer);
    return this._runSearch();
  }

  /**
   * Consulta a Supabase.
   * @param {{silent?: boolean}} opts silent = no cambia el estado visible
   *   (se usa para refrescar por Realtime sin interrumpir al usuario)
   */
  async _runSearch({ silent = false } = {}) {
    const q = sanitizeQuery(this.query);
    const token = ++this._token;

    if (!q) {
      this.results = [];
      this.error = null;
      this._setState('idle');
      this._render();
      return this.results;
    }

    if (!silent) this._setState('loading');

    try {
      const rows = await this.searchFn({ search: q, limit: this.maxResults });
      // Si mientras esperábamos se tipeó otra cosa, esta respuesta ya no vale.
      if (token !== this._token) return this.results;

      this.results = rows || [];
      this.error = null;
      this._setState(this.results.length ? 'results' : 'empty');
    } catch (e) {
      if (token !== this._token) return this.results;

      this.results = [];
      this.error = e?.message || String(e);
      this._setState('error');
    }

    this._render();
    return this.results;
  }

  /** Refresca los resultados de la consulta actual (Realtime / polling). */
  async refresh() {
    if (!sanitizeQuery(this.query)) return this.results;
    return this._runSearch({ silent: true });
  }

  /** Borra la consulta y los resultados. */
  clear() {
    clearTimeout(this._timer);
    this.query = '';
    this.results = [];
    this.error = null;
    this._syncInput();
    this._setState('idle');
    this._render();
  }

  /** Libera el timer (por ejemplo al cerrar la vista). */
  destroy() {
    clearTimeout(this._timer);
    this._timer = null;
  }

  /** Cambia el estado y escribe el mensaje para el usuario. */
  _setState(state) {
    this.state = state;
    if (!this.statusEl) return;

    const messages = {
      idle: '',
      loading: 'Buscando…',
      empty: 'Sin resultados para esa patente.',
      error: 'Error al buscar: ' + (this.error || 'intentá de nuevo'),
      results: this.results.length === 1
        ? '1 resultado'
        : `${this.results.length} resultados`,
    };

    this.statusEl.textContent = messages[state] || '';
    this.statusEl.classList.toggle('error', state === 'error');
  }

  /** Dibuja la lista de resultados. */
  _render() {
    if (!this.resultsEl) return;

    if (!this.results.length) {
      this.resultsEl.innerHTML = '';
      return;
    }

    this.resultsEl.innerHTML = this.results.map(r => {
      const t = TYPE_LABELS[r.type] || { label: r.type || '—', cls: 'unk' };
      const owner = r.owner_name
        ? `<span class="mr-owner">${escapeHtml(r.owner_name)}</span>`
        : '';
      return `<button type="button" class="manual-result" data-plate="${escapeHtml(r.plate)}">
          <span class="mr-plate">${escapeHtml(r.plate)}</span>
          <span class="plate-row-badge ${t.cls}">${escapeHtml(t.label)}</span>
          ${owner}
        </button>`;
    }).join('');

    this.resultsEl.querySelectorAll('.manual-result').forEach(el => {
      el.addEventListener('click', () => {
        const plate = el.dataset.plate;
        const row = this.results.find(r => r.plate === plate) || { plate };
        this.onSelect(row);
      });
    });
  }
}
