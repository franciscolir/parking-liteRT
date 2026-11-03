import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ============================================================
// Mock de Supabase (el módulo real exige globalThis.supabase)
// ============================================================
const platesDb = [];
const mockInsert = vi.fn();

function makeQuery(result) {
  const q = {
    select: () => q,
    insert: (...args) => {
      mockInsert(...args);
      return q;
    },
    update: () => q,
    delete: () => q,
    eq: () => q,
    neq: () => q,
    in: () => q,
    order: () => q,
    limit: () => q,
    range: () => q,
    ilike: () => q,
    maybeSingle: () => q,
    single: () => q,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

const mockSupabase = {
  auth: {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'admin-1' } }, error: null }),
  },
  from: vi.fn((table) => {
    if (table === 'plates') {
      return makeQuery({ data: platesDb, error: null });
    }
    return makeQuery({ data: [], error: null });
  }),
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
};

let AdminDashboard;

beforeAll(async () => {
  globalThis.supabase = { createClient: () => mockSupabase };
  ({ AdminDashboard } = await import('../../admin.js'));
});

const TEXTO = [
  'Buenos días, para hoy ingresan:',
  'ABCD12 ambulancia',
  'BCDF34 de la administración',
  'También viene el vehículo patente AB-CD-13.',
].join('\n');

function montarAdmin() {
  document.body.innerHTML = '<div id="view-admin"></div><div id="toast"></div>';
  const dashboard = new AdminDashboard();
  dashboard.renderLayout({ role: 'admin' });
  dashboard.bindEvents();
  return dashboard;
}

describe('Admin - Ingreso masivo por texto (UI)', () => {
  beforeEach(() => {
    platesDb.length = 0;

    // El setup global hace restoreAllMocks() tras cada test: hay que
    // re-establecer las implementaciones de los mocks.
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'admin-1' } }, error: null });
    mockSupabase.rpc.mockResolvedValue({ data: null, error: null });
    mockSupabase.from.mockImplementation((table) => {
      if (table === 'plates') return makeQuery({ data: platesDb, error: null });
      return makeQuery({ data: [], error: null });
    });
    mockInsert.mockClear();

    montarAdmin();
  });

  it('renderiza la sub-vista masiva con el textarea y el botón de analizar', () => {
    const tab = document.querySelector('.admin-tab[data-tab="plates"]');
    expect(tab).toBeTruthy();
    // El ingreso masivo ahora es una sub-vista del tab Patentes
    const subtab = document.querySelector('.admin-subtab[data-subtab="plates-bulk"]');
    expect(subtab).toBeTruthy();
    expect(document.getElementById('bulk-text')).toBeTruthy();
    expect(document.getElementById('bulk-analyze')).toBeTruthy();
    expect(document.getElementById('bulk-save').disabled).toBe(true);
    expect(document.getElementById('bulk-results').classList.contains('hidden')).toBe(true);
  });

  it('analiza el texto y muestra la tabla sin guardar nada', async () => {
    const dashboard = montarAdmin();
    document.getElementById('bulk-text').value = TEXTO;

    await dashboard.analyzeBulkText();

    const rows = document.querySelectorAll('#bulk-table-body tr');
    expect(rows).toHaveLength(3);

    // El análisis solo LEE (verifica existentes): no inserta nada
    expect(mockInsert).not.toHaveBeenCalled();
    expect(platesDb).toHaveLength(0);

    // El botón de guardar se habilita recién después del análisis
    expect(document.getElementById('bulk-save').disabled).toBe(false);

    // Resumen: las 3 filas ya nacen con tipo (por defecto special_needs)
    const summary = document.getElementById('bulk-summary').textContent;
    expect(summary).toContain('Se encontraron 3 patentes');
    expect(summary).toContain('3 listas para guardar');
  });

  it('la píldora de duplicados las elimina al presionarla', async () => {
    const dashboard = montarAdmin();
    document.getElementById('bulk-text').value = 'ABCD12 ... AB-CD-12';
    await dashboard.analyzeBulkText();

    expect(document.querySelectorAll('#bulk-table-body tr')).toHaveLength(2);

    // La píldora del resumen es un botón clicable
    const pill = document.getElementById('bulk-dedup');
    expect(pill).toBeTruthy();

    pill.click();

    // Queda una sola fila y ya no está marcada como duplicada
    expect(document.querySelectorAll('#bulk-table-body tr')).toHaveLength(1);
    expect(dashboard.bulkSession.rows[0].plateStatus).toBe('ok');
  });

  it('la píldora de limpieza elimina también las que ya existen en la base', async () => {
    // ABCD12 ya está en la base de datos
    platesDb.push({ plate: 'ABCD12', type: 'first_aid', is_active: true });

    const dashboard = montarAdmin();
    document.getElementById('bulk-text').value = 'ABCD12 ambulancia\nBCDF34 administración';
    await dashboard.analyzeBulkText();

    expect(document.querySelectorAll('#bulk-table-body tr')).toHaveLength(2);

    const pill = document.getElementById('bulk-dedup');
    expect(pill).toBeTruthy();
    expect(pill.textContent).toContain('ya existe');

    pill.click();

    // La que ya existe desaparece de la lista; queda solo la nueva
    expect(document.querySelectorAll('#bulk-table-body tr')).toHaveLength(1);
    expect(dashboard.bulkSession.rows[0].plate).toBe('BCDF34');
  });

  it('el tab Usuarios alterna entre registrados y flotantes con las sub-tabs', () => {
    montarAdmin();

    // Solo 4 tabs: Home, Usuarios, Patentes, Escaneos
    expect(document.querySelectorAll('.admin-tab')).toHaveLength(4);

    // Registrados activo por defecto; Flotantes contiene los accesos
    expect(document.getElementById('admin-subtab-users-registered').classList.contains('active')).toBe(true);
    expect(document.getElementById('admin-subtab-users-floating').classList.contains('active')).toBe(false);
    expect(document.getElementById('admin-whitelist-list')).toBeTruthy();
    expect(document.getElementById('admin-floating-sessions')).toBeTruthy();

    document.querySelector('.admin-subtab[data-subtab="users-floating"]').click();
    expect(document.getElementById('admin-subtab-users-floating').classList.contains('active')).toBe(true);
    expect(document.getElementById('admin-subtab-users-registered').classList.contains('active')).toBe(false);
  });

  it('permite editar la patente y el tipo directamente en la celda', async () => {
    const dashboard = montarAdmin();
    document.getElementById('bulk-text').value = TEXTO;
    await dashboard.analyzeBulkText();

    const input = document.querySelector('#bulk-table-body .bulk-input');
    input.value = 'ZZZZ77';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(dashboard.bulkSession.rows[0].plate).toBe('ZZZZ77');

    const select = document.querySelector('#bulk-table-body .bulk-select');
    select.value = 'first_aid';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(dashboard.bulkSession.rows[0].type).toBe('first_aid');
  });

  it('permite eliminar una fila y agregar una manualmente', async () => {
    const dashboard = montarAdmin();
    document.getElementById('bulk-text').value = TEXTO;
    await dashboard.analyzeBulkText();

    document.querySelector('[data-action="bulk-remove"]').click();
    expect(document.querySelectorAll('#bulk-table-body tr')).toHaveLength(2);

    document.getElementById('bulk-add-row').click();
    expect(document.querySelectorAll('#bulk-table-body tr')).toHaveLength(3);
    expect(dashboard.bulkSession.rows[2].manual).toBe(true);
  });

  it('guarda con un único INSERT después de la confirmación', async () => {
    const dashboard = montarAdmin();
    document.getElementById('bulk-text').value = TEXTO;
    await dashboard.analyzeBulkText();

    // Asignar el tipo que falta
    const select = document.querySelectorAll('#bulk-table-body .bulk-select')[2];
    select.value = 'special_needs';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const savePromise = dashboard.saveBulkPlates();

    await vi.waitFor(() =>
      expect(document.getElementById('admin-confirm-modal').classList.contains('hidden')).toBe(false)
    );
    expect(document.getElementById('admin-confirm-message').textContent).toContain('Se encontraron 3 patentes');
    document.getElementById('admin-confirm-ok').click();

    await savePromise;

    // Un solo insert con todas las filas listas
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const payload = mockInsert.mock.calls[0][0];
    expect(payload).toHaveLength(3);
    expect(payload.map(p => p.plate)).toEqual(['ABCD12', 'BCDF34', 'ABCD13']);
    expect(payload.every(p => p.reported_by === 'admin-1')).toBe(true);

    // Tras guardar, el editor queda limpio
    expect(document.getElementById('bulk-text').value).toBe('');
    expect(document.querySelectorAll('#bulk-table-body tr[data-id]')).toHaveLength(0);
  });

  it('no guarda si el usuario cancela la confirmación', async () => {
    const dashboard = montarAdmin();
    document.getElementById('bulk-text').value = TEXTO;
    await dashboard.analyzeBulkText();

    const savePromise = dashboard.saveBulkPlates();
    await vi.waitFor(() =>
      expect(document.getElementById('admin-confirm-modal').classList.contains('hidden')).toBe(false)
    );
    document.getElementById('admin-confirm-cancel').click();
    await savePromise;

    expect(dashboard.bulkSession.rows).toHaveLength(3);
    expect(platesDb).toHaveLength(0);
  });

  it('informa el error de la base de datos sin mostrar un guardado parcial', async () => {
    const dashboard = montarAdmin();
    document.getElementById('bulk-text').value = TEXTO;
    await dashboard.analyzeBulkText();

    const select = document.querySelectorAll('#bulk-table-body .bulk-select')[2];
    select.value = 'special_needs';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    // La base de datos rechaza el lote
    const originalFrom = mockSupabase.from.getMockImplementation();
    mockSupabase.from.mockImplementation((table) => {
      if (table !== 'plates') return originalFrom(table);
      const q = makeQuery({ data: null, error: { message: '23505 duplicate key plates_plate_key' } });
      q.insert = () => q;
      return q;
    });

    const savePromise = dashboard.saveBulkPlates();
    await vi.waitFor(() =>
      expect(document.getElementById('admin-confirm-modal').classList.contains('hidden')).toBe(false)
    );
    document.getElementById('admin-confirm-ok').click();
    await savePromise;

    expect(document.getElementById('toast').textContent).toContain('No se guardó ninguna patente');
    // La tabla sigue ahí para corregir y reintentar
    expect(document.querySelectorAll('#bulk-table-body tr')).toHaveLength(3);

    mockSupabase.from.mockImplementation(originalFrom);
  });
});
