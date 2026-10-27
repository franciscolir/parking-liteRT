/**
 * admin.js - Dashboard de Administración de PlateDetect
 * Solo accesible para usuarios con role === 'admin'
 *
 * Requiere:
 *   - Tablas: users, plates, scan_history, contacts, scan_stats
 *   - Funciones RPC: is_admin(), get_admin_stats(), set_user_role(uuid, text)
 *   - Políticas RLS configuradas (ver setup.sql)
 */

import { supabase } from './supabase-client.js';

const PAGE_SIZE = 20;

export class AdminDashboard {
  constructor() {
    this.activeTab = 'users';
    this.usersCache = [];
    this.platesCache = [];
    this.scansCache = [];
    this.searchTimeout = null;
    this.currentUser = null;
  }
  // ============================================================
  // ACCESS (whitelist + sesiones)
  // ============================================================
   async loadWhitelist() {
    const list = document.getElementById('admin-whitelist-list');
    if (!list) return;
    list.innerHTML = '<div class="admin-loading">Cargando...</div>';

    // Obtener whitelist y sesiones activas
    const [whitelistRes, sessionsRes] = await Promise.all([
      supabase.rpc('get_whitelist'),
      supabase.rpc('get_active_sessions'),
    ]);

    if (whitelistRes.error) {
      list.innerHTML = `<div class="admin-error">Error: ${this.escapeHtml(whitelistRes.error.message)}</div>`;
      return;
    }

    const whitelist = whitelistRes.data || [];
    const activeNames = new Set((sessionsRes.data || []).map(s => s.name));

    if (!whitelist.length) {
      list.innerHTML = '<div class="admin-empty">No hay nombres autorizados</div>';
      return;
    }

    list.innerHTML = whitelist.map(w => {
      const inUse = activeNames.has(w.allowed_name);
      return `
        <div class="admin-card">
          <div class="admin-card-main">
            <div class="admin-card-title">${this.escapeHtml(w.allowed_name)}</div>
            <div class="admin-card-meta">
              <span class="admin-role ${inUse ? 'admin' : 'user'}">${inUse ? 'EN USO' : 'LIBRE'}</span>
            </div>
          </div>
          <div class="admin-card-actions">
            ${inUse ? `<button class="btn-small btn-danger" data-action="force-logout" data-name="${this.escapeHtml(w.allowed_name)}">Forzar logout</button>` : ''}
            <button class="btn-small btn-secondary" data-action="remove-access" data-id="${w.id}" data-name="${this.escapeHtml(w.allowed_name)}">🗑️</button>
          </div>
        </div>
      `;
    }).join('');
  }

  async loadTimeoutConfig() {
    const { data } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'session_timeout_minutes')
      .maybeSingle();

    const input = document.getElementById('admin-timeout-input');
    if (input) input.value = data?.value || 30;
  }

  async saveTimeoutConfig() {
    const input = document.getElementById('admin-timeout-input');
    const minutes = parseInt(input?.value, 10);
    if (!minutes || minutes < 5 || minutes > 1440) {
      this.toast('Timeout debe estar entre 5 y 1440 min', 'error');
      return;
    }

    const { error } = await supabase
      .from('app_settings')
      .upsert({ key: 'session_timeout_minutes', value: minutes, updated_at: new Date().toISOString() });

    if (error) {
      this.toast('Error: ' + error.message, 'error');
      return;
    }
    this.toast('Timeout actualizado', 'success');
  }

   openAccessModal() {
    console.log('[Admin] openAccessModal');
    const modal = document.getElementById('admin-access-modal');
    const input = document.getElementById('admin-access-name');
    if (!modal) { console.error('[Admin] modal no encontrado'); return; }
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    if (input) {
      input.value = '';
      setTimeout(() => input.focus(), 100);
    }
  }

  async saveAccess() {
    console.log('[Admin] saveAccess');
    const input = document.getElementById('admin-access-name');
    const name = input?.value.trim();
    if (!name) {
      this.toast('Ingresa un nombre', 'error');
      return;
    }
    if (name.length < 2) {
      this.toast('Mínimo 2 caracteres', 'error');
      return;
    }

    const { data, error } = await supabase.rpc('add_whitelist_entry', { p_name: name });
    console.log('[Admin] add_whitelist_entry:', data, error);

    if (error) {
      this.toast('Error: ' + error.message, 'error');
      return;
    }
    if (data?.ok === false) {
      this.toast(data.error || 'Error', 'error');
      return;
    }

    this.toast('Nombre agregado', 'success');

    const modal = document.getElementById('admin-access-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    }

    await this.loadWhitelist();
  }

  async removeAccess(id, name) {
    const ok = await this.confirm(
      'Eliminar acceso',
      `¿Revocar el acceso al nombre "${name}"? El usuario no podrá volver a ingresar.`
    );
    if (!ok) return;

    const { error } = await supabase.rpc('remove_whitelist_entry', { p_id: id });
    if (error) {
      this.toast('Error: ' + error.message, 'error');
      return;
    }
    this.toast('Acceso revocado', 'success');
    await this.loadWhitelist();
  }

  async forceLogout(name) {
    const ok = await this.confirm(
      'Forzar logout',
      `¿Forzar el cierre de sesión del nombre "${name}"?`
    );
    if (!ok) return;

    const { error } = await supabase.rpc('force_logout', { p_name: name });
    if (error) {
      this.toast('Error: ' + error.message, 'error');
      return;
    }
    this.toast('Sesión cerrada', 'success');
    await this.loadWhitelist();
  }
  // ============================================================
  // INICIALIZACIÓN
  // ============================================================
  async init() {
    console.log('[Admin] init() INICIADO');

    // 1. Verificar admin
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { console.warn('[Admin] No user'); return false; }
    this.currentUser = user;

    const { data: profile } = await supabase
      .from('users').select('role, email, full_name').eq('id', user.id).single();

    if (profile?.role !== 'admin') {
      console.warn('[Admin] User no es admin');
      return false;
    }

    // 2. Renderizar estructura (con modales movidos al body)
    this.renderLayout(profile);

    // 3. Bindear eventos ANTES de cargar datos
    this.bindEvents();

    // 4. Cargar datos de la vista inicial (Home)
    await this.loadStats();
    await this.loadSessions();
    await this.loadRecentScans();

    // 5. Cargar el resto en background
    this.loadUsers();
    this.loadPlates();
    this.loadScans();
    this.loadWhitelist();
    this.loadTimeoutConfig();

    console.log('[Admin] init() COMPLETADO');
    return true;
  }

  // ============================================================
  // LAYOUT
  // ============================================================
   renderLayout(profile) {
    const container = document.getElementById('view-admin');
    if (!container) { console.error('[Admin] view-admin no encontrado'); return; }

    container.innerHTML = `
      <div class="view-header">
        <h1>🔧 Panel de Administración</h1>
        <button class="header-auth-btn" id="admin-profile-btn" title="Mi perfil">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" fill="none" stroke="currentColor" stroke-width="2"/>
            <circle cx="12" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"/>
          </svg>
          <span>Perfil</span>
        </button>
      </div>

      <!-- Tabs de navegación (ARRIBA) -->
      <div class="admin-tabs">
        <button class="admin-tab active" data-tab="home">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 0 0 1 1h3m10-11l2 2m-2-2v10a1 1 0 0 1-1 1h-3m-6 0a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1m-6 0h6" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          Home
        </button>
        <button class="admin-tab" data-tab="users">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          Usuarios
        </button>
        <button class="admin-tab" data-tab="plates">
          <svg viewBox="0 0 24 24" width="16" height="16"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 10h2M11 10h2M15 10h2M7 14h10" stroke="currentColor" stroke-width="2"/></svg>
          Patentes
        </button>
        <button class="admin-tab" data-tab="scans">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 3v18h18" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 14l4-4 4 4 5-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          Escaneos
        </button>
        <button class="admin-tab" data-tab="access">
          <svg viewBox="0 0 24 24" width="16" height="16"><rect x="3" y="11" width="18" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          Accesos
        </button>
      </div>

      <!-- ============ TAB: HOME ============ -->
      <div class="admin-tab-content active" id="admin-tab-home">
        <!-- Stats globales -->
        <div class="stats-grid" id="admin-stats-grid">
          <div class="stat-card admin-stat"><div class="num" id="stat-users">—</div><div class="label">Usuarios</div></div>
          <div class="stat-card admin-stat"><div class="num" id="stat-plates">—</div><div class="label">Patentes</div></div>
          <div class="stat-card admin-stat"><div class="num" id="stat-scans">—</div><div class="label">Escaneos</div></div>
          <div class="stat-card admin-stat"><div class="num" id="stat-today">—</div><div class="label">Hoy</div></div>
        </div>

        <!-- Sesiones activas -->
        <div class="admin-section-header">
          <h3>🟢 Sesiones activas</h3>
        </div>
        <div id="admin-sessions-list" class="admin-list"></div>

        <!-- Últimas 3 patentes escaneadas -->
        <div class="admin-section-header">
          <h3>📸 Últimas patentes escaneadas</h3>
        </div>
        <div id="admin-recent-scans" class="admin-list"></div>
      </div>

      <!-- ============ TAB: USERS ============ -->
      <div class="admin-tab-content" id="admin-tab-users">
        <div class="search-box">
          <svg class="search-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="m21 21-4.3-4.3" stroke="currentColor" stroke-width="2"/></svg>
          <input type="text" id="admin-user-search" placeholder="Buscar por email o nombre..." autocomplete="off">
        </div>
        <div id="admin-users-list" class="admin-list"></div>
      </div>

      <!-- ============ TAB: PLATES ============ -->
      <div class="admin-tab-content" id="admin-tab-plates">
        <div class="search-box">
          <svg class="search-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="m21 21-4.3-4.3" stroke="currentColor" stroke-width="2"/></svg>
          <input type="text" id="admin-plate-search" placeholder="Buscar patente..." autocomplete="off">
        </div>
        <div class="admin-toolbar">
          <button class="btn-primary btn-small" id="admin-add-plate">+ Agregar patente</button>
          <select id="admin-plate-filter" class="admin-select">
            <option value="">Todas</option>
            <option value="registered">Registradas</option>
            <option value="stolen">Denunciadas</option>
          </select>
        </div>
        <div id="admin-plates-list" class="admin-list"></div>
      </div>

      <!-- ============ TAB: SCANS ============ -->
      <div class="admin-tab-content" id="admin-tab-scans">
        <div class="admin-toolbar">
          <select id="admin-scan-filter" class="admin-select">
            <option value="">Todos</option>
            <option value="registered">Registrados</option>
            <option value="stolen">Denunciados</option>
            <option value="unknown">Desconocidos</option>
          </select>
          <button class="btn-secondary btn-small" id="admin-refresh-scans">🔄 Actualizar</button>
        </div>
        <div id="admin-scans-list" class="admin-list"></div>
      </div>

      <!-- ============ TAB: ACCESS ============ -->
      <div class="admin-tab-content" id="admin-tab-access">
        <!-- Configuración de timeout -->
        <div class="admin-section-header">
          <h3>⚙️ Configuración</h3>
        </div>
        <div class="admin-card">
          <div class="admin-card-main">
            <div class="admin-card-title">Timeout de sesión</div>
            <div class="admin-card-sub">Minutos antes de liberar un nombre automáticamente</div>
          </div>
          <div class="admin-card-actions" style="display:flex;gap:6px;align-items:center;">
            <input type="number" id="admin-timeout-input" min="5" max="1440" step="5" value="30" class="admin-input-number">
            <button class="btn-small btn-primary" id="admin-timeout-save">Guardar</button>
          </div>
        </div>

        <!-- Whitelist -->
        <div class="admin-section-header" style="margin-top:16px;">
          <h3>🔐 Nombres autorizados</h3>
        </div>
        <div class="admin-toolbar">
          <button class="btn-primary btn-small" id="admin-add-access">+ Agregar nombre</button>
        </div>
        <div id="admin-whitelist-list" class="admin-list"></div>
      </div>

      <!-- Modal de confirmación -->
      <div class="modal-overlay hidden" id="admin-confirm-modal">
        <div class="modal-box">
          <div class="modal-header" id="admin-confirm-title">Confirmar acción</div>
          <p id="admin-confirm-message" style="color: var(--text-muted); margin-bottom: 16px;"></p>
          <div class="modal-actions">
            <button class="btn-secondary btn-half" id="admin-confirm-cancel">Cancelar</button>
            <button class="btn-primary btn-half" id="admin-confirm-ok">Confirmar</button>
          </div>
        </div>
      </div>

      <!-- Modal de patente -->
      <div class="modal-overlay hidden" id="admin-plate-modal">
        <div class="modal-box">
          <div class="modal-header" id="admin-plate-modal-title">Agregar patente</div>
          <div class="form-group">
            <label>Patente</label>
            <input type="text" id="admin-plate-input" placeholder="ABC123" maxlength="10" class="input-plate">
          </div>
          <div class="form-group">
            <label>Tipo</label>
            <select id="admin-plate-type">
              <option value="registered">Registrada</option>
              <option value="stolen">Denunciada</option>
              <option value="wanted">Buscada</option>
              <option value="suspicious">Sospechosa</option>
            </select>
          </div>
          <div class="form-group">
            <label>Nombre del propietario (opcional)</label>
            <input type="text" id="admin-plate-owner" placeholder="Ej: Juan Pérez">
          </div>
          <div class="form-group">
            <label>Tipo de vehículo (opcional)</label>
            <select id="admin-plate-vehicle">
              <option value="">Seleccionar...</option>
              <option value="auto">Auto</option>
              <option value="camioneta">Camioneta</option>
              <option value="moto">Moto</option>
              <option value="camion">Camión</option>
              <option value="utilitario">Utilitario</option>
              <option value="otro">Otro</option>
            </select>
          </div>
          <div class="modal-actions">
            <button class="btn-secondary btn-half" id="admin-plate-cancel">Cancelar</button>
            <button class="btn-primary btn-half" id="admin-plate-save">Guardar</button>
          </div>
        </div>
      </div>

      <!-- Modal de agregar acceso -->
      <div class="modal-overlay hidden" id="admin-access-modal">
        <div class="modal-box">
          <div class="modal-header">Agregar nombre autorizado</div>
          <div class="form-group">
            <label>Nombre</label>
            <input type="text" id="admin-access-name" placeholder="Ej: Guardia 1" maxlength="32" class="input-plate" style="text-transform:none;letter-spacing:normal;text-align:center;font-weight:400;">
          </div>
          <div class="modal-actions">
            <button class="btn-secondary btn-half" id="admin-access-cancel">Cancelar</button>
            <button class="btn-primary btn-half" id="admin-access-save">Guardar</button>
          </div>
        </div>
      </div>
    `;

    // ⚡ FIX: Mover los modales al body para evitar anidamiento
    ['admin-access-modal', 'admin-plate-modal', 'admin-confirm-modal'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.parentElement !== document.body) {
        document.body.appendChild(el);
      }
      if (el) {
        el.classList.add('hidden');
        el.style.display = 'none';
      }
    });
  }

  // ============================================================
  // STATS
  // ============================================================
  async loadStats() {
    const { data, error } = await supabase.rpc('get_admin_stats');
    if (error) {
      console.error('[Admin] Error cargando stats:', error);
      return;
    }

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '0'; };
    set('stat-users', data?.total_users);
    set('stat-plates', data?.total_plates);
    set('stat-scans', data?.total_scans);
    set('stat-today', data?.scans_today);
  }

  // ============================================================
  // USERS
  // ============================================================
    async loadSessions() {
    const list = document.getElementById('admin-sessions-list');
    if (!list) return;
    list.innerHTML = '<div class="admin-loading">Cargando...</div>';

    const { data, error } = await supabase.rpc('get_active_sessions');
    if (error) {
      list.innerHTML = `<div class="admin-error">Error: ${this.escapeHtml(error.message)}</div>`;
      return;
    }

    if (!data?.length) {
      list.innerHTML = '<div class="admin-empty">No hay sesiones activas</div>';
      return;
    }

    list.innerHTML = data.map(s => {
      const started = new Date(s.started_at);
      const last = new Date(s.last_activity);
      const diffMin = Math.round((Date.now() - last.getTime()) / 60000);
      return `
        <div class="admin-card">
          <div class="admin-card-main">
            <div class="admin-card-title">${this.escapeHtml(s.name)}</div>
            <div class="admin-card-meta">
              <span class="admin-date">Inicio: ${this.formatDate(s.started_at)}</span>
              <span class="admin-date">Activo hace ${diffMin} min</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  async loadRecentScans() {
    const list = document.getElementById('admin-recent-scans');
    if (!list) return;
    list.innerHTML = '<div class="admin-loading">Cargando...</div>';

    const { data, error } = await supabase
      .from('scan_history')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(3);

    if (error) {
      list.innerHTML = `<div class="admin-error">Error: ${this.escapeHtml(error.message)}</div>`;
      return;
    }

    if (!data?.length) {
      list.innerHTML = '<div class="admin-empty">No hay escaneos recientes</div>';
      return;
    }

    const statusMap = {
      registered: { label: 'Registrado', cls: 'reg' },
      stolen: { label: 'Denunciado', cls: 'stolen' },
      unknown: { label: 'Desconocido', cls: 'unk' },
      error: { label: 'Error', cls: 'unk' },
    };

    list.innerHTML = data.map(s => {
      const st = statusMap[s.status] || { label: s.status, cls: 'unk' };
      return `
        <div class="admin-card">
          <div class="admin-card-main">
            <div class="admin-card-title mono">${this.escapeHtml(s.plate)}</div>
            <div class="admin-card-meta">
              <span class="plate-row-badge ${st.cls}">${st.label}</span>
              <span class="admin-date">${this.formatDate(s.created_at)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }
  async loadUsers(search = '') {
    const list = document.getElementById('admin-users-list');
    if (!list) return;
    list.innerHTML = '<div class="admin-loading">Cargando usuarios...</div>';

    let query = supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (search) {
      query = query.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
    }

    const { data, error } = await query;
    if (error) {
      list.innerHTML = `<div class="admin-error">Error: ${this.escapeHtml(error.message)}</div>`;
      return;
    }

    this.usersCache = data || [];
    this.renderUsers(this.usersCache);
  }

  renderUsers(users) {
    const list = document.getElementById('admin-users-list');
    if (!list) return;

    if (!users.length) {
      list.innerHTML = '<div class="admin-empty">No hay usuarios</div>';
      return;
    }

    list.innerHTML = users.map(u => {
      const isAdmin = u.role === 'admin';
      const isSelf = u.id === this.currentUser?.id;
      const action = isSelf
        ? '<span class="admin-self-tag">(tú)</span>'
        : `<button class="btn-small ${isAdmin ? 'btn-secondary' : 'btn-primary'}" data-action="toggle-role" data-user-id="${u.id}" data-current-role="${u.role}">
            ${isAdmin ? '↓ Degradar a user' : '↑ Promover a admin'}
          </button>`;

      return `
        <div class="admin-card">
          <div class="admin-card-main">
            <div class="admin-card-title">${this.escapeHtml(u.full_name || u.email.split('@')[0])}</div>
            <div class="admin-card-sub">${this.escapeHtml(u.email)}</div>
            <div class="admin-card-meta">
              <span class="admin-role ${isAdmin ? 'admin' : 'user'}">${u.role}</span>
              <span class="admin-date">${this.formatDate(u.created_at)}</span>
            </div>
          </div>
          <div class="admin-card-actions">${action}</div>
        </div>
      `;
    }).join('');
  }

  async toggleRole(userId, currentRole) {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    const { error } = await supabase.rpc('set_user_role', {
      target_user_id: userId,
      new_role: newRole,
    });

    if (error) {
      this.toast('Error: ' + error.message, 'error');
      return;
    }

    this.toast(`Rol actualizado a ${newRole}`, 'success');
    await this.loadUsers(document.getElementById('admin-user-search')?.value || '');
    await this.loadStats();
  }

  // ============================================================
  // PLATES
  // ============================================================
  async loadPlates(search = '', typeFilter = '') {
    const list = document.getElementById('admin-plates-list');
    if (!list) return;
    list.innerHTML = '<div class="admin-loading">Cargando patentes...</div>';

    let query = supabase
      .from('plates')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (search) query = query.ilike('plate', `%${search.toUpperCase()}%`);
    if (typeFilter) query = query.eq('type', typeFilter);

    const { data, error } = await query;
    if (error) {
      list.innerHTML = `<div class="admin-error">Error: ${this.escapeHtml(error.message)}</div>`;
      return;
    }

    this.platesCache = data || [];
    this.renderPlates(this.platesCache);
  }

  renderPlates(plates) {
    const list = document.getElementById('admin-plates-list');
    if (!list) return;

    if (!plates.length) {
      list.innerHTML = '<div class="admin-empty">No hay patentes</div>';
      return;
    }

    const typeLabels = {
      registered: { label: 'Registrada', cls: 'reg' },
      stolen: { label: 'Denunciada', cls: 'stolen' },
      wanted: { label: 'Buscada', cls: 'warn' },
      suspicious: { label: 'Sospechosa', cls: 'unk' },
    };

    list.innerHTML = plates.map(p => {
      const t = typeLabels[p.type] || { label: p.type, cls: 'unk' };
      const inactive = p.is_active === false ? '<span class="admin-tag-inactive">Inactiva</span>' : '';
      return `
        <div class="admin-card">
          <div class="admin-card-main">
            <div class="admin-card-title mono">${this.escapeHtml(p.plate)}</div>
            <div class="admin-card-meta">
              <span class="plate-row-badge ${t.cls}">${t.label}</span>
              ${inactive}
              ${p.owner_name ? `<span class="admin-meta-text">${this.escapeHtml(p.owner_name)}</span>` : ''}
            </div>
          </div>
          <div class="admin-card-actions">
            <button class="btn-small btn-secondary" data-action="edit-plate" data-plate-id="${p.id}">✏️</button>
            <button class="btn-small btn-danger" data-action="delete-plate" data-plate-id="${p.id}" data-plate="${this.escapeHtml(p.plate)}">🗑️</button>
          </div>
        </div>
      `;
    }).join('');
  }

  openPlateModal(plate = null) {
    const modal = document.getElementById('admin-plate-modal');
    const title = document.getElementById('admin-plate-modal-title');
    const inputPlate = document.getElementById('admin-plate-input');
    const inputType = document.getElementById('admin-plate-type');
    const inputOwner = document.getElementById('admin-plate-owner');
    const inputVehicle = document.getElementById('admin-plate-vehicle');

    if (plate) {
      title.textContent = 'Editar patente';
      inputPlate.value = plate.plate;
      inputPlate.dataset.plateId = plate.id;
      inputType.value = plate.type;
      inputOwner.value = plate.owner_name || '';
      inputVehicle.value = plate.vehicle_type || '';
    } else {
      title.textContent = 'Agregar patente';
      inputPlate.value = '';
      delete inputPlate.dataset.plateId;
      inputType.value = 'registered';
      inputOwner.value = '';
      inputVehicle.value = '';
    }

    modal.classList.remove('hidden');
    setTimeout(() => inputPlate.focus(), 100);
  }

  async savePlate() {
    const inputPlate = document.getElementById('admin-plate-input');
    const plateId = inputPlate.dataset.plateId;
    const plate = inputPlate.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const type = document.getElementById('admin-plate-type').value;
    const owner_name = document.getElementById('admin-plate-owner').value.trim();
    const vehicle_type = document.getElementById('admin-plate-vehicle').value;

    if (!plate || plate.length < 4) {
      this.toast('Patente inválida (mín 4 caracteres)', 'error');
      return;
    }

    const payload = { plate, type, owner_name: owner_name || null, vehicle_type: vehicle_type || null };

    let error;
    if (plateId) {
      ({ error } = await supabase.from('plates').update(payload).eq('id', plateId));
    } else {
      const { data: { user } } = await supabase.auth.getUser();
      ({ error } = await supabase.from('plates').insert({ ...payload, reported_by: user.id }));
    }

    if (error) {
      this.toast('Error: ' + error.message, 'error');
      return;
    }

    this.toast(plateId ? 'Patente actualizada' : 'Patente agregada', 'success');
    document.getElementById('admin-plate-modal').classList.add('hidden');
    await this.loadPlates(
      document.getElementById('admin-plate-search')?.value || '',
      document.getElementById('admin-plate-filter')?.value || ''
    );
    await this.loadStats();
  }

  async deletePlate(id, plate) {
    const ok = await this.confirm(
      'Eliminar patente',
      `¿Seguro que quieres eliminar la patente ${plate}? Esta acción no se puede deshacer.`
    );
    if (!ok) return;

    const { error } = await supabase.from('plates').delete().eq('id', id);
    if (error) {
      this.toast('Error: ' + error.message, 'error');
      return;
    }

    this.toast('Patente eliminada', 'success');
    await this.loadPlates(
      document.getElementById('admin-plate-search')?.value || '',
      document.getElementById('admin-plate-filter')?.value || ''
    );
    await this.loadStats();
  }

  // ============================================================
  // SCANS
  // ============================================================
  async loadScans(statusFilter = '') {
    const list = document.getElementById('admin-scans-list');
    if (!list) return;
    list.innerHTML = '<div class="admin-loading">Cargando escaneos...</div>';

    let query = supabase
      .from('scan_history')
      .select('*, users!inner(email, full_name)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (statusFilter) query = query.eq('status', statusFilter);

    const { data, error } = await query;
    if (error) {
      // Fallback: si el join falla, intentar sin join
      const { data: fallback, error: err2 } = await supabase
        .from('scan_history')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (err2) {
        list.innerHTML = `<div class="admin-error">Error: ${this.escapeHtml(error.message)}</div>`;
        return;
      }
      this.scansCache = fallback || [];
    } else {
      this.scansCache = data || [];
    }

    this.renderScans(this.scansCache);
  }

  renderScans(scans) {
    const list = document.getElementById('admin-scans-list');
    if (!list) return;

    if (!scans.length) {
      list.innerHTML = '<div class="admin-empty">No hay escaneos</div>';
      return;
    }

    const statusMap = {
      registered: { label: 'Registrado', cls: 'reg' },
      stolen: { label: 'Denunciado', cls: 'stolen' },
      unknown: { label: 'Desconocido', cls: 'unk' },
      error: { label: 'Error', cls: 'unk' },
    };

    list.innerHTML = scans.map(s => {
      const st = statusMap[s.status] || { label: s.status, cls: 'unk' };
      const userEmail = s.users?.email || 'Anónimo';
      return `
        <div class="admin-card">
          <div class="admin-card-main">
            <div class="admin-card-title mono">${this.escapeHtml(s.plate)}</div>
            <div class="admin-card-sub">${this.escapeHtml(userEmail)}</div>
            <div class="admin-card-meta">
              <span class="plate-row-badge ${st.cls}">${st.label}</span>
              <span class="admin-date">${this.formatDate(s.created_at)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ============================================================
  // EVENTOS
  // ============================================================
  bindEvents() {
        // Tabs
    document.querySelectorAll('.admin-tab').forEach(tab => {
      tab.onclick = async () => {
        const target = tab.dataset.tab;
        this.activeTab = target;
        
        // Cambiar tab activa
        document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`admin-tab-${target}`)?.classList.add('active');

        // Cargar datos según la tab
        if (target === 'home') {
          await this.loadStats();
          await this.loadSessions();
          await this.loadRecentScans();
        } else if (target === 'users') {
          await this.loadUsers();
        } else if (target === 'plates') {
          await this.loadPlates();
        } else if (target === 'scans') {
          await this.loadScans();
        } else if (target === 'access') {
          await this.loadWhitelist();
          await this.loadTimeoutConfig();
        }
      };
    });

    // Búsqueda de usuarios (debounced)
    const userSearch = document.getElementById('admin-user-search');
    if (userSearch) {
      userSearch.addEventListener('input', (e) => {
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(() => this.loadUsers(e.target.value), 300);
      });
    }

    // Búsqueda de patentes (debounced)
    const plateSearch = document.getElementById('admin-plate-search');
    const plateFilter = document.getElementById('admin-plate-filter');
    if (plateSearch) {
      plateSearch.addEventListener('input', (e) => {
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(() => {
          this.loadPlates(e.target.value, plateFilter?.value || '');
        }, 300);
      });
    }
    if (plateFilter) {
      plateFilter.addEventListener('change', () => {
        this.loadPlates(plateSearch?.value || '', plateFilter.value);
      });
    }

    // Filtro de escaneos
    const scanFilter = document.getElementById('admin-scan-filter');
    if (scanFilter) {
      scanFilter.addEventListener('change', () => this.loadScans(scanFilter.value));
    }
    const refreshScans = document.getElementById('admin-refresh-scans');
    if (refreshScans) {
      refreshScans.addEventListener('click', () => this.loadScans(scanFilter?.value || ''));
    }

    // Botón "Agregar patente"
    const addPlate = document.getElementById('admin-add-plate');
    if (addPlate) {
      addPlate.addEventListener('click', () => this.openPlateModal());
    }

    // Modal de patente: guardar y cancelar
    const plateSave = document.getElementById('admin-plate-save');
    if (plateSave) plateSave.addEventListener('click', () => this.savePlate());
    const plateCancel = document.getElementById('admin-plate-cancel');
    if (plateCancel) {
      plateCancel.addEventListener('click', () => {
        document.getElementById('admin-plate-modal')?.classList.add('hidden');
      });
    }

    // Delegación de eventos para botones de acción
    document.getElementById('view-admin')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      if (action === 'toggle-role') {
        await this.toggleRole(btn.dataset.userId, btn.dataset.currentRole);
      } else if (action === 'edit-plate') {
        const plate = this.platesCache.find(p => p.id === btn.dataset.plateId);
        if (plate) this.openPlateModal(plate);
      } else if (action === 'delete-plate') {
        await this.deletePlate(btn.dataset.plateId, btn.dataset.plate);
      }
    });

    // Modal de confirmación
    const confirmCancel = document.getElementById('admin-confirm-cancel');
    const confirmOk = document.getElementById('admin-confirm-ok');
    if (confirmCancel) confirmCancel.addEventListener('click', () => {
      document.getElementById('admin-confirm-modal')?.classList.add('hidden');
      this._confirmResolve?.(false);
    });
    if (confirmOk) confirmOk.addEventListener('click', () => {
      document.getElementById('admin-confirm-modal')?.classList.add('hidden');
      this._confirmResolve?.(true);
    });
        // Botón de perfil en admin
    const profileBtn = document.getElementById('admin-profile-btn');
    if (profileBtn) {
      profileBtn.addEventListener('click', () => {
        window.navigate('profile');
      });
    }
        // Tab de accesos
    document.getElementById('admin-add-access')?.addEventListener('click', () => this.openAccessModal());
    document.getElementById('admin-access-save')?.addEventListener('click', () => this.saveAccess());
    document.getElementById('admin-access-cancel')?.addEventListener('click', () => {
      document.getElementById('admin-access-modal')?.classList.add('hidden');
    });
    document.getElementById('admin-timeout-save')?.addEventListener('click', () => this.saveTimeoutConfig());

    // Delegación para force-logout y remove-access
    document.getElementById('view-admin')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'force-logout') await this.forceLogout(btn.dataset.name);
      else if (action === 'remove-access') await this.removeAccess(btn.dataset.id, btn.dataset.name);
    });
  }

  // ============================================================
  // HELPERS
  // ============================================================
  confirm(title, message) {
    return new Promise((resolve) => {
      this._confirmResolve = resolve;
      document.getElementById('admin-confirm-title').textContent = title;
      document.getElementById('admin-confirm-message').textContent = message;
      document.getElementById('admin-confirm-modal').classList.remove('hidden');
    });
  }

  formatDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  }

  escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  toast(msg, type) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.innerHTML = msg;
    el.className = 'toast' + (type ? ' toast-' + type : '');
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 3000);
  }
}