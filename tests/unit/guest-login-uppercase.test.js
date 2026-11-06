import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// ============================================================
// Login de flotantes SIEMPRE en MAYÚSCULAS
// ------------------------------------------------------------
// La whitelist se guarda y se compara en mayúsculas: el login
// normaliza el nombre antes de mandarlo al backend y, si el nombre
// está dado de baja (is_active = false), no deja entrar.
// ============================================================

const mockRpc = vi.fn();

const mockSupabase = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
  },
  from: vi.fn(() => ({
    select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
    then: (resolve) => Promise.resolve({ data: null, error: null }).then(resolve),
  })),
  rpc: mockRpc,
};

let guestAuth;

beforeAll(async () => {
  globalThis.supabase = { createClient: () => mockSupabase };
  ({ guestAuth } = await import('../../guest-auth.js'));
});

/** validate_and_start_session acepta el nombre; is_name_active dice activo. */
function rpcOk() {
  mockRpc.mockImplementation(async (fn, args) => {
    if (fn === 'is_name_active') return { data: { ok: true, active: true }, error: null };
    if (fn === 'validate_and_start_session') {
      return { data: { ok: true, name: args.p_name, session_token: '11111111-1111-1111-1111-111111111111' }, error: null };
    }
    return { data: null, error: null };
  });
}

describe('guest-auth: login en mayúsculas', () => {
  beforeEach(() => {
    localStorage.clear();
    mockRpc.mockReset();
    rpcOk();
  });

  afterEach(() => {
    guestAuth.stopHeartbeat();
    guestAuth.session = null;
    localStorage.clear();
  });

  it('manda el nombre en MAYÚSCULAS aunque se escriba en minúsculas', async () => {
    const res = await guestAuth.login('  gogo  ');
    expect(res.ok).toBe(true);

    const llamada = mockRpc.mock.calls.find(([fn]) => fn === 'validate_and_start_session');
    expect(llamada[1].p_name).toBe('GOGO');
  });

  it('la sesión guardada queda en mayúsculas', async () => {
    const res = await guestAuth.login('ana perez');
    expect(res.ok).toBe(true);
    expect(res.session.name).toBe('ANA PEREZ');
    expect(guestAuth.displayName).toBe('ANA PEREZ');
  });

  it('no deja entrar a un nombre desactivado por el admin', async () => {
    mockRpc.mockImplementation(async (fn) => {
      if (fn === 'is_name_active') return { data: { ok: true, active: false }, error: null };
      return { data: { ok: true }, error: null };
    });

    const res = await guestAuth.login('BAJA');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('desactivado');
    // Nunca llegó a intentar abrir sesión
    const intento = mockRpc.mock.calls.find(([fn]) => fn === 'validate_and_start_session');
    expect(intento).toBeUndefined();
  });

  it('si la whitelist todavía tiene nombres en minúsculas, reintenta con el original', async () => {
    mockRpc.mockImplementation(async (fn, args) => {
      if (fn === 'is_name_active') return { data: { ok: true, active: true }, error: null };
      if (fn === 'validate_and_start_session') {
        // La base solo conoce el nombre en minúsculas (migración pendiente)
        const ok = args.p_name === 'gogo';
        return ok
          ? { data: { ok: true, name: 'gogo', session_token: '11111111-1111-1111-1111-111111111111' }, error: null }
          : { data: { ok: false, error: 'No autorizado' }, error: null };
      }
      return { data: null, error: null };
    });

    const res = await guestAuth.login('gogo');
    expect(res.ok).toBe(true);
  });
});
