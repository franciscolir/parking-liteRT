import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ============================================================
// Lista unificada de flotantes + alta masiva + pestañas
// ------------------------------------------------------------
// Verifica los cambios del panel admin:
//   - UNA sola lista (sesiones + whitelist) con píldoras:
//       · en uso   → círculo verde + botón "Desactivar" (baja + cierra sesión)
//       · libre    → checkbox (activo ⇒ puede loguearse)
//       · inactivo → píldora apagada + checkbox sin marcar
//       · ⋯ por fila → Editar / Borrar
//   - La fila va en UNA línea: [luz] [estado] [nombre] [control] [⋯]
//   - Checkbox de encabezado "Activar todos"
//   - Botón Ajustes → modal de tiempo de logout (sin input inline)
//   - Alta masiva: varios nombres separados por un espacio
//   - La pestaña Escaneos ya no existe (esa info vive en Home)
// ============================================================

const WHITELIST = [
  { id: '11111111-1111-1111-1111-111111111111', allowed_name: 'GUARDIA 1', is_active: true },
  { id: '22222222-2222-2222-2222-222222222222', allowed_name: 'JUAN', is_active: false },
];

const SESIONES = [
  { name: 'GUARDIA 1', last_activity: new Date().toISOString() },
];

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
    upsert: () => q,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
}

const mockRpc = vi.fn();

const mockSupabase = {
  auth: {
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'admin-1' } }, error: null }),
  },
  from: vi.fn(() => makeQuery({ data: [], error: null })),
  rpc: mockRpc,
};

let AdminDashboard;

beforeAll(async () => {
  globalThis.supabase = { createClient: () => mockSupabase };
  ({ AdminDashboard } = await import('../../admin.js'));
});

/** Respuestas de las RPC que usa loadWhitelist / saveAccess. */
function rpcDefault(fn, args) {
  if (fn === 'get_whitelist') return { data: WHITELIST, error: null };
  if (fn === 'get_whitelist_active') return { data: WHITELIST, error: null };
  if (fn === 'get_active_sessions') return { data: SESIONES, error: null };
  if (fn === 'add_whitelist_entry') return { data: { ok: true }, error: null };
  if (fn === 'set_whitelist_active') return { data: { ok: true }, error: null };
  return { data: null, error: null };
}

function montarAdmin() {
  document.body.innerHTML = '<div id="view-admin"></div><div id="toast"></div>';
  const dashboard = new AdminDashboard();
  dashboard.renderLayout({ role: 'admin' });
  dashboard.bindEvents();
  return dashboard;
}

describe('Admin - lista unificada de flotantes', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpc.mockImplementation(async (fn, args) => rpcDefault(fn, args));
    mockSupabase.from.mockImplementation(() => makeQuery({ data: [], error: null }));
  });

  it('dibuja una sola lista con píldoras (sin lista de sesiones aparte)', async () => {
    const dashboard = montarAdmin();
    await dashboard.loadWhitelist();

    expect(document.getElementById('admin-whitelist-list')).toBeTruthy();
    // Ni el Home ni Flotantes tienen listas de sesiones separadas
    expect(document.getElementById('admin-sessions-list')).toBeNull();
    expect(document.getElementById('admin-floating-sessions')).toBeNull();

    const rows = document.querySelectorAll('#admin-whitelist-list .pill-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.pill-name').textContent).toBe('GUARDIA 1');
  });

  it('en uso → círculo verde + botón Desactivar (en vez de checkbox)', async () => {
    const dashboard = montarAdmin();
    await dashboard.loadWhitelist();

    const row = document.querySelector('#admin-whitelist-list .pill-row');
    expect(row.querySelector('.pill-dot').classList.contains('on')).toBe(true);
    expect(row.querySelector('[data-action="deactivate-use"]').textContent).toContain('Desactivar');
    expect(row.querySelector('[data-action="toggle-active"]')).toBeNull();
    expect(row.querySelector('.pill-badge').textContent).toBe('EN USO');
  });

  it('la fila queda en UNA línea: [luz] [estado] [nombre] [control] [⋯]', async () => {
    const dashboard = montarAdmin();
    await dashboard.loadWhitelist();

    const row = document.querySelector('#admin-whitelist-list .pill-row');
    const orden = [...row.children]
      .filter(el => !el.classList.contains('pill-actions'))
      .map(el => el.className.split(' ')[0]);
    expect(orden).toEqual(['pill-dot', 'pill-badge', 'pill-name', 'btn-small', 'admin-card-actions']);
  });

  it('Desactivar pone el nombre en inactivo Y cierra su sesión', async () => {
    const dashboard = montarAdmin();
    await dashboard.loadWhitelist();

    document.querySelector('[data-action="deactivate-use"]').click();
    await new Promise(r => setTimeout(r, 0));

    // Pide confirmación antes de actuar
    const modal = document.getElementById('admin-confirm-modal');
    expect(modal.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('admin-confirm-message').textContent).toContain('GUARDIA 1');

    document.getElementById('admin-confirm-ok').click();
    await new Promise(r => setTimeout(r, 0));

    expect(mockRpc).toHaveBeenCalledWith(
      'set_whitelist_active',
      expect.objectContaining({ p_id: '11111111-1111-1111-1111-111111111111', p_active: false }),
    );
    expect(mockRpc).toHaveBeenCalledWith('force_logout', { p_name: 'GUARDIA 1' });
  });

  it('inactivo → píldora apagada y checkbox sin marcar', async () => {
    const dashboard = montarAdmin();
    await dashboard.loadWhitelist();

    const rows = document.querySelectorAll('#admin-whitelist-list .pill-row');
    const inactiva = rows[1];
    expect(inactiva.classList.contains('pill-inactive')).toBe(true);
    expect(inactiva.querySelector('.pill-badge').textContent).toBe('INACTIVO');

    const check = inactiva.querySelector('[data-action="toggle-active"]');
    expect(check).toBeTruthy();
    expect(check.checked).toBe(false);
  });

  it('el checkbox de la fila activa/desactiva el nombre', async () => {
    const dashboard = montarAdmin();
    await dashboard.loadWhitelist();

    const check = document.querySelector('#admin-whitelist-list [data-action="toggle-active"]');
    check.click();

    expect(mockRpc).toHaveBeenCalledWith(
      'set_whitelist_active',
      expect.objectContaining({ p_id: '22222222-2222-2222-2222-222222222222', p_active: true }),
    );
  });

  it('el botón ⋯ muestra Editar y Borrar de la fila', async () => {
    const dashboard = montarAdmin();
    await dashboard.loadWhitelist();

    const row = document.querySelectorAll('#admin-whitelist-list .pill-row')[1];
    const actions = row.querySelector('.pill-actions');
    expect(actions.classList.contains('hidden')).toBe(true);

    row.querySelector('[data-action="row-menu"]').click();
    expect(actions.classList.contains('hidden')).toBe(false);
    expect(actions.querySelector('[data-action="edit-access"]')).toBeTruthy();
    expect(actions.querySelector('[data-action="remove-access"]')).toBeTruthy();
  });

  it('Editar abre el modal con el nombre en mayúsculas', async () => {
    const dashboard = montarAdmin();
    await dashboard.loadWhitelist();

    const row = document.querySelectorAll('#admin-whitelist-list .pill-row')[1];
    row.querySelector('[data-action="row-menu"]').click();
    row.querySelector('[data-action="edit-access"]').click();

    const modal = document.getElementById('admin-access-modal');
    expect(modal.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('admin-access-name').value).toBe('JUAN');
    expect(document.getElementById('admin-access-modal-title').textContent).toContain('Editar');
  });

  it('"Activar todos" se marca solo si todos están activos', async () => {
    const dashboard = montarAdmin();
    await dashboard.loadWhitelist();

    const checkAll = document.getElementById('admin-check-all');
    expect(checkAll.checked).toBe(false);   // JUAN está inactivo

    checkAll.click();
    // Solo el nombre inactivo (JUAN) cambia de estado
    expect(mockRpc).toHaveBeenCalledWith(
      'set_whitelist_active',
      expect.objectContaining({ p_id: '22222222-2222-2222-2222-222222222222', p_active: true }),
    );
  });

  it('el botón Ajustes abre el modal de logout (sin input inline)', async () => {
    montarAdmin();

    const flotantes = document.getElementById('admin-subtab-users-floating');
    // El timeout ya no es una card inline en la sub-vista
    expect(flotantes.querySelector('#admin-timeout-input')).toBeNull();

    document.getElementById('admin-settings-btn').click();
    await new Promise(r => setTimeout(r, 0));

    const modal = document.getElementById('admin-settings-modal');
    expect(modal.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('admin-timeout-input')).toBeTruthy();
    expect(document.getElementById('admin-timeout-save')).toBeTruthy();
  });
});

describe('Admin - alta masiva de nombres', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpc.mockImplementation(async (fn, args) => rpcDefault(fn, args));
    mockSupabase.from.mockImplementation(() => makeQuery({ data: [], error: null }));
  });

  it('el input admite varios nombres y está en MAYÚSCULAS', () => {
    montarAdmin();
    document.getElementById('admin-add-access').click();

    const input = document.getElementById('admin-access-name');
    expect(input.maxLength).toBe(200);
    expect(input.className).toContain('input-name');
    // Sin el override que anulaba las mayúsculas
    expect(input.getAttribute('style') || '').not.toContain('text-transform:none');
    expect(document.getElementById('admin-access-hint').textContent).toContain('espacio');
  });

  it('agrega todos los nombres separados por un espacio', async () => {
    const dashboard = montarAdmin();
    document.getElementById('admin-add-access').click();
    document.getElementById('admin-access-name').value = '  guardia1   JUAN   ana  ';

    await dashboard.saveAccess();

    const agregados = mockRpc.mock.calls
      .filter(([fn]) => fn === 'add_whitelist_entry')
      .map(([, args]) => args.p_name);
    expect(agregados).toEqual(['GUARDIA1', 'JUAN', 'ANA']);
    // El modal queda cerrado
    expect(document.getElementById('admin-access-modal').classList.contains('hidden')).toBe(true);
  });

  it('al editar el nombre completo conserva los espacios internos', async () => {
    const dashboard = montarAdmin();
    await dashboard.loadWhitelist();

    const row = document.querySelectorAll('#admin-whitelist-list .pill-row')[1];
    row.querySelector('[data-action="row-menu"]').click();
    row.querySelector('[data-action="edit-access"]').click();

    const input = document.getElementById('admin-access-name');
    input.value = '  ana perez  ';
    await dashboard.saveAccess();

    expect(mockRpc).toHaveBeenCalledWith(
      'update_whitelist_entry',
      expect.objectContaining({ p_name: 'ANA PEREZ' }),
    );
  });

  it('nombra repetidos una sola vez', async () => {
    const dashboard = montarAdmin();
    document.getElementById('admin-add-access').click();
    document.getElementById('admin-access-name').value = 'ANA ana ANA';

    await dashboard.saveAccess();

    const agregados = mockRpc.mock.calls
      .filter(([fn]) => fn === 'add_whitelist_entry')
      .map(([, args]) => args.p_name);
    expect(agregados).toEqual(['ANA']);
  });

  it('Enter en el modal guarda', async () => {
    const dashboard = montarAdmin();
    document.getElementById('admin-add-access').click();
    const input = document.getElementById('admin-access-name');
    input.value = 'PEDRO';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await new Promise(r => setTimeout(r, 0));
    expect(mockRpc).toHaveBeenCalledWith('add_whitelist_entry', { p_name: 'PEDRO' });
  });
});

describe('Admin - pestaña Escaneos eliminada', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpc.mockImplementation(async (fn, args) => rpcDefault(fn, args));
  });

  it('no queda ni el tab ni su contenido (la info está en Home)', () => {
    montarAdmin();

    expect(document.querySelector('.admin-tab[data-tab="scans"]')).toBeNull();
    expect(document.getElementById('admin-tab-scans')).toBeNull();
    expect(document.getElementById('admin-scans-list')).toBeNull();
    expect(document.getElementById('admin-scan-filter')).toBeNull();

    // Home sí muestra las últimas patentes escaneadas
    expect(document.getElementById('admin-recent-scans')).toBeTruthy();

    const tabs = [...document.querySelectorAll('.admin-tab')].map(t => t.dataset.tab);
    expect(tabs).toEqual(['home', 'users', 'plates']);
  });
});
