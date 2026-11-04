import { guestAuth } from './guest-auth.js';
import { Camera } from './camera.js';
import { PlateDetector } from './detector.js';
import { PlateOCR } from './ocr.js';
import { validatePlate, normalizePlate } from './validator.js';
import { TYPE_LABELS, getScanStatus } from './plate-types.js';
import { PlateSearchView } from './plate-search-view.js';
import { Corrector } from './corrector.js';
import { AdminDashboard } from './admin.js';
import {
  supabase,
  signUp, signIn, signOut, getCurrentUser, onAuthStateChange,
  lookupPlate, getPlates, reportPlate,
  saveScan, getScanHistory, getScanStats,
  getContacts, addContact, updateContact, deleteContact,
  getEmergencyContacts, saveEmergencyContacts,
  setFlotanteSession,
  getProfile, updateProfile,
  subscribeToPlates, subscribeToScanHistory, subscribeToContacts,
  isAuthenticated, getUserId,
  PlateType, ScanStatus, ContactType
} from './supabase-client.js';
import {
  DEFAULT_EMERGENCY_CONTACTS,
  mergeContactLists,
} from './emergency-contacts.js';
// Exponer para debugging
//window.supabase = supabase;

// ============================================================
// ESTADO GLOBAL
// ============================================================
let camera, detector, ocr, corrector;
let running = false;
let rafId = null;
let lastPlate = null;
let lastPlateBox = null;
let noDetectFrames = 0;
let frameCount = 0;
let lastFpsTime = performance.now();
let streakCandidate = null;
let streakCount = 0;
let streakRequired = 2;
let noDetectLimit = 20;
let ocrCounter = 0;
let ocrSkipInterval = 3;
let lastBoxCenter = null;
let lastRawText = '';
let lastCorrected = '';
let lastOCRValid = false;

let currentUser = null;
let guestSession = null;   // { name, session_token } | null
let appMode = 'unknown';   // 'admin' | 'guest' | 'unknown'
let userProfile = null;
let scanHistory = [];
let scanCount = { total: 0, registered: 0, stolen: 0, unknown: 0 };
let contacts = [];
// Los 5 números por defecto de Llamadas: globales (app_settings).
// Arranca con el fallback local y se reemplaza al cargar la BD.
let emergencyContacts = DEFAULT_EMERGENCY_CONTACTS;
let platesCache = { special_needs: [], administration: [], first_aid: [] };
let subscriptions = [];

// Vista unificada Cámara / Manual ("Buscar patente")
let plateSearch = null;          // PlateSearchView (modo manual)
let searchMode = 'camera';        // 'camera' | 'manual'
let resumeCameraOnSwitch = false; // si estaba escaneando al pasar a Manual
let refreshPollTimer = null;      // respaldo de Realtime: polling 5 min
let physicalKeyboardOn = false;   // teclado físico de la PC (modo Manual)

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// ============================================================
// INICIALIZACIÓN
// ============================================================
document.addEventListener('DOMContentLoaded', async function () {
  setupUIEvents();

  // Respaldo de Realtime: refresco periódico (cada 5 min) de la cache de
  // patentes, del historial y de los resultados del buscador manual.
  startRefreshPolling();

  // Configurar callback de expiración de guest
  guestAuth.onExpired = () => {
    guestSession = null;
    appMode = 'unknown';
    showToast('Sesión expirada. Vuelve a ingresar.', 'error');
    navigate('guest-login');
  };

  // Escuchar cambios de auth de Supabase (solo afecta a admin)
  onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') {
      currentUser = null;
      userProfile = null;
      appMode = 'unknown';
      setFlotanteSession(null);
      updateAuthUI(false);
      if (!guestSession) {
        navigate('guest-login');
      }
    }
  });

  // ⚡ IMPORTANTE: llamar a initAuth
  await initAuth();

  // Los modelos se cargan en segundo plano, cuando el navegador está
  // libre: no bloquean el arranque de la app.
  scheduleIdle(() => { initModels().catch(() => {}); });

  runDiagnostics();
  setupPWAInstall();
});

// ============================================================
// AUTH HANDLERS
// ============================================================
/**
 * Determina el modo de la app al arrancar:
 *   - 'admin' si hay sesión de Supabase Auth
 *   - 'guest' si hay sesión flotante válida
 *   - 'unknown' si no hay ninguna
 */
function setupGuestHeartbeat() {
  // El heartbeat ya lo maneja guestAuth internamente.
  // Este callback se ejecuta cuando la sesión expira.
  guestAuth.onExpired = () => {
    guestSession = null;
    appMode = 'unknown';
    showToast('Sesión expirada. Vuelve a ingresar.', 'error');
    navigate('guest-login');
  };
}
async function initAuth() {
  // 1. ¿Hay sesión de Supabase Auth? (admin)
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    // Verificar que sea admin
    const { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    if (profile?.role === 'admin') {
      currentUser = user;
      userProfile = profile;
      appMode = 'admin';
      // Si venía una sesión flotante guardada, ya no aplica: el admin
      // lee los datos con su sesión de Supabase.
      setFlotanteSession(null);
      await loadUserData();
      updateAuthUI(true);
      await navigate('home');
      return;
    }

    // Si no es admin, cerrar sesión (usuarios flotantes no usan Supabase Auth)
    await supabase.auth.signOut();
  }

  // 2. ¿Hay sesión flotante guardada?
  const guest = await guestAuth.init();
  if (guest.ok && guest.session) {
    guestSession = guest.session;
    appMode = 'guest';
    setupGuestHeartbeat();
    restartRefreshPolling();
    // Historial del dispositivo (modo invitado).
    loadLocalHistory();
    // Cache local de patentes (lectura pública con anon key): permite
    // responder al instante en cámara y en el modo Manual.
    refreshPlatesCache().catch(() => {});
    // Realtime de las patentes (tabla pública): los cambios llegan en
    // segundos, también en modo invitado.
    setupRealtimeSubscriptions();
    await navigate('home');
    return;
  }

  // 3. Sin sesión → mostrar login flotante
  appMode = 'unknown';
  await navigate('guest-login');
}
async function handleAuthChange(event, session) {
  console.log('[Auth]', event, session?.user?.id);

  if (event === 'SIGNED_IN' && session?.user) {
        // Mostrar/ocultar nav de admin según el rol
    const navAdmin = document.getElementById('nav-admin');
    if (navAdmin) {
      const { data: prof } = await supabase
        .from('users')
        .select('role')
        .eq('id', session.user.id)
        .single();
      navAdmin.style.display = prof?.role === 'admin' ? 'flex' : 'none';
    }
    currentUser = session.user;
    setFlotanteSession(null);
    await loadUserData();
    updateAuthUI(true);
  } else if (event === 'SIGNED_OUT') {
        const navAdmin = document.getElementById('nav-admin');
    if (navAdmin) navAdmin.style.display = 'none';
    currentUser = null;
    userProfile = null;
    scanHistory = [];
    scanCount = { total: 0, registered: 0, stolen: 0, unknown: 0 };
    contacts = [];
    clearSubscriptions();
    updateAuthUI(false);
  }
}

async function loadUserData() {
  if (!currentUser) return;

  try {
    // Perfil
    userProfile = await getProfile(currentUser.id);

    // Stats
    const stats = await getScanStats(currentUser.id);
    scanCount = {
      total: stats.total_scans,
      registered: stats.registered_count,
      stolen: stats.stolen_count,
      unknown: stats.unknown_count
    };

    // Historial
    const history = await getScanHistory({ userId: currentUser.id, limit: 20 });
    scanHistory = history.map(h => ({
      plate: h.plate,
      status: h.status,
      time: new Date(h.created_at).getTime()
    }));

    // Contactos
    contacts = await getContacts(currentUser.id);

    // Patentes (cache local para verificación rápida)
    await refreshPlatesCache();

    // Suscripciones realtime
    setupRealtimeSubscriptions();

    updateHistory();
    renderContacts();
    renderPlatesTable();

  } catch (e) {
    console.error('Error cargando datos de usuario:', e);
    showToast('Error cargando datos: ' + e.message, 'error');
  }
}

function setupRealtimeSubscriptions() {
  clearSubscriptions();

  // Patentes: la tabla es pública (RLS "Anyone can read active plates"),
  // así que este canal sirve también para los invitados (modo usado en el
  // estacionamiento). Además de refrescar la cache, refresca los resultados
  // del buscador manual (sin tocar lo que el usuario está escribiendo).
  const platesSub = subscribeToPlates(() => {
    refreshPlatesCache()
      .then(() => {
        if (plateSearch && searchMode === 'manual') return plateSearch.refresh();
      })
      .catch((e) => console.warn('No se pudo refrescar la cache de patentes:', e));
  });
  subscriptions.push(platesSub);

  // El historial y los contactos son del usuario de Supabase: sin sesión
  // de admin no hay canal (el invitado usa el historial local del equipo).
  if (!currentUser) return;

  // Historial
  const historySub = subscribeToScanHistory(currentUser.id, (payload) => {
    if (payload.eventType === 'INSERT') {
      const h = payload.new;
      pushScanHistory({
        plate: h.plate,
        status: h.status,
        time: new Date(h.created_at).getTime()
      });
    }
  });
  subscriptions.push(historySub);

  // Contactos
  const contactsSub = subscribeToContacts(currentUser.id, () => {
    getContacts(currentUser.id).then(c => {
      contacts = c;
      renderContacts();
    });
  });
  subscriptions.push(contactsSub);
}

function clearSubscriptions() {
  subscriptions.forEach(sub => sub.unsubscribe());
  subscriptions = [];
}

async function refreshPlatesCache() {
  const [specialNeeds, admin, firstAid] = await Promise.all([
    getPlates({ type: 'special_needs', limit: 500 }),
    getPlates({ type: 'administration', limit: 500 }),
    getPlates({ type: 'first_aid', limit: 500 }),
  ]);
  platesCache = {
    special_needs: specialNeeds.map(p => p.plate),
    administration: admin.map(p => p.plate),
    first_aid: firstAid.map(p => p.plate),
  };
}

// ============================================================
// UI EVENTS
// ============================================================
function setupUIEvents() {
  // Navegación
  document.getElementById('btn-home-scan').onclick = () => navigate('camera');
  document.getElementById('btn-home-plates').onclick = () => navigate('plates');
  document.getElementById('btn-plates-back').onclick = () => navigate('home');
  document.getElementById('plate-search').oninput = (e) => renderPlatesTable(e.target.value);

  // Cámara
  document.getElementById('scan-toggle').onchange = toggleScan;

  // Vista unificada: tabs Cámara / Manual
  document.querySelectorAll('.view-tab[data-mode]').forEach(tab => {
    tab.onclick = () => switchSearchMode(tab.dataset.mode);
  });

  // Buscador manual (teclado virtual + búsqueda con debounce)
  plateSearch = new PlateSearchView({
    onSelect: (row) => selectManualPlate(row),
  });
  plateSearch.init(document);

  // Registro incidente
  document.getElementById('btn-send-whatsapp').onclick = sendWhatsAppReport;

  // Contactos
  document.getElementById('btn-add-contact').onclick = handleAddContact;
  document.getElementById('btn-save-default-contacts').onclick = handleSaveDefaultContacts;

  // Bottom nav
  document.querySelectorAll('.nav-item[data-view]').forEach(n => {
    n.onclick = () => navigate(n.dataset.view);
  });

  // Modal registro rápido
  document.getElementById('cam-result').onclick = () => {
    const txt = document.getElementById('result-plate').textContent;
    if (txt !== '---') {
      document.getElementById('reg-plate').value = txt;
      navigate('register');
    }
  };
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-send').onclick = sendRegistration;
  document.getElementById('modal-overlay').onclick = (e) => { if (e.target === e.currentTarget) closeModal(); };

  // Auth forms (se crean dinámicamente en renderAuthView)
  // Ver setupAuthForms() en navigate()
    // Botón de auth en el header
   const headerAuthBtn = document.getElementById('header-auth-btn');
  if (headerAuthBtn) {
    headerAuthBtn.addEventListener('click', () => {
      if (appMode === 'admin' || appMode === 'guest') {
        navigate('profile');
      } else {
        navigate('guest-login');
      }
    });
  }
}

function updateAuthUI(isLoggedIn) {
  const btn = document.getElementById('header-auth-btn');
  const label = document.getElementById('header-auth-label');

  if (btn && label) {
    if (isLoggedIn && appMode === 'admin') {
      const displayName = userProfile?.full_name || currentUser?.email?.split('@')[0] || 'Admin';
      label.textContent = displayName.length > 12 ? displayName.slice(0, 10) + '…' : displayName;
      btn.querySelector('svg').innerHTML = `
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" fill="none" stroke="currentColor" stroke-width="2"/>
        <circle cx="12" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"/>
      `;
    } else if (appMode === 'guest') {
      const displayName = guestSession?.name || 'Invitado';
      label.textContent = displayName.length > 12 ? displayName.slice(0, 10) + '…' : displayName;
      btn.querySelector('svg').innerHTML = `
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" fill="none" stroke="currentColor" stroke-width="2"/>
        <circle cx="12" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"/>
      `;
    } else {
      label.textContent = 'Acceso';
      btn.querySelector('svg').innerHTML = `
        <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" fill="none" stroke="currentColor" stroke-width="2"/>
        <polyline points="10 17 15 12 10 7" fill="none" stroke="currentColor" stroke-width="2"/>
        <line x1="15" y1="12" x2="3" y2="12" fill="none" stroke="currentColor" stroke-width="2"/>
      `;
    }
  }

  // Nav admin: solo visible si appMode === 'admin' Y role === 'admin'
  const navAdmin = document.getElementById('nav-admin');
  if (navAdmin) {
    const isAdmin = isLoggedIn && appMode === 'admin' && userProfile?.role === 'admin';
    navAdmin.style.display = isAdmin ? 'flex' : 'none';
  }
}

// ============================================================
// NAVEGACIÓN ENTRE VISTAS
// ============================================================
window.navigate = async function (view) {
  // Bloquear vistas protegidas si no hay sesión
  const protectedViews = ['home', 'camera', 'register', 'call', 'plates', 'profile', 'admin'];
  const needsAuth = protectedViews.includes(view);
  const hasSession = appMode === 'admin' || appMode === 'guest';

  if (needsAuth && !hasSession) {
    view = 'guest-login';
  }

  // Si va a admin y no es admin, redirigir
  if (view === 'admin' && appMode !== 'admin') {
    view = 'home';
  }

  // ... resto del código original de navigate
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const vEl = document.getElementById('view-' + view);
  if (vEl) vEl.classList.add('active');

  const nEl = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (nEl) nEl.classList.add('active');

  if (view !== 'camera') {
    // Al salir de la vista se apaga la cámara y no se retoma sola.
    resumeCameraOnSwitch = false;
    setPhysicalKeyboard(false);
    stopCamera();
  }

  switch (view) {
    case 'home':
      runDiagnostics();
      break;
    case 'plates':
      renderPlatesTable();
      break;
    case 'camera':
      updateHistory();
      // El historial es compartido entre Cámara y Manual: se recarga desde
      // Supabase sin bloquear la apertura de la vista.
      reloadScanHistory().catch(() => {});
      // initModels() es idempotente: si la carga ya está en curso (arranque
      // en segundo plano) se espera a esa misma promesa.
      await initModels().catch(() => {});
      break;
    case 'call':
      await loadEmergencyContacts();
      updateCallViewAccess();
      renderContacts();
      // Refresca los contactos propios en segundo plano: la vista ya
      // se abrió con la caché y se actualiza si cambió en la base.
      if (currentUser) {
        getContacts(currentUser.id)
          .then(c => { contacts = c; renderContacts(); })
          .catch(() => {});
      }
      break;
    case 'register':
      // Pre-fill si viene de detección
      break;
       case 'guest-login':
      await renderGuestLogin();
      break;
    case 'profile':
      if (appMode === 'admin') {
        await renderProfileView();
      } else {
        // Perfil para guest: mostrar nombre y botón de logout
        renderGuestProfile();
      }
      break;
    case 'auth':
      renderAuthView();
      break;
    case 'admin':
      if (!window._adminDashboard) {
        window._adminDashboard = new AdminDashboard();
        const ok = await window._adminDashboard.init();
        if (!ok) {
          showToast('Acceso denegado: se requiere rol admin', 'error');
          navigate('home');
        }
      }
      break;
  }
};

// ============================================================
// VISTA: PERFIL
// ============================================================
function renderGuestProfile() {
  const container = document.getElementById('view-profile');
  if (!container) return;

  container.innerHTML = `
    <div class="view-header"><h1>Mi Perfil</h1></div>
    <div class="card">
      <div class="profile-header">
        <img class="profile-avatar" src="/icon-192.svg" alt="Avatar">
        <div class="profile-info">
          <h2>${guestSession?.name || 'Invitado'}</h2>
          <p class="user-email">Sesión flotante</p>
          <span class="badge">GUEST</span>
        </div>
      </div>
      <p style="color: var(--text-muted); font-size: 13px; margin: 16px 0; text-align: center;">
        Estás usando la app como usuario flotante. Los escaneos se guardarán sin asociar a un usuario.
      </p>
      <button class="btn-danger btn-full" id="guest-logout-btn" style="margin-top:8px; background: var(--danger); color: #fff; border: none; padding: 14px; border-radius: var(--radius); font-weight: 600; cursor: pointer;">
        Cerrar sesión
      </button>
    </div>
  `;

  document.getElementById('guest-logout-btn').onclick = async () => {
    await performLogout();
  };
}
async function performLogout() {
  try {
    if (appMode === 'admin') {
      await supabase.auth.signOut();
    } else if (appMode === 'guest') {
      await guestAuth.logout();
    }
  } catch (e) {
    console.warn('[Logout] error:', e);
  }

  // Resetear estado
  currentUser = null;
  userProfile = null;
  guestSession = null;
  appMode = 'unknown';
  scanHistory = [];
  scanCount = { total: 0, registered: 0, stolen: 0, unknown: 0 };
  contacts = [];
  platesCache = { special_needs: [], administration: [], first_aid: [] };   // ← FIX
  clearSubscriptions();

  // Detener cámara
  stopCamera();

  // Limpiar UI
  updateAuthUI(false);
  document.getElementById('view-admin')?.classList.add('hidden');
  document.getElementById('view-profile')?.classList.add('hidden');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Ir a login (no a home, porque home es protegida)
  document.body.classList.add('is-guest-login');
  await navigate('guest-login');

  showToast('Sesión cerrada', 'success');
}
async function renderProfileView() {
  const container = document.getElementById('view-profile');
  if (!container) return;

  if (!currentUser) {
    navigate('auth');
    return;
  }

  container.innerHTML = `
    <div class="view-header"><h1>Mi Perfil</h1></div>
    <div class="card">
      <div class="profile-header">
       <img class="profile-avatar" src="${userProfile?.avatar_url || '/icon-192.svg'}" alt="Avatar"><div class="profile-info">
          <h2>${userProfile?.full_name || currentUser.email.split('@')[0]}</h2>
          <p class="user-email">${currentUser.email}</p>
          <span class="badge ${userProfile?.role === 'admin' ? 'badge-admin' : ''}">${userProfile?.role || 'user'}</span>
        </div>
      </div>
      <div class="profile-stats">
        <div class="stat"><span class="stat-value">${scanCount.total}</span><span class="stat-label">Escaneos</span></div>
        <div class="stat"><span class="stat-value success">${scanCount.registered}</span><span class="stat-label">Registrados</span></div>
        <div class="stat"><span class="stat-value danger">${scanCount.stolen}</span><span class="stat-label">Denunciados</span></div>
        <div class="stat"><span class="stat-value warning">${scanCount.unknown}</span><span class="stat-label">Desconocidos</span></div>
      </div>
      <div class="form-group">
        <label>Nombre completo</label>
        <input type="text" id="profile-name" value="${userProfile?.full_name || ''}" placeholder="Tu nombre">
      </div>
      <div class="form-group">
        <label>Teléfono</label>
        <input type="tel" id="profile-phone" value="${userProfile?.phone || ''}" placeholder="+54 9 11 1234 5678">
      </div>
      <button class="btn-primary btn-full" id="btn-save-profile">Guardar cambios</button>
      <button class="btn-secondary btn-full" style="margin-top:8px" id="btn-change-password">Cambiar contraseña</button>
      <button class="btn-danger btn-full" style="margin-top:8px" id="btn-signout">Cerrar sesión</button>
    </div>
  `;

  document.getElementById('btn-save-profile').onclick = async () => {
    const name = document.getElementById('profile-name').value.trim();
    const phone = document.getElementById('profile-phone').value.trim();
    try {
      await updateProfile({ full_name: name, phone });
      userProfile = { ...userProfile, full_name: name, phone };
      showToast('Perfil actualizado', 'success');
      renderProfileView();
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
  };

  document.getElementById('btn-change-password').onclick = () => {
    const newPass = prompt('Nueva contraseña (mín 6 caracteres):');
    if (newPass && newPass.length >= 6) {
      supabase.auth.updateUser({ password: newPass }).then(({ error }) => {
        if (error) showToast('Error: ' + error.message, 'error');
        else showToast('Contraseña actualizada', 'success');
      });
    }
  };

  document.getElementById('btn-signout').onclick = async () => {
    await signOut();
  };
}

// ============================================================
// VISTA: AUTH (LOGIN/REGISTER)
// ============================================================
async function renderGuestLogin() {
  console.log('[GuestLogin] renderGuestLogin() INICIADO');

  const form = document.getElementById('guest-login-form');
  const input = document.getElementById('guest-name');
  const error = document.getElementById('guest-login-error');
  const btn = document.getElementById('guest-login-btn');
  const adminToggle = document.getElementById('guest-admin-toggle');
  const adminForm = document.getElementById('guest-admin-form');
  const adminBtn = document.getElementById('guest-admin-btn');
  const adminBack = document.getElementById('guest-admin-back');
  const adminError = document.getElementById('guest-admin-error');   // ← FALTABA

  if (!form) {
    console.error('[GuestLogin] No existe #guest-login-form');
    return;
  }

  // Asegurar que el body tenga la clase
  document.body.classList.add('is-guest-login');

  // Reset
  if (input) { input.value = ''; input.focus(); }
  if (error) error.classList.add('hidden');
  if (adminForm) adminForm.classList.add('hidden');
  if (adminError) adminError.classList.add('hidden');
  form.style.display = 'block';

  // ============================================================
  // 1. SUBMIT DEL FORM (login guest)
  // ============================================================
  form.onsubmit = async (e) => {
    e.preventDefault();
    console.log('[GuestLogin] Submit');
    const name = input?.value.trim();
    if (!name) {
      if (error) { error.textContent = 'Ingresa un nombre'; error.classList.remove('hidden'); }
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Validando...';
    if (error) error.classList.add('hidden');

    const result = await guestAuth.login(name);

    btn.disabled = false;
    btn.textContent = 'Ingresar';

    if (!result.ok) {
      if (error) { error.textContent = result.error; error.classList.remove('hidden'); }
      return;
    }

    guestSession = result.session;
    appMode = 'guest';
    // Sin usuario de Supabase no hay Realtime ni historial en la nube:
    // el historial guardado en el dispositivo es la fuente.
    loadLocalHistory();
    // Cache local de patentes (lectura pública con anon key).
    refreshPlatesCache().catch(() => {});
    // Realtime de las patentes (tabla pública).
    setupRealtimeSubscriptions();
    document.body.classList.remove('is-guest-login');
    updateAuthUI(false);
    await navigate('home');
  };
  console.log('[GuestLogin] ✅ form.onsubmit enganchado');

  // ============================================================
  // 2. TOGGLE ADMIN
  // ============================================================
  if (adminToggle) {
    adminToggle.onclick = () => {
      console.log('[GuestLogin] Toggle admin');
      if (adminForm) adminForm.classList.remove('hidden');
      form.style.display = 'none';
      document.getElementById('guest-admin-email')?.focus();
    };
  }

  if (adminBack) {
    adminBack.onclick = () => {
      if (adminForm) adminForm.classList.add('hidden');
      form.style.display = 'block';
      input?.focus();
    };
  }

  // ============================================================
  // 3. LOGIN ADMIN
  // ============================================================
  if (adminBtn) {
    adminBtn.onclick = async () => {
      const email = document.getElementById('guest-admin-email')?.value.trim();
      const password = document.getElementById('guest-admin-password')?.value;
      if (!email || !password) {
        if (adminError) { adminError.textContent = 'Completa email y contraseña'; adminError.classList.remove('hidden'); }
        return;
      }

      adminBtn.disabled = true;
      adminBtn.textContent = 'Entrando...';
      if (adminError) adminError.classList.add('hidden');

      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });

      adminBtn.disabled = false;
      adminBtn.textContent = 'Entrar como Admin';

      if (authError) {
        if (adminError) { adminError.textContent = authError.message; adminError.classList.remove('hidden'); }
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();
      const { data: profile } = await supabase.from('users').select('role').eq('id', user.id).maybeSingle();

      if (profile?.role !== 'admin') {
        await supabase.auth.signOut();
        if (adminError) { adminError.textContent = 'Tu cuenta no tiene permisos de admin'; adminError.classList.remove('hidden'); }
        return;
      }

      currentUser = user;
      userProfile = profile;
      appMode = 'admin';
      document.body.classList.remove('is-guest-login');
      await loadUserData();
      updateAuthUI(true);
      await navigate('home');
    };
  }

  console.log('[GuestLogin] renderGuestLogin() COMPLETADO');
}
function renderAuthView() {
  const container = document.getElementById('view-auth');
  if (!container) return;

  container.innerHTML = `
    <div class="view-header"><h1>Acceso</h1></div>
    <div class="card" id="auth-form-container">
      ${renderLoginForm()}
    </div>
    <div class="auth-divider">o</div>
    <div class="card">
      <button class="btn-secondary btn-full" onclick="window.authWithGoogle()">Continuar con Google</button>
      <button class="btn-secondary btn-full" style="margin-top:8px" onclick="window.authWithApple()">Continuar con Apple</button>
    </div>
  `;
}

function renderLoginForm() {
  return `
    <h3>Iniciar sesión</h3>
    <div class="form-group">
      <label>Email</label>
      <input type="email" id="auth-email" placeholder="tu@email.com" autocomplete="email">
    </div>
    <div class="form-group">
      <label>Contraseña</label>
      <input type="password" id="auth-password" placeholder="••••••••" autocomplete="current-password">
    </div>
    <button class="btn-primary btn-full" onclick="window.handleLogin()">Entrar</button>
    <button class="btn-secondary btn-full" style="margin-top:8px" onclick="window.showRegister()">Crear cuenta</button>
    <p style="text-align:center;margin-top:12px;font-size:12px;color:var(--text-muted)">Al continuar aceptas nuestros términos</p>
  `;
}

function renderRegisterForm() {
  return `
    <h3>Crear cuenta</h3>
    <div class="form-group">
      <label>Nombre completo</label>
      <input type="text" id="reg-name" placeholder="Juan Pérez" autocomplete="name">
    </div>
    <div class="form-group">
      <label>Email</label>
      <input type="email" id="reg-email" placeholder="tu@email.com" autocomplete="email">
    </div>
    <div class="form-group">
      <label>Contraseña</label>
      <input type="password" id="reg-password" placeholder="Mínimo 6 caracteres" autocomplete="new-password" minlength="6">
    </div>
    <div class="form-group">
      <label>Confirmar contraseña</label>
      <input type="password" id="reg-confirm" placeholder="Repite la contraseña" autocomplete="new-password">
    </div>
    <button class="btn-primary btn-full" onclick="window.handleRegister()">Registrarse</button>
    <button class="btn-secondary btn-full" style="margin-top:8px" onclick="window.showLogin()">Ya tengo cuenta</button>
  `;
}

window.showLogin = () => {
  document.getElementById('auth-form-container').innerHTML = renderLoginForm();
};

window.showRegister = () => {
  document.getElementById('auth-form-container').innerHTML = renderRegisterForm();
};

window.handleLogin = async () => {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) { showToast('Complete todos los campos', 'error'); return; }

  const btn = document.querySelector('#auth-form-container .btn-primary');
  btn.disabled = true; btn.textContent = 'Entrando...';

  const { error } = await signIn(email, password);
  btn.disabled = false; btn.textContent = 'Entrar';

  if (error) showToast('Error: ' + error.message, 'error');
  else { showToast('Bienvenido', 'success'); navigate('home'); }
};

window.handleRegister = async () => {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirm = document.getElementById('reg-confirm').value;

  if (!name || !email || !password) { showToast('Complete todos los campos', 'error'); return; }
  if (password !== confirm) { showToast('Las contraseñas no coinciden', 'error'); return; }
  if (password.length < 6) { showToast('Mínimo 6 caracteres', 'error'); return; }

  const btn = document.querySelector('#auth-form-container .btn-primary');
  btn.disabled = true; btn.textContent = 'Creando...';

  const { error } = await signUp(email, password, name);
  btn.disabled = false; btn.textContent = 'Registrarse';

  if (error) showToast('Error: ' + error.message, 'error');
  else { showToast('Cuenta creada. Verifica tu email.', 'success'); }
};

window.authWithGoogle = () => signInWithOAuth('google');
window.authWithApple = () => signInWithOAuth('apple');

// ============================================================
// CARGA DE MODELOS (perezosa)
// ============================================================
// Los modelos ONNX pesan ~16 MB y la sesión de ORT + el warmup bloquean el
// main thread (tareas de más de 1 s). Cargarlos al arrancar hacía que la
// primera pintura tardara, así que ahora:
//   - se cargan al entrar a la vista Cámara (await), y/o
//   - en segundo plano cuando el navegador está libre (requestIdleCallback),
//     para que estén listos cuando el usuario abra la cámara.
let modelsPromise = null;

// Si la carga se cuelga (WASM esperando a un worker que no arranca, red
// lenta, etc.) no podemos quedar para siempre en "Cargando detector...":
// se corta y se avisa.
const MODEL_LOAD_TIMEOUT_MS = 60000;

const yieldToPaint = () => new Promise(r => setTimeout(r, 0));

const withTimeout = (promise, ms, message) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
]);

const scheduleIdle = (fn) => {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(fn, { timeout: 4000 });
  } else {
    setTimeout(fn, 1500);
  }
};

function initModels() {
  if (!modelsPromise) {
    modelsPromise = loadModels().catch((e) => {
      console.warn('[Models] error al cargar:', e);
      modelsPromise = null;   // permite reintentar
      throw e;
    });
  }
  return modelsPromise;
}

async function loadModels() {
  setStatus('Cargando modelos...');
  const hud = document.getElementById('hud-gpu');
  if (hud) hud.textContent = isMobile ? 'MÓVIL' : 'DESK';

  corrector = new Corrector();
  detector = new PlateDetector({ inputSize: 640, confThreshold: 0.15 });
  if (isMobile) detector._yoloSkip = 3;
  ocr = new PlateOCR();
  if (isMobile) ocrSkipInterval = 2;

  // La descarga del detector va en paralelo con la del OCR (lo que más
  // tarda es la red).
  const detPromise = fetch('models/yolov8_plate.onnx').then(r => r.arrayBuffer());
  const ocrPromise = ocr.loadModel('models/ppocr_rec.onnx', 'models/ppocr_keys.json');

  setStatus('Cargando detector YOLOv8...');

  let detLoaded = false;
  let ocrLoaded = false;
  try {
    const detBuf = await detPromise;
    detLoaded = await withTimeout(
      detector.loadModel(detBuf),
      MODEL_LOAD_TIMEOUT_MS,
      'El detector tardó demasiado en cargar'
    );
    ocrLoaded = await withTimeout(
      ocrPromise,
      MODEL_LOAD_TIMEOUT_MS,
      'El OCR tardó demasiado en cargar'
    );
  } catch (e) {
    console.warn('[Models] error al cargar:', e);
    setStatus('No se pudieron cargar los modelos');
    showToast('No se pudieron cargar los modelos. Recargá la página.', 'error');
    // Se propaga para que initModels() libere modelsPromise y permita
    // reintentar la carga más tarde.
    throw e;
  }

  await yieldToPaint();

  // El warmup compila el grafo para el tamaño real: es la parte más
  // pesada (una inferencia de 640x640). Se hace después de pintar el
  // estado para que el usuario no vea la pantalla congelada.
  setStatus('Calentando modelos...');
  await yieldToPaint();
  try {
    await Promise.race([
      (async () => {
        await detector.warmup();   // ← secuencial, no paralelo
        await ocr.warmup();
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))
    ]);
  } catch (e) { console.warn('warmup skip:', e.message); }

  runDiagnostics();
  if (detLoaded && ocrLoaded) setStatus('Listo. Presiona Iniciar');
  else setStatus('Modo demo - faltan modelos');
}

async function startCamera() {
  try {
    camera = new Camera(document.getElementById('video'));
    const resolution = isMobile ? '640x480' : '1280x720';
    await camera.start(resolution, 30);
    return true;
  } catch (e) {
    showToast('Error cámara: ' + e.message, 'error');
    return false;
  }
}

function setStatus(msg) { const el = document.getElementById('cam-status'); if (el) el.textContent = msg; }

function stopCamera() {
  running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (camera) { camera.stop(); camera = null; }
  lastPlate = null; lastPlateBox = null; noDetectFrames = 0;
  streakCandidate = null; streakCount = 0; ocrCounter = 0; lastBoxCenter = null;
  if (detector) detector._smoothBox = null;
  document.getElementById('scan-toggle').checked = false;
  document.getElementById('switch-label').textContent = 'Iniciar detección';
  document.getElementById('cam-status').classList.remove('scanning');
  document.getElementById('cam-container').classList.remove('scanning');
  clearCanvasOverlay();
  setStatus('En espera');
}

window.toggleScan = async function () {
  if (running) { stopCamera(); setStatus('Detenido'); return; }
  if (!camera && !(await startCamera())) { document.getElementById('scan-toggle').checked = false; return; }
  running = true;
  document.getElementById('switch-label').textContent = 'Apagar cámara';
  document.getElementById('cam-status').classList.add('scanning');
  document.getElementById('cam-container').classList.add('scanning');
  setStatus('Escaneando...');
  lastPlate = null; noDetectFrames = 0;
  if (detector) detector._smoothBox = null;
  requestAnimationFrame(loop);
};

function resizeCanvas() {
  const video = document.getElementById('video');
  const canvas = document.getElementById('overlay-canvas');
  if (!video || !video.videoWidth || !canvas) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
}

async function loop() {
  if (!running) return;
  const video = document.getElementById('video');
  if (!video || !video.videoWidth) { rafId = requestAnimationFrame(loop); return; }
  updateFPS();
  resizeCanvas();

  let boxes = [];
  if (detector && !detector.mock) {
    try { boxes = await detector.detect(video); } catch (e) { console.warn('detect error:', e); }
  }

  if (boxes.length > 0) {
    noDetectFrames = 0;
    const box = boxes[0];

    if (lastPlate || streakCandidate) {
      lastPlateBox = { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 };
    }

    const center = { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
    const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
    const isStable = lastBoxCenter &&
      Math.abs(center.x - lastBoxCenter.x) < bw * 0.15 &&
      Math.abs(center.y - lastBoxCenter.y) < bh * 0.15;
    lastBoxCenter = center;

    ocrCounter++;
    const skipOCR = isStable && (ocrCounter % ocrSkipInterval !== 0);

    if (!skipOCR && ocr && !ocr.mock) {
      const crop = detector.cropPlate(video, box);
      if (crop) {
        let rawText = '';
        try { rawText = await ocr.recognize(crop); } catch (e) { console.warn('OCR error:', e); }
        lastRawText = rawText || '(vacío)';

        if (rawText) {
          const normalized = normalizePlate(rawText);
          const corrected = corrector.correct(normalized);
          lastCorrected = corrected || '(vacío)';
          lastOCRValid = validatePlate(corrected) && corrected.length === 6;

          if (lastOCRValid) {
            if (corrected === streakCandidate) streakCount++;
            else { streakCandidate = corrected; streakCount = 1; }

            if (streakCount >= streakRequired && streakCandidate !== lastPlate) {
              lastPlate = streakCandidate;
              lastPlateBox = { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 };
              // Sin await: la consulta a Supabase va en segundo plano para
              // no frenar el loop de cámara.
              processPlate(lastPlate);
              streakCount = 0;
            }
          } else {
            streakCandidate = null; streakCount = 0;
          }
        } else {
          lastCorrected = '(vacío)'; lastOCRValid = false;
          streakCandidate = null; streakCount = 0;
        }
      }
    }
  } else {
    noDetectFrames++;
    streakCandidate = null; streakCount = 0;
    if (noDetectFrames > noDetectLimit && lastPlate) {
      lastPlate = null; lastPlateBox = null;
    }
  }

  drawCanvasOverlay(boxes);
  rafId = requestAnimationFrame(loop);
}

// ============================================================
// VISTA UNIFICADA: TABS CÁMARA / MANUAL
// ============================================================
// El sector central alterna entre la cámara y el buscador manual.
// El cartel de resultado y el historial están FUERA de los paneles: se
// comparten entre los dos modos (una patente buscada a mano aparece en el
// mismo historial que una detectada por cámara).

function switchSearchMode(mode) {
  const next = mode === 'manual' ? 'manual' : 'camera';
  if (next === searchMode) return;
  searchMode = next;

  const isManual = next === 'manual';

  document.querySelectorAll('.view-tab[data-mode]').forEach(t => {
    const on = t.dataset.mode === next;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  document.getElementById('panel-camera')?.classList.toggle('hidden', isManual);
  document.getElementById('panel-manual')?.classList.toggle('hidden', !isManual);

  // El badge de estado es del modo cámara.
  document.getElementById('cam-status')?.classList.toggle('hidden', isManual);

  if (isManual) {
    // La cámara no se ve: se apaga para no gastar batería ni CPU.
    // Si estaba escaneando, se recuerda para retomarlo al volver.
    resumeCameraOnSwitch = running;
    if (running) stopCamera();
    // El buscador refresca los resultados de la consulta actual (si hay).
    plateSearch?.refresh().catch?.(() => {});
    // En la PC se puede escribir con el teclado físico (comodo para probar).
    setPhysicalKeyboard(true);
  } else {
    setPhysicalKeyboard(false);
    updateHistory();
    // Si estaba escaneando, se retoma.
    if (resumeCameraOnSwitch) {
      resumeCameraOnSwitch = false;
      window.toggleScan().catch(() => {});
    }
  }
}

/**
 * Teclado físico (solo PC): en modo Manual las teclas se escriben en el
 * buscador. En el celular manda el teclado virtual de la vista.
 * El listener se pone y se saca con el modo para no capturar teclas en
 * otras vistas.
 */
function setPhysicalKeyboard(enabled) {
  if (enabled) {
    if (!physicalKeyboardOn) {
      document.addEventListener('keydown', onPhysicalKeydown);
      physicalKeyboardOn = true;
    }
  } else if (physicalKeyboardOn) {
    document.removeEventListener('keydown', onPhysicalKeydown);
    physicalKeyboardOn = false;
  }
}

function onPhysicalKeydown(e) {
  if (searchMode !== 'manual' || !plateSearch) return;
  // Si el usuario está escribiendo en otro campo, no se intercepta nada.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
    || t.tagName === 'SELECT' || t.isContentEditable)) return;

  if (e.key === 'Backspace') { plateSearch.press('BACKSPACE'); e.preventDefault(); }
  else if (e.key === 'Enter') { plateSearch.flush(); e.preventDefault(); }
  else if (e.key.length === 1) { plateSearch.press(e.key); e.preventDefault(); }
}

/**
 * Patente elegida en el buscador manual: mismo camino que la cámara.
 * processPlate() muestra el resultado, resuelve el tipo y guarda el
 * escaneo, así que el historial es el mismo en los dos modos.
 */
function selectManualPlate(row) {
  const plate = (row?.plate || '').toUpperCase().trim();
  if (!plate) return;
  // La búsqueda manual no viene del OCR: se limpian los datos del último
  // frame para no guardar en la base los datos de otra patente.
  lastRawText = '';
  lastCorrected = '';
  lastPlateBox = null;
  processPlate(plate);
  // El cartel de resultado (compartido) queda debajo del teclado: se trae
  // a la vista para que el usuario vea el veredicto sin scrollear a mano.
  document.getElementById('cam-result')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ============================================================
// RESPALDO DE REALTIME (polling cada 5 minutos)
// ============================================================
// Realtime es lo ideal (los cambios llegan en segundos), pero si el canal
// no está disponible (o el usuario es invitado y no hay user_id), este
// polling mantiene al día el historial y los resultados del buscador.

const REFRESH_POLL_MS = 5 * 60 * 1000;
const REFRESH_POLL_MS_FLOTANTE = 2 * 60 * 1000;

function startRefreshPolling() {
  if (refreshPollTimer) return;
  // El admin recibe los cambios por Realtime; el flotante no (las
  // patents ya no son públicas para anónimos), así que refresca más
  // seguido para que la cache no quede vieja.
  const intervalo = appMode === 'guest' ? REFRESH_POLL_MS_FLOTANTE : REFRESH_POLL_MS;
  refreshPollTimer = setInterval(() => { refreshData(); }, intervalo);
}

/** RePrograma el refresco según el modo actual (admin / flotante). */
function restartRefreshPolling() {
  if (refreshPollTimer) clearInterval(refreshPollTimer);
  refreshPollTimer = null;
  startRefreshPolling();
}

async function refreshData() {
  // No gastar datos si la app está en segundo plano.
  if (document.hidden) return;
  try {
    await refreshPlatesCache();
    // El buscador se refresca sin tocar lo que el usuario está escribiendo.
    if (plateSearch && searchMode === 'manual') await plateSearch.refresh();
    await reloadScanHistory();
  } catch (e) {
    console.warn('Refresh periódico falló:', e);
  }
}

async function reloadScanHistory() {
  if (!currentUser) return;
  const history = await getScanHistory({ userId: currentUser.id, limit: 20 });
  scanHistory = history.map(h => ({
    plate: h.plate,
    status: h.status,
    time: new Date(h.created_at).getTime(),
  }));
  updateHistory();
}

// ============================================================
// PROCESAR PATENTE DETECTADA (usa Supabase)
// ============================================================
// La consulta a Supabase NO se espera dentro del loop de cámara: se
// responde al instante con la cache local de patentes y la consulta +
// guardado van en segundo plano. Antes el `await` dentro del
// requestAnimationFrame congelaba el loop (2 round-trips por patente).
const pendingPlates = new Set();

/** Tipo de patente según la cache local (0 round-trips). */
function localPlateType(plate) {
  if (platesCache.first_aid?.includes(plate)) return 'first_aid';
  if (platesCache.administration?.includes(plate)) return 'administration';
  if (platesCache.special_needs?.includes(plate)) return 'special_needs';
  return null;
}

function processPlate(plate) {
  setStatus('Patente: ' + plate);

  // Respuesta inmediata con la cache local
  const localType = localPlateType(plate);
  renderPlateResult(plate, localType);

  // Si ya hay una consulta en curso para la misma patente, no se duplica
  if (pendingPlates.has(plate)) return;
  pendingPlates.add(plate);
  syncPlate(plate, localType)
    .catch((e) => console.warn('Error sincronizando patente:', e))
    .finally(() => pendingPlates.delete(plate));
}

/** Consulta al servidor + guardado del escaneo (en segundo plano). */
async function syncPlate(plate, localType) {
  let plateData = null;
  try {
    plateData = await lookupPlate(plate);
  } catch (e) {
    console.warn('Supabase lookup failed, usando cache:', e);
  }

  const serverType = plateData?.type || null;
  const type = serverType || localType || 'unknown';

  // Si el servidor difiere de la cache local, se corrige el cartel
  if (serverType && serverType !== localType) {
    renderPlateResult(plate, serverType);
  }

  countScan(type);

  // Guardar en Supabase
  try {
    await saveScan({
      plate,
      status: type,
      confidence: 0.9,
      raw_ocr_text: lastRawText,
      corrected_text: lastCorrected,
      detection_box: lastPlateBox
    });
    // El historial es el mismo para los dos modos: la patente detectada por
    // cámara o elegida a mano entra acá y se ve al instante en la lista.
    pushScanHistory({ plate, status: type, time: Date.now() });
  } catch (e) {
    console.warn('Error guardando scan:', e);
    // Sin conexión: se guarda solo en el dispositivo (el historial local
    // guarda el TIPO de la patente, no la clase CSS).
    pushScanHistory({ plate, status: type, time: Date.now() });
  }
}

/**
 * Estados posibles de un escaneo (columna `scan_history.status`).
 *
 * El valor guardado es el TIPO de la patente (special_needs /
 * administration / first_aid) o 'unknown' / 'error'. Ver getScanStatus()
 * en plate-types.js (fuente única de verdad, la usa también el admin).
 */
function countScan(type) {
  scanCount.total = (scanCount.total || 0) + 1;
  if (type === 'first_aid') scanCount.stolen = (scanCount.stolen || 0) + 1;
  else if (type === 'administration' || type === 'special_needs') scanCount.registered = (scanCount.registered || 0) + 1;
  else scanCount.unknown = (scanCount.unknown || 0) + 1;
}

/** Texto, clase CSS e ícono para un tipo de patente. */
function plateStatusInfo(type) {
  if (type === 'first_aid') {
    return { st: '🚑 PRIMEROS AUXILIOS', css: 'danger', ico: '🚑' };
  } else if (type === 'administration') {
    return { st: '🏢 ADMINISTRACIÓN', css: 'success', ico: '🏢' };
  } else if (type === 'special_needs') {
    // Registrada: se muestra en verde (como el resto de las registradas).
    // El tipo se distingue por el ícono ♿ y por el texto.
    return { st: '♿ NECESIDADES ESPECIALES', css: 'success', ico: '♿' };
  } else {
    return { st: '⚠ NO REGISTRADO', css: 'warning', ico: '🔴' };
  }
}

/** Pinta el resultado de la patente detectada. */
function renderPlateResult(plate, type) {
  const result = document.getElementById('cam-result');
  result.classList.remove('hidden', 'success', 'danger', 'warning');
  document.getElementById('result-plate').textContent = plate;

  const { st, css, ico } = plateStatusInfo(type);

  result.className = 'camera-result ' + css;
  document.getElementById('result-icon').textContent = ico;
  document.getElementById('result-status').textContent = st;

  const inner = result.querySelector('.result-card-inner');
  if (inner) { inner.classList.remove('flash'); void inner.offsetWidth; inner.classList.add('flash'); }

  updateHistory();
  if (navigator.vibrate) navigator.vibrate(100);
  document.getElementById('reg-plate').value = plate;
}

// ============================================================
// HISTORIAL Y CONTACTOS (renderizado igual, datos de Supabase)
// ============================================================

/**
 * Agrega una entrada al historial compartido (Cámara / Manual) sin
 * duplicarla.
 *
 * La misma patente puede llegar dos veces: una por el guardado local
 * (detección por cámara o búsqueda manual) y otra por la suscripción
 * Realtime de `scan_history`. Si es la misma patente en menos de 10 s, se
 * actualiza la entrada existente en lugar de duplicarla.
 */
function pushScanHistory(entry) {
  const last = scanHistory[0];
  if (last
      && last.plate === entry.plate
      && Math.abs((entry.time || 0) - (last.time || 0)) < 10000) {
    last.status = entry.status;
    updateHistory();
    return;
  }
  scanHistory.unshift(entry);
  if (scanHistory.length > 20) scanHistory.pop();
  persistLocalHistory();
  updateHistory();
}

/** Guarda historial y stats en el dispositivo (respaldo sin conexión). */
function persistLocalHistory() {
  try {
    localStorage.setItem('plateHistory', JSON.stringify(scanHistory));
    localStorage.setItem('plateStats', JSON.stringify(scanCount));
  } catch (e) { /* almacenamiento lleno o bloqueado: no es crítico */ }
}

/**
 * Recupera el historial guardado en el dispositivo.
 * Se usa al entrar como invitado: sin usuario de Supabase no hay
 * suscripción Realtime, así que el historial vive en el equipo.
 */
function loadLocalHistory() {
  try {
    const raw = localStorage.getItem('plateHistory');
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) {
      scanHistory = arr.slice(0, 20);
      updateHistory();
    }
  } catch (e) { /* historial local corrupto: se ignora */ }
}

function updateHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  if (!scanHistory.length) { list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">Sin detecciones recientes</div>'; return; }
  list.innerHTML = scanHistory.slice(0, 10).map(h => {
    // `status` es el tipo de la patente (special_needs / administration /
    // first_aid / unknown), no la clase CSS: antes se comparaba con
    // 'success'/'danger' y toda patente registrada salía como
    // "Desconocido".
    const st = getScanStatus(h.status);
    const isReg = platesCache.administration?.includes(h.plate) || platesCache.special_needs?.includes(h.plate) || platesCache.first_aid?.includes(h.plate);
    const clickHandler = isReg ? '' : ` onclick="requestRegistration('${h.plate}')"`;
    const cls = isReg ? '' : ' clickable';
    return `<div class="history-item${cls}"${clickHandler}><span class="h-plate">${h.plate}</span><span class="h-status ${st.cls}">${st.label}</span></div>`;
  }).join('');
}

function escContact(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Lista final visible en Llamadas:
 * los 5 por defecto (globales) + contactos propios que no sean
 * los antiguos defaults que creaba el trigger al registrarse.
 */
function getAllContacts() {
  return mergeContactLists(emergencyContacts, contacts);
}

/** Carga (o recarga) los 5 números globales desde app_settings. */
async function loadEmergencyContacts() {
  try {
    const remote = await getEmergencyContacts();
    if (remote) emergencyContacts = remote;
  } catch (e) {
    console.warn('No se pudieron cargar los números por defecto:', e);
  }
}

/**
 * Solo el admin ve los formularios de la vista Llamadas:
 * "Números por defecto" (globales) y "Agregar contacto".
 */
function updateCallViewAccess() {
  const isAdmin = userProfile?.role === 'admin';
  document.getElementById('card-default-contacts')?.classList.toggle('hidden', !isAdmin);
  document.getElementById('card-add-contact')?.classList.toggle('hidden', !isAdmin);
  if (isAdmin) renderDefaultContactInputs();
}

/** Rellena los inputs de edición de los 5 números (solo admin). */
function renderDefaultContactInputs() {
  const box = document.getElementById('default-contacts-list');
  if (!box) return;
  box.innerHTML = emergencyContacts.map((c, i) => `
    <div class="form-group">
      <label>${escContact(c.name)}</label>
      <input type="tel" id="default-contact-phone-${i}" value="${escContact(c.phone)}"
             placeholder="Sin número" inputmode="tel" autocomplete="off">
    </div>
  `).join('');
}

function renderContacts() {
  const grid = document.getElementById('contact-grid');
  if (!grid) return;

  const list = getAllContacts();
  grid.innerHTML = list.map(c => {
    const phone = String(c.phone || '').trim();
    const svg = '<svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
    const callBtn = phone
      ? `<button class="call-btn" onclick='callContact(${escContact(JSON.stringify(phone))})'>${svg}</button>`
      : `<button class="call-btn" disabled title="Sin número">${svg}</button>`;
    return `
    <div class="contact-card">
      <div class="avatar ${escContact(c.type || 'custom')}">${escContact(c.icon || '📞')}</div>
      <div class="info"><div class="name">${escContact(c.name)}</div><div class="phone">${escContact(phone) || 'Sin número'}</div></div>
      ${callBtn}
    </div>
  `;
  }).join('');
}

window.callContact = (p) => { window.location.href = 'tel:' + p; };

async function handleAddContact() {
  const name = document.getElementById('new-contact-name').value.trim();
  const phone = document.getElementById('new-contact-phone').value.trim();
  const type = document.getElementById('new-contact-type')?.value || 'custom';
  if (!name || !phone) { showToast('Ingrese nombre y teléfono', 'error'); return; }

  try {
    await addContact({ name, phone, type, icon: getIconForType(type) });
    showToast('Contacto agregado', 'success');
    document.getElementById('new-contact-name').value = '';
    document.getElementById('new-contact-phone').value = '';
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

function getIconForType(type) {
  const icons = { police: '🚨', fire: '🔥', emergency: '🚑', office: '🏢', custom: '📞' };
  return icons[type] || '📞';
}

/**
 * Guarda los 5 números por defecto en app_settings (globales):
 * el cambio se ve de inmediato para todos los usuarios.
 */
async function handleSaveDefaultContacts() {
  const list = emergencyContacts.map((c, i) => ({
    ...c,
    phone: (document.getElementById(`default-contact-phone-${i}`)?.value ?? '').trim(),
  }));

  try {
    await saveEmergencyContacts(list);
    emergencyContacts = list;
    renderContacts();
    showToast('Números por defecto actualizados', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ============================================================
// REPORTE WHATSAPP
// ============================================================
function sendWhatsAppReport() {
  const p = document.getElementById('reg-plate').value.trim().toUpperCase();
  const v = document.getElementById('reg-vehicle').value;
  const i = document.getElementById('reg-incident').value;
  const l = document.getElementById('reg-location').value.trim();
  const d = document.getElementById('reg-desc').value.trim();
  if (!p || !v || !i) { showToast('Complete patente, vehículo e incidente', 'error'); return; }

  const msg = ['🚨 *REPORTE DE INCIDENTE*', '', '*Patente:* ' + p, '*Vehículo:* ' + v, '*Incidente:* ' + i, l ? '*Ubicación:* ' + l : '', d ? '*Descripción:* ' + d : '', '', 'Enviado desde PlateDetect'].filter(Boolean).join('\n');
  const officePhone = getAllContacts().find(c => c.type === 'office' && c.phone)?.phone || '';
  window.open('https://wa.me/' + (officePhone ? officePhone : '') + '?text=' + encodeURIComponent(msg), '_blank');
}

// ============================================================
// REGISTRO RÁPIDO (MODAL)
// ============================================================
window.requestRegistration = function (plate) {
  document.getElementById('modal-plate').value = plate;
  document.getElementById('modal-name').value = '';
  document.getElementById('modal-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('modal-name').focus(), 100);
};

window.closeModal = function () {
  document.getElementById('modal-overlay').classList.add('hidden');
};

window.sendRegistration = async function () {
  const plate = document.getElementById('modal-plate').value.trim().toUpperCase();
  const name = document.getElementById('modal-name').value.trim();
  if (!name) { showToast('Ingrese el nombre del conductor', 'error'); return; }

  try {
    await reportPlate({
      plate,
      type: 'special_needs',   // ← default
      owner_name: name,
      vehicle_type: 'otro'
    });
    showToast('Solicitud enviada para revisión', 'success');
    closeModal();
    await refreshPlatesCache();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
};

// ============================================================
// TABLA DE PATENTES
// ============================================================
function renderPlatesTable(filter) {
  const table = document.getElementById('plates-table');
  if (!table) return;

  const typeLabels = TYPE_LABELS;

  const all = [];
  for (const [type, plates] of Object.entries(platesCache)) {
    if (Array.isArray(plates)) {
      plates.forEach(p => all.push({ plate: p, type }));
    }
  }

  const q = (filter || '').toUpperCase().trim();
  const rows = q ? all.filter(r => r.plate.includes(q)) : all;

  if (!rows.length) {
    table.innerHTML = '<div class="plates-empty">Sin resultados</div>';
    return;
  }

  table.innerHTML = rows.map(r => {
    const t = typeLabels[r.type] || { label: r.type, cls: 'unk' };
    return `<div class="plate-row"><span class="plate-row-plate">${r.plate}</span><span class="plate-row-badge ${t.cls}">${t.label}</span></div>`;
  }).join('');
}

// ============================================================
// DIAGNÓSTICOS (adaptado de app.js original)
// ============================================================
async function runDiagnostics() {
  const list = document.getElementById('check-list');
  const summary = document.getElementById('check-summary');
  if (!list) return;

  const items = { device: [], browser: [], models: [] };
  let errors = 0;
  let warnings = 0;

  // ---- Dispositivo ----
  const mem = navigator.deviceMemory;
  if (mem !== undefined) {
    if (mem < 2) { items.device.push({ icon: 'err', label: 'Memoria insuficiente', detail: mem + ' GB. Se recomienda mínimo 2 GB.', fix: 'Cierra otras apps.' }); errors++; }
    else if (mem < 4) { items.device.push({ icon: 'warn', label: 'Memoria limitada', detail: mem + ' GB. Podría ser lento.' }); warnings++; }
    else { items.device.push({ icon: 'ok', label: 'Memoria ' + mem + ' GB' }); }
  }
  const cpu = navigator.hardwareConcurrency;
  if (cpu) {
    if (cpu < 4) { items.device.push({ icon: 'warn', label: 'Procesador ' + cpu + ' núcleos', detail: 'Detección más lenta.' }); warnings++; }
    else { items.device.push({ icon: 'ok', label: 'Procesador ' + cpu + ' núcleos' }); }
  }
  items.device.push({ icon: 'ok', label: 'Modo ' + (isMobile ? 'MÓVIL' : 'ESCRITORIO') });

// ---- Navegador ----
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    items.browser.push({ icon: 'err', label: 'Cámara no soportada', fix: 'Usa Chrome o Safari reciente.' }); errors++;
  } else if (navigator.permissions && navigator.permissions.query) {
    try {
      const perm = await navigator.permissions.query({ name: 'camera' });
      if (perm.state === 'granted') {
        items.browser.push({ icon: 'ok', label: 'Cámara con permiso' });
      } else if (perm.state === 'denied') {
        items.browser.push({ icon: 'err', label: 'Permiso de cámara denegado', detail: 'Bloqueaste el acceso a la cámara.', fix: 'Ve a ajustes del navegador y permite el acceso a la cámara, luego recarga.' }); errors++;
      } else {
        items.browser.push({ icon: 'warn', label: 'Permiso de cámara pendiente', detail: 'Se pedirá al iniciar el escaneo.' });
      }
      perm.onchange = () => runDiagnostics();
    } catch (e) {
      items.browser.push({ icon: 'warn', label: 'Permiso de cámara desconocido', detail: 'Se pedirá al iniciar el escaneo.' });
    }
  } else {
    items.browser.push({ icon: 'warn', label: 'Permiso de cámara no verificable', detail: 'Se pedirá al iniciar el escaneo.' });
  }
  let webglOk = false;
  try { webglOk = !!document.createElement('canvas').getContext('webgl'); } catch (e) {}
  if (webglOk) { items.browser.push({ icon: 'ok', label: 'Aceleración gráfica (WebGL)' }); }
  else { items.browser.push({ icon: 'warn', label: 'Sin aceleración gráfica', detail: 'Usará CPU, más lento.' }); warnings++; }
  const wasmOk = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
  if (wasmOk) { items.browser.push({ icon: 'ok', label: 'WebAssembly' }); }
  else { items.browser.push({ icon: 'err', label: 'WebAssembly no soportado', fix: 'Actualiza tu navegador.' }); errors++; }
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    items.browser.push({ icon: 'err', label: 'Conexión no segura', detail: 'La cámara requiere HTTPS.', fix: 'Usa HTTPS.' }); errors++;
  }

  // ---- Modelos IA ----
  if (detector && !detector.mock) { items.models.push({ icon: 'ok', label: 'Detector YOLOv8 activo' }); }
  else { items.models.push({ icon: 'warn', label: 'Detector cargando...' }); warnings++; }
  if (ocr && !ocr.mock) { items.models.push({ icon: 'ok', label: 'OCR PP-OCRv4 activo' }); }
  else { items.models.push({ icon: 'warn', label: 'OCR cargando...' }); warnings++; }

  // ---- Resumen (1 linea) ----
  if (summary) {
    if (errors > 0) summary.innerHTML = '&#9888;&#65039; ' + errors + ' problema' + (errors > 1 ? 's' : '') + ' detectado' + (errors > 1 ? 's' : '');
    else if (warnings > 0) summary.innerHTML = '&#9888;&#65039; ' + warnings + ' aviso' + (warnings > 1 ? 's' : '');
    else if (detector && !detector.mock && ocr && !ocr.mock) summary.innerHTML = '&#9989; Todo listo para escanear';
    else summary.innerHTML = '&#8987; Cargando...';
  }

  // ---- HTML colapsable ----
  const sections = [
    { title: 'Dispositivo', items: items.device },
    { title: 'Navegador', items: items.browser },
    { title: 'Modelos de IA', items: items.models },
  ];
  let html = '';
  for (const s of sections) {
    let sectionErrors = 0;
    for (const it of s.items) { if (it.icon === 'err') sectionErrors++; }
    const badge = sectionErrors > 0 ? '<span class="check-section-badge err">' + sectionErrors + '</span>' : '';
    html += '<div class="check-acc" data-section="' + s.title + '">';
    html += '<button class="check-acc-header"><span>' + s.title + '</span>' + badge + '<svg class="check-acc-arrow" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>';
    html += '<div class="check-acc-body">';
    for (const it of s.items) {
      const iconSvg = it.icon === 'ok' ? '&#10003;' : it.icon === 'warn' ? '&#9888;' : '&#33;';
      html += '<div class="check-item"><div class="check-item-icon ' + it.icon + '">' + iconSvg + '</div><div class="check-item-text">';
      html += '<div class="check-item-label">' + it.label + '</div>';
      if (it.detail) html += '<div class="check-item-detail">' + it.detail + '</div>';
      if (it.fix) html += '<div class="check-item-fix">' + it.fix + '</div>';
      html += '</div></div>';
    }
    html += '</div></div>';
  }
  list.innerHTML = html;

  // Eventos acordeón principal
  const toggle = document.getElementById('check-toggle');
  const body = document.getElementById('check-body-outer');
  if (toggle && body) {
    toggle.onclick = () => {
      toggle.classList.toggle('open');
      body.classList.toggle('open');
    };
  }
  // Eventos sub-secciones
  list.querySelectorAll('.check-acc-header').forEach(h => {
    h.onclick = () => {
      const acc = h.parentElement;
      h.classList.toggle('open');
      const b = acc.querySelector('.check-acc-body');
      if (b) b.classList.toggle('open');
    };
  });
}

// ============================================================
// CANVAS OVERLAY (igual que app.js original)
// ============================================================
function drawCanvasOverlay(boxes) {
  const canvas = document.getElementById('overlay-canvas');
  if (!canvas || !canvas.width) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Oscurecer todo menos la zona de escaneo. Se hace en el canvas (GPU)
  // en vez de con un box-shadow gigante sobre el video, que era muy
  // caro de componer.
  if (running) {
    const w = canvas.width;
    const h = canvas.height;
    const x0 = w * 0.125, x1 = w * 0.875;
    const y0 = h * 0.325, y1 = h * 0.675;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, .45)';
    ctx.fillRect(0, 0, w, h);
    // "Borrar" el rectángulo de escaneo. El fillStyle tiene que ser opaco:
    // con uno semitransparente el hueco quedaría al 55% en vez de 100%.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  }

  for (const d of boxes) {
    const iw = d.x2 - d.x1;
    const ih = d.y2 - d.y1;
    if (iw < 2 || ih < 2) continue;
    ctx.strokeStyle = d.score > 0.5 ? '#00ff66' : '#ffcc00';
    ctx.lineWidth = 3;
    ctx.strokeRect(d.x1, d.y1, iw, ih);
    ctx.fillStyle = d.score > 0.5 ? '#00ff66' : '#ffcc00';
    ctx.font = 'bold 13px monospace';
    ctx.fillText((d.score * 100).toFixed(0) + '%', d.x1, d.y1 - 5);
  }

  if (lastPlate && lastPlateBox) {
    const box = lastPlateBox;
    const iw = box.x2 - box.x1, ih = box.y2 - box.y1;
    ctx.strokeStyle = '#00ff66';
    ctx.lineWidth = 4;
    ctx.strokeRect(box.x1, box.y1, iw, ih);

    const display = formatPlate(lastPlate);
    ctx.font = 'bold 20px monospace';
    const tw = ctx.measureText(display).width;
    const lx = box.x1;
    const ly = Math.max(4, box.y1 - 34);
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fillRect(lx, ly, tw + 16, 30);
    ctx.fillStyle = '#00ff66';
    ctx.fillText(display, lx + 8, ly + 22);
  }

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(cx - 30, cy); ctx.lineTo(cx + 30, cy);
  ctx.moveTo(cx, cy - 30); ctx.lineTo(cx, cy + 30);
  ctx.stroke();
  ctx.setLineDash([]);

  if (boxes.length === 0 && !lastPlate) {
    ctx.fillStyle = 'rgba(255,50,50,0.6)';
    ctx.font = '14px sans-serif';
    ctx.fillText('Sin detección', 10, 20);
  }
}

function clearCanvasOverlay() {
  const canvas = document.getElementById('overlay-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function formatPlate(p) {
  if (/^[A-Z]{4}\d{2}$/.test(p)) return p.slice(0, 4) + ' ' + p.slice(4);
  if (/^[A-Z]{2}\d{4}$/.test(p)) return p.slice(0, 2) + ' ' + p.slice(2);
  return p;
}

function updateFPS() {
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    const fps = Math.round(frameCount * 1000 / (now - lastFpsTime));
    const el = document.getElementById('hud-fps');
    if (el) el.textContent = 'FPS ' + fps;
    frameCount = 0;
    lastFpsTime = now;
  }
}

// ============================================================
// TOAST Y PWA (igual que app.js original)
// ============================================================
function showToast(msg, type) {
  const el = document.getElementById('toast');
  el.innerHTML = msg;
  el.className = 'toast' + (type ? ' toast-' + type : '');
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3000);
}

function setupPWAInstall() {
  let deferredPrompt = null;
  const installBanner = document.getElementById('install-banner');
  const installBtn = document.getElementById('install-btn');
  const installClose = document.getElementById('install-close');
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    installBanner.classList.remove('hidden');
  });
  installBtn.onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    if (result.outcome === 'accepted') installBanner.classList.add('hidden');
    deferredPrompt = null;
  };
  installClose.onclick = () => { installBanner.classList.add('hidden'); deferredPrompt = null; };
  window.addEventListener('appinstalled', () => { installBanner.classList.add('hidden'); deferredPrompt = null; });
}
// ============================================================
// EXPONER PARA DEBUGGING
// ============================================================
// Ojo: `window.supabase` lo ocupa el namespace del bundle UMD
// (vendor/supabase.js) y supabase-client.js necesita que exista
// al importarse, así que el cliente se expone con otro nombre.
window.supabaseClient = supabase;
window.guestAuth = guestAuth;
window.renderGuestLogin = renderGuestLogin;
window.navigate = navigate;