import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ============================================================
// Acceso a datos según la sesión
// ------------------------------------------------------------
//   - Admin (Supabase Auth): lee las tablas directamente.
//   - Flotante (whitelist + token): usa los RPCs flotante_* que
//     validan su sesión.
//   - Anónimo: sin acceso (lo aplica la migración SQL 2026-11-05).
//
// Mientras la migración SQL no esté aplicada, el flotante cae a la
// ruta vieja si el RPC no existe: la app nunca se queda sin datos.
// ============================================================

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

const mockSupabase = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
  },
  from: vi.fn(() => makeQuery({ data: [], error: null })),
  rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
};

let cliente;

beforeAll(async () => {
  globalThis.supabase = { createClient: () => mockSupabase };
  cliente = await import('../../supabase-client.js');
});

const SESION_FLOTANTE = {
  name: 'gogo',
  session_token: '11111111-1111-1111-1111-111111111111',
};

describe('Acceso a datos según la sesión', () => {
  beforeEach(() => {
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    mockSupabase.from.mockImplementation(() => makeQuery({ data: [], error: null }));
    mockSupabase.rpc.mockResolvedValue({ data: [], error: null });
    cliente.setFlotanteSession(null);
  });

  it('el flotante lee las patentes por su RPC (no por la tabla)', async () => {
    cliente.setFlotanteSession(SESION_FLOTANTE);
    mockSupabase.rpc.mockResolvedValue({
      data: [{ plate: 'ABC123', type: 'administration', is_active: true }],
      error: null,
    });

    const filas = await cliente.getPlates({ type: 'administration', limit: 500 });

    expect(mockSupabase.rpc).toHaveBeenCalledWith('flotante_plates', expect.objectContaining({
      p_name: 'gogo',
      p_session_token: SESION_FLOTANTE.session_token,
      p_type: 'administration',
    }));
    // La tabla NO se consulta cuando el flotante tiene su RPC
    expect(mockSupabase.from).not.toHaveBeenCalledWith('plates');
    expect(filas).toHaveLength(1);
  });

  it('el admin (Supabase Auth) sigue leyendo la tabla directamente', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'admin-1' } } },
      error: null,
    });

    await cliente.getPlates({ type: 'administration', limit: 500 });

    expect(mockSupabase.from).toHaveBeenCalledWith('plates');
    expect(mockSupabase.rpc).not.toHaveBeenCalledWith('flotante_plates', expect.anything());
  });

  it('si el RPC del flotante no existe todavía, cae a la lectura directa', async () => {
    cliente.setFlotanteSession(SESION_FLOTANTE);
    mockSupabase.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function public.flotante_plates' },
    });

    await cliente.getPlates({ type: 'administration', limit: 500 });

    expect(mockSupabase.from).toHaveBeenCalledWith('plates');
  });

  it('un error real (no "función inexistente") no se oculta con el fallback', async () => {
    cliente.setFlotanteSession(SESION_FLOTANTE);
    mockSupabase.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'permission denied for function flotante_plates' },
    });

    await expect(cliente.getPlates({ type: 'administration' })).rejects.toThrow();
    expect(mockSupabase.from).not.toHaveBeenCalledWith('plates');
  });

  it('la búsqueda de patentes del flotante usa su RPC', async () => {
    cliente.setFlotanteSession(SESION_FLOTANTE);
    mockSupabase.rpc.mockResolvedValue({
      data: [{ plate: 'AB12', type: 'first_aid', owner_name: 'Ana' }],
      error: null,
    });

    const res = await cliente.searchPlates({ search: 'AB' });

    expect(mockSupabase.rpc).toHaveBeenCalledWith('flotante_search_plates', expect.objectContaining({
      p_search: 'AB',
      p_name: 'gogo',
    }));
    expect(res).toHaveLength(1);
  });

  it('la consulta puntual de patente del flotante usa su RPC', async () => {
    cliente.setFlotanteSession(SESION_FLOTANTE);
    mockSupabase.rpc.mockResolvedValue({
      data: [{ plate: 'ABC123', type: 'administration' }],
      error: null,
    });

    const res = await cliente.lookupPlate('abc123');

    expect(mockSupabase.rpc).toHaveBeenCalledWith('flotante_lookup_plate', expect.objectContaining({
      p_plate: 'ABC123',
      p_name: 'gogo',
    }));
    expect(res.plate).toBe('ABC123');
  });

  it('los contactos de emergencia del flotante llegan por su RPC', async () => {
    cliente.setFlotanteSession(SESION_FLOTANTE);
    mockSupabase.rpc.mockResolvedValue({
      data: [
        { name: 'Carabineros', phone: '133', type: 'police', icon: '🚨' },
        { name: 'Auxiliar', phone: '', type: 'custom', icon: '👮' },
      ],
      error: null,
    });

    const contactos = await cliente.getEmergencyContacts();

    expect(mockSupabase.rpc).toHaveBeenCalledWith('flotante_emergency_contacts', expect.objectContaining({
      p_name: 'gogo',
    }));
    expect(contactos).toHaveLength(2);
    expect(contactos[0].phone).toBe('133');
  });

  it('el admin lee los contactos de emergencia desde app_settings', async () => {
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'admin-1' } } },
      error: null,
    });
    mockSupabase.from.mockImplementation(() => makeQuery({
      data: { value: [{ name: 'Carabineros', phone: '133' }] },
      error: null,
    }));

    const contactos = await cliente.getEmergencyContacts();

    expect(mockSupabase.from).toHaveBeenCalledWith('app_settings');
    expect(contactos).toHaveLength(1);
  });
});
