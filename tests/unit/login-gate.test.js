import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// ============================================================
// Gate de login: sin sesión (ni flotante ni admin) solo se ve
// el login. Se verifican las tres capas que lo sostienen:
//   1. HTML: solo view-guest-login nace activa + nav admin oculta.
//   2. CSS: body.is-guest-login oculta todo lo demás y el nav.
//   3. JS: navigate() redirige las vistas protegidas al login.
// (Pruebas de humo sobre los archivos fuente: si alguien rompe
// alguna de las tres capas, este test falla.)
// ============================================================

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const indexHtml = read('../../index.html');
const styleCss = read('../../style.css');
const appJs = read('../../app-supabase.js');

describe('Sin sesión solo se ve el login (HTML)', () => {
  it('exactamente una vista nace activa y es la de login', () => {
    const activas = indexHtml.match(/class="view active"/g) || [];
    expect(activas).toHaveLength(1);
    expect(indexHtml).toMatch(/id="view-guest-login" class="view active"/);
  });

  it('el nav de admin nace oculto (solo lo muestra un admin logueado)', () => {
    expect(indexHtml).toMatch(/id="nav-admin" style="display:none"/);
  });
});

describe('Sin sesión solo se ve el login (CSS)', () => {
  it('body.is-guest-login oculta todas las vistas menos la de login', () => {
    expect(styleCss).toMatch(/body\.is-guest-login \.view:not\(#view-guest-login\)[^}]*display: none !important/);
  });

  it('body.is-guest-login oculta la barra de navegación', () => {
    expect(styleCss).toMatch(/body\.is-guest-login \.bottom-nav \{[^}]*display: none !important/);
  });
});

describe('Sin sesión solo se ve el login (JS)', () => {
  it('navigate() marca como protegidas todas las vistas de la app', () => {
    expect(appJs).toMatch(/const protectedViews = \['home', 'camera', 'register', 'call', 'plates', 'profile', 'admin'\]/);
  });

  it('sin sesión, navegar a una vista protegida redirige al login', () => {
    expect(appJs).toMatch(/if \(needsAuth && !hasSession\) \{\s*view = 'guest-login';/);
  });

  it('solo un sesión admin puede abrir el panel de administración', () => {
    expect(appJs).toMatch(/if \(view === 'admin' && appMode !== 'admin'\) \{\s*view = 'home';/);
  });

  it('sin sesión la app no consulta datos de Supabase al arrancar', () => {
    // initAuth: sin sesión de Supabase ni flotante → navigate('guest-login')
    // y NO llama a loadUserData()/refreshPlatesCache() en esa rama.
    const initAuth = appJs.match(/async function initAuth\(\) \{[\s\S]*?\n\}/)?.[0] || '';
    expect(initAuth).toBeTruthy();
    const ramaSinSesion = initAuth.slice(initAuth.lastIndexOf('appMode = \'unknown\''));
    expect(ramaSinSesion).toContain("await navigate('guest-login')");
    expect(ramaSinSesion).not.toContain('loadUserData');
    expect(ramaSinSesion).not.toContain('refreshPlatesCache');
  });
});
