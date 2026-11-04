import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ============================================================
// Admin - botón 🗑️ de Patentes
// ------------------------------------------------------------
// Bug original: la tabla plates no tenía política RLS de DELETE,
// así que PostgREST respondía SIN error pero borraba 0 filas y el
// admin veía "Patente eliminada" mientras la patente seguía ahí.
// El flujo ahora usa .select() para contar las filas borradas.
// ============================================================

// Mock de Supabase (el módulo real exige globalThis.supabase)
function makeQuery(result) {
  const q = {
    select: () => q,
    insert: () => q,
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

// Resultado configurable del DELETE (lo decide cada test)
let deleteResult = { data: [], error: null };

const mockSupabase = {
  auth: {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'admin-1' } }, error: null }),
  },
  from: vi.fn(() => makeQuery(deleteResult)),
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
};

let AdminDashboard;

beforeAll(async () => {
  globalThis.supabase = { createClient: () => mockSupabase };
  ({ AdminDashboard } = await import('../../admin.js'));
});

function montarAdmin() {
  document.body.innerHTML = '<div id="view-admin"></div><div id="toast"></div>';
  const dashboard = new AdminDashboard();
  dashboard.renderLayout({ role: 'admin' });
  dashboard.bindEvents();

  // El resto de la vista no importa acá: solo corre el flujo de borrado.
  vi.spyOn(dashboard, 'loadPlates').mockResolvedValue();
  vi.spyOn(dashboard, 'loadPlateStats').mockResolvedValue();
  vi.spyOn(dashboard, 'loadStats').mockResolvedValue();
  return dashboard;
}

/** deletePlate queda esperando la respuesta del modal de confirmación. */
async function confirmar(dashboard, { accept = true } = {}) {
  const pending = dashboard.deletePlate('id-1', 'ABCD12');
  await Promise.resolve();
  document.getElementById(accept ? 'admin-confirm-ok' : 'admin-confirm-cancel').click();
  await pending;
}

function toastText() {
  return document.getElementById('toast')?.textContent || '';
}

describe('Admin - borrar patente (🗑️)', () => {
  beforeEach(() => {
    deleteResult = { data: [], error: null };
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'admin-1' } }, error: null });
    mockSupabase.rpc.mockResolvedValue({ data: null, error: null });
    mockSupabase.from.mockImplementation(() => makeQuery(deleteResult));
  });

  it('muestra "Patente eliminada" cuando la base devuelve filas borradas', async () => {
    const dashboard = montarAdmin();
    deleteResult = { data: [{ id: 'id-1' }], error: null };

    await confirmar(dashboard);

    expect(mockSupabase.from).toHaveBeenCalledWith('plates');
    expect(toastText()).toContain('Patente eliminada');
    expect(dashboard.loadPlates).toHaveBeenCalled();
    expect(dashboard.loadPlateStats).toHaveBeenCalled();
  });

  it('detecta el borrado en silencio (0 filas) y avisa en vez de mentir', async () => {
    const dashboard = montarAdmin();
    deleteResult = { data: [], error: null }; // así respondía sin política RLS

    await confirmar(dashboard);

    expect(toastText()).toContain('No se pudo eliminar');
    expect(toastText()).not.toContain('Patente eliminada');
    // No recarga la lista como si nada hubiera pasado
    expect(dashboard.loadPlates).not.toHaveBeenCalled();
  });

  it('muestra el mensaje de error si la base rechaza la operación', async () => {
    const dashboard = montarAdmin();
    deleteResult = { data: null, error: { message: 'permission denied for table plates' } };

    await confirmar(dashboard);

    expect(toastText()).toContain('permission denied for table plates');
    expect(dashboard.loadPlates).not.toHaveBeenCalled();
  });

  it('si el usuario cancela la confirmación no toca la base', async () => {
    const dashboard = montarAdmin();
    deleteResult = { data: [{ id: 'id-1' }], error: null };

    await confirmar(dashboard, { accept: false });

    expect(mockSupabase.from).not.toHaveBeenCalled();
    expect(dashboard.loadPlates).not.toHaveBeenCalled();
    expect(toastText()).not.toContain('Patente eliminada');
  });
});
