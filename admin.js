/**
 * admin.js - Dashboard de Administración de PlateDetect
 * Solo accesible para usuarios con role === 'admin'
 *
 * Requiere:
 *   - Tablas: users, plates, scan_history, contacts, scan_stats
 *   - Funciones RPC: is_admin(), get_admin_stats(), set_user_role(uuid, text)
 *   - Políticas RLS configuradas (ver setup.sql)
 */

import { supabase, findExistingPlates } from './supabase-client.js';
import { BulkPlateSession, bulkRowStatus, insertBulkPlates } from './bulk-plates.js';
import { PLATE_TYPES, TYPE_LABELS, getTypeLabel, getScanStatus } from './plate-types.js';

const PAGE_SIZE = 20;

export class AdminDashboard {
  constructor() {
    this.activeTab = 'users';
    this.usersCache = [];
    this.platesCache = [];
    this.whitelistCache = [];
    this.searchTimeout = null;
    this.currentUser = null;
    this.bulkSession = new BulkPlateSession();
    this._editingAccessId = null;
  }
  // ============================================================
  // ACCESS (whitelist unificada: sesiones activas + nombres)
  // ============================================================
   async loadWhitelist() {
    const list = document.getElementById('admin-whitelist-list');
    if (!list) return;
    list.innerHTML = '<div class="admin-loading">Cargando...</div>';

    // Whitelist + sesiones activas + estado activo/inactivo de cada nombre
    const [whitelistRes, sessionsRes, activeRes] = await Promise.all([
      supabase.rpc('get_whitelist'),
      supabase.rpc('get_active_sessions'),
      supabase.rpc('get_whitelist_active'),   // creado en whitelist-admin.sql (trae is_active)
    ]);

    // Fuente preferida: get_whitelist_active (incluye is_active)
    const useActive = !activeRes.error && Array.isArray(activeRes.data);
    if (!useActive && whitelistRes.error) {
      list.innerHTML = `<div class="admin-error">Error: ${this.escapeHtml(whitelistRes.error.message)}</div>`;
      return;
    }

    const whitelist = useActive ? activeRes.data : (whitelistRes.data || []);

    // is_active: preferir leerlo directo de la tabla (fallback: activo)
    const activeMap = new Map();
    try {
      const { data: rows, error: rowsErr } = await supabase
        .from('name_whitelist')
        .select('id, is_active');
      if (!rowsErr && rows) {
        rows.forEach(r => activeMap.set(String(r.id), r.is_active !== false));
      }
    } catch { /* sin acceso directo → asumir activo */ }

    // Sesiones activas: la comparación es en MAYÚSCULAS (la whitelist
    // siempre se guarda en mayúsculas).
    const sessionByName = new Map(
      (sessionsRes.data || []).map(s => [String(s.name || '').trim().toUpperCase(), s])
    );

    this.whitelistCache = whitelist.map(w => ({
      ...w,
      isActive: (w.is_active ?? activeMap.get(String(w.id)) ?? true) !== false,
      session: sessionByName.get(String(w.allowed_name || '').trim().toUpperCase()) || null,
    }));

    // Checkbox "Activar todos"
    const checkAll = document.getElementById('admin-check-all');
    if (checkAll) {
      checkAll.checked = this.whitelistCache.length > 0 && this.whitelistCache.every(w => w.isActive);
    }

    if (!this.whitelistCache.length) {
      list.innerHTML = '<div class="admin-empty">No hay nombres autorizados</div>';
      return;
    }

    // Una sola lista: cada fila es una píldora con su estado.
    list.innerHTML = this.whitelistCache.map(w => {
      const inUse = !!w.session;
      const name = String(w.allowed_name);
      const badge = !w.isActive ? 'INACTIVO' : (inUse ? 'EN USO' : 'LIBRE');
      const badgeCls = !w.isActive ? 'off' : (inUse ? 'on' : '');
      const diffMin = (inUse && w.session.last_activity)
        ? Math.max(0, Math.round((Date.now() - new Date(w.session.last_activity).getTime()) / 60000))
        : null;
      // En uso ⇒ botón "Salir"; libre ⇒ checkbox que activa el login.
      const checkControl = inUse
        ? `<button class="btn-small btn-danger btn-logout" data-action="force-logout" data-name="${this.escapeHtml(name)}" title="Cerrar sesión de ${this.escapeHtml(name)}">Salir</button>`
        : `<label class="pill-check" title="Activar / desactivar">
             <input type="checkbox" data-action="toggle-active" data-id="${w.id}" ${w.isActive ? 'checked' : ''}>
           </label>`;
      return `
        <div class="admin-card pill-row ${w.isActive ? '' : 'pill-inactive'}" data-id="${w.id}" data-name="${this.escapeHtml(name)}">
          ${checkControl}
          <span class="pill-dot ${inUse ? 'on' : ''}" title="${inUse ? 'En uso' : 'Libre'}"></span>
          <div class="pill">
            <span class="pill-name">${this.escapeHtml(name)}</span>
            <span class="pill-badge ${badgeCls}">${badge}</span>
            <span class="pill-meta">${diffMin !== null ? `Activo hace ${diffMin} min` : ''}</span>
          </div>
          <div class="admin-card-actions">
            <button class="btn-small btn-secondary" data-action="row-menu" title="Acciones">⋯</button>
          </div>
          <div class="pill-actions hidden">
            <button class="btn-small btn-secondary" data-action="edit-access">✏️ Editar</button>
            <button class="btn-small btn-danger" data-action="remove-access" data-id="${w.id}" data-name="${this.escapeHtml(name)}">🗑️ Borrar</button>
          </div>
        </div>
      `;
    }).join('');
  }

  /** Activa o desactiva un nombre (si está inactivo, no puede loguearse). */
  async toggleActive(id, active) {
    // RPC creado en whitelist-admin.sql; si todavía no existe, update directo
    let { data, error } = await supabase.rpc('set_whitelist_active', { p_id: id, p_active: active });
    if (!error && data?.ok === false) error = { message: data.error || 'No se pudo actualizar' };
    if (error) {
      const res = await supabase
        .from('name_whitelist')
        .update({ is_active: active, updated_at: new Date().toISOString() })
        .eq('id', id);
      error = res.error;
    }

    if (error) {
      this.toast('Error: ' + error.message, 'error');
      await this.loadWhitelist();
      return;
    }

    this.toast(active ? 'Nombre activado' : 'Nombre desactivado', 'success');
    await this.loadWhitelist();
  }

  /** Activa o desactiva todos los nombres de una vez. */
  async setAllActive(active) {
    const targets = (this.whitelistCache || []).filter(w => !!w.isActive !== active);
    if (!targets.length) {
      this.toast(active ? 'Todos ya están activos' : 'Todos ya están inactivos');
      return;
    }

    let failed = 0;
    for (const w of targets) {
      let { data, error } = await supabase.rpc('set_whitelist_active', { p_id: w.id, p_active: active });
      if (!error && data?.ok === false) error = { message: data.error };
      if (error) {
        const res = await supabase
          .from('name_whitelist')
          .update({ is_active: active, updated_at: new Date().toISOString() })
          .eq('id', w.id);
        if (res.error) failed++;
      }
    }

    if (failed) this.toast(`${failed} nombre(es) no se pudieron actualizar`, 'error');
    else this.toast(active ? 'Todos activados' : 'Todos desactivados', 'success');
    await this.loadWhitelist();
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
    document.getElementById('admin-settings-modal')?.classList.add('hidden');
  }

   openAccessModal(entry = null) {
    console.log('[Admin] openAccessModal', entry);
    const modal = document.getElementById('admin-access-modal');
    const input = document.getElementById('admin-access-name');
    const title = document.getElementById('admin-access-modal-title');
    const hint = document.getElementById('admin-access-hint');
    if (!modal) { console.error('[Admin] modal no encontrado'); return; }

    if (entry?.id) {
      // Modo edición (un solo nombre)
      this._editingAccessId = entry.id;
      if (title) title.textContent = 'Editar nombre autorizado';
      if (hint) hint.textContent = 'Guarda el nuevo nombre en MAYÚSCULAS.';
      if (input) input.value = String(entry.name || '').toUpperCase();
    } else {
      // Modo alta: admite VARIOS nombres separados por un espacio
      this._editingAccessId = null;
      if (title) title.textContent = 'Agregar nombres autorizados';
      if (hint) hint.textContent = 'Para agregar varios, sepáralos con un espacio.';
      if (input) input.value = '';
    }

    modal.classList.remove('hidden');
    if (input) setTimeout(() => input.focus(), 100);
  }

  async saveAccess() {
    console.log('[Admin] saveAccess');
    const input = document.getElementById('admin-access-name');
    const raw = (input?.value || '').trim().toUpperCase();
    if (!raw) {
      this.toast('Ingresa un nombre', 'error');
      return;
    }

    // ============================================================
    // MODO EDICIÓN (un solo nombre, conserva los espacios internos)
    // ============================================================
    if (this._editingAccessId) {
      const name = raw;   // un solo nombre completo: "ANA PEREZ"
      if (name.length < 2 || name.length > 32) {
        this.toast('El nombre debe tener entre 2 y 32 caracteres', 'error');
        return;
      }

      let { data, error } = await supabase.rpc('update_whitelist_entry', { p_id: this._editingAccessId, p_name: name });
      if (!error && data?.ok === false) error = { message: data.error || 'No se pudo actualizar' };
      if (error) {
        const res = await supabase
          .from('name_whitelist')
          .update({ allowed_name: name, updated_at: new Date().toISOString() })
          .eq('id', this._editingAccessId);
        error = res.error;
      }

      if (error) {
        this.toast('Error: ' + error.message, 'error');
        return;
      }

      this.toast('Nombre actualizado', 'success');
      this._editingAccessId = null;
      document.getElementById('admin-access-modal')?.classList.add('hidden');
      await this.loadWhitelist();
      return;
    }

    // ============================================================
    // ALTA MASIVA: "GUARDIA1 GUARDIA2 GUARDIA3" → 3 accesos
    // ============================================================
    const names = [...new Set(raw.split(/\s+/).filter(Boolean))];
    let added = 0;
    let failed = 0;

    for (const name of names) {
      if (name.length < 2 || name.length > 32) { failed++; continue; }
      const { data, error } = await supabase.rpc('add_whitelist_entry', { p_name: name });
      console.log('[Admin] add_whitelist_entry:', name, data, error);
      if (error || data?.ok === false) failed++;
      else added++;
    }

    if (!added) {
      this.toast(failed ? 'No se pudo agregar ningún nombre' : 'Error', 'error');
      return;
    }

    this.toast(
      added === 1 ? 'Nombre agregado' : `${added} nombres agregados` + (failed ? ` (${failed} con error)` : ''),
      'success'
    );

    const modal = document.getElementById('admin-access-modal');
    if (modal) {
      modal.classList.add('hidden');
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
    await this.loadRecentScans();

    // 5. Cargar el resto en background
    this.loadUsers();
    this.loadPlates();
    this.loadPlateStats();
    this.loadWhitelist();

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

        <!-- Últimas patentes escaneadas (antes era la pestaña Escaneos) -->
        <div class="admin-section-header">
          <h3>📸 Últimas patentes escaneadas</h3>
        </div>
        <div id="admin-recent-scans" class="admin-list"></div>
      </div>

      <!-- ============ TAB: USUARIOS (registrados + flotantes) ============ -->
      <div class="admin-tab-content" id="admin-tab-users">
        <div class="admin-subtabs">
          <button class="admin-subtab active" data-subtab="users-registered">📋 Registrados</button>
          <button class="admin-subtab" data-subtab="users-floating">👥 Flotantes</button>
        </div>

        <!-- Sub-vista: usuarios registrados (con cuenta) -->
        <div class="admin-subtab-content active" id="admin-subtab-users-registered">
          <div class="search-box">
            <svg class="search-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="m21 21-4.3-4.3" stroke="currentColor" stroke-width="2"/></svg>
            <input type="text" id="admin-user-search" placeholder="Buscar por email o nombre..." autocomplete="off">
          </div>
          <div id="admin-users-list" class="admin-list"></div>
        </div>

        <!-- Sub-vista: usuarios flotantes (ingresan solo con nombre) -->
        <div class="admin-subtab-content" id="admin-subtab-users-floating">
          <!-- Una sola lista: sesiones activas + whitelist, en píldoras -->
          <div class="admin-toolbar">
            <label class="check-all" title="Activar o desactivar todos los nombres">
              <input type="checkbox" id="admin-check-all">
              <span>Activar todos</span>
            </label>
            <button class="btn-primary btn-small" id="admin-add-access">+ Agregar</button>
            <button class="btn-secondary btn-small" id="admin-settings-btn">⚙️ Ajustes</button>
          </div>
          <div class="admin-section-header">
            <h3>🔐 Usuarios flotantes</h3>
          </div>
          <div id="admin-whitelist-list" class="admin-list"></div>
        </div>
      </div>

      <!-- ============ TAB: PATENTES (individual + masivo) ============ -->
      <div class="admin-tab-content" id="admin-tab-plates">
        <div class="admin-subtabs">
          <button class="admin-subtab active" data-subtab="plates-individual">📌 Individual</button>
          <button class="admin-subtab" data-subtab="plates-bulk">📥 Masivo</button>
        </div>

        <!-- Sub-vista: ingreso individual -->
        <div class="admin-subtab-content active" id="admin-subtab-plates-individual">
          <!-- Mini cards: NE / AD / PA / TOT -->
          <div class="mini-stats">
            <div class="mini-cards" id="plates-mini-cards"></div>
          </div>

          <div class="search-box">
            <svg class="search-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="m21 21-4.3-4.3" stroke="currentColor" stroke-width="2"/></svg>
            <input type="text" id="admin-plate-search" placeholder="Buscar patente..." autocomplete="off">
          </div>
          <div class="admin-toolbar">
            <button class="btn-primary btn-small" id="admin-add-plate">+ Agregar patente</button>
            <select id="admin-plate-filter" class="admin-select">
              <option value="">Todas</option>
              <option value="special_needs">Necesidades especiales</option>
              <option value="administration">Administración</option>
              <option value="first_aid">Primeros auxilios</option>
            </select>
          </div>
          <div id="admin-plates-list" class="admin-list"></div>
        </div>

        <!-- Sub-vista: ingreso masivo por texto -->
        <div class="admin-subtab-content" id="admin-subtab-plates-bulk">
          <div class="bulk-header">
            <h2>📋 Ingreso masivo por texto</h2>
            <p class="bulk-hint">
              Pega uno o varios mensajes de WhatsApp. El sistema analiza el texto,
              extrae las patentes y muestra una tabla editable.
              <strong>Nada se guarda hasta que revises y confirmes.</strong>
            </p>
          </div>

          <div class="bulk-input-box">
            <textarea
              id="bulk-text"
              class="bulk-textarea"
              rows="8"
              spellcheck="false"
              placeholder="Ej: Buenos días, para hoy ingresan:&#10;ABCD12 visita&#10;BCDF34 proveedor&#10;También viene el vehículo patente AB-CD-13."
            ></textarea>
            <div class="bulk-input-actions">
              <button class="btn-primary btn-small" id="bulk-analyze">🔍 Analizar texto</button>
              <button class="btn-secondary btn-small" id="bulk-clear">Limpiar</button>
            </div>
          </div>

          <div class="bulk-results hidden" id="bulk-results">
            <div class="bulk-summary-wrap">
              <div class="bulk-summary" id="bulk-summary"></div>
              <button class="btn-primary btn-small" id="bulk-save" disabled>💾 Guardar</button>
            </div>

            <div class="bulk-table-wrap">
              <table class="bulk-table">
                <thead>
                  <tr>
                    <th>Patente</th>
                    <th>Tipo</th>
                    <th>Texto detectado</th>
                    <th>Estado</th>
                    <th class="bulk-th-actions"></th>
                  </tr>
                </thead>
                <tbody id="bulk-table-body"></tbody>
              </table>
            </div>

            <div class="bulk-errors hidden" id="bulk-errors"></div>

            <div class="bulk-table-actions">
              <button class="btn-secondary btn-small" id="bulk-add-row">+ Agregar patente</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ============ TAB: ESCANEOS (eliminado: la info vive en Home) ============ -->

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
              <option value="special_needs">Necesidades especiales</option>
              <option value="administration">Administración</option>
              <option value="first_aid">Primeros auxilios</option>
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

      <!-- Modal de agregar/editar acceso (admite varios nombres) -->
      <div class="modal-overlay hidden" id="admin-access-modal">
        <div class="modal-box">
          <div class="modal-header" id="admin-access-modal-title">Agregar nombres autorizados</div>
          <div class="form-group">
            <label>Nombre(s)</label>
            <input type="text" id="admin-access-name" placeholder="EJ: GUARDIA 1 GUARDIA 2" maxlength="200" class="input-name" autocomplete="off">
            <p class="admin-card-sub" id="admin-access-hint">Para agregar varios, sepáralos con un espacio.</p>
          </div>
          <div class="modal-actions">
            <button class="btn-secondary btn-half" id="admin-access-cancel">Cancelar</button>
            <button class="btn-primary btn-half" id="admin-access-save">Guardar</button>
          </div>
        </div>
      </div>

      <!-- Modal de ajustes (logout automático) -->
      <div class="modal-overlay hidden" id="admin-settings-modal">
        <div class="modal-box">
          <div class="modal-header">⚙️ Ajustes</div>
          <div class="form-group">
            <label>Logout automático (minutos)</label>
            <input type="number" id="admin-timeout-input" min="5" max="1440" step="5" value="30" class="admin-input-number">
            <p class="admin-card-sub">Tiempo sin actividad antes de liberar un nombre automáticamente.</p>
          </div>
          <div class="modal-actions">
            <button class="btn-secondary btn-half" id="admin-settings-cancel">Cancelar</button>
            <button class="btn-primary btn-half" id="admin-timeout-save">Guardar</button>
          </div>
        </div>
      </div>
    `;

    // ⚡ FIX: Mover los modales al body para evitar anidamiento
    ['admin-access-modal', 'admin-plate-modal', 'admin-confirm-modal', 'admin-settings-modal'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.parentElement !== document.body) {
        document.body.appendChild(el);
      }
      if (el) {
        el.classList.add('hidden');
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

    list.innerHTML = data.map(s => {
      const st = getScanStatus(s.status);
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
    this.syncMiniCards(typeFilter);
  }

  /**
   * Mini tarjetas de la vista de patentes: NE / AD / PA / TOT.
   * TOT es el total de ingresadas (activas). Al tocar una card se filtra
   * la lista por ese tipo; TOT quita el filtro.
   */
  async loadPlateStats() {
    const box = document.getElementById('plates-mini-cards');
    if (!box) return;

    const { data, error } = await supabase
      .from('plates')
      .select('type,is_active');

    if (error) {
      console.warn('[Admin] Error cargando el resumen de patentes:', error);
      return;
    }

    const rows = data || [];
    const active = rows.filter(p => p.is_active !== false);

    const counts = {};
    for (const t of PLATE_TYPES) counts[t.value] = 0;
    for (const p of active) {
      if (counts[p.type] === undefined) counts[p.type] = 0;
      counts[p.type]++;
    }

    const inactive = rows.length - active.length;

    box.innerHTML = PLATE_TYPES.map(t => `
      <button type="button" class="mini-card mini-${t.cls}" data-type="${t.value}"
              title="${t.label}: ${counts[t.value] || 0}">
        <span class="mini-card-value">${counts[t.value] || 0}</span>
        <span class="mini-card-label">${t.abbr}</span>
      </button>
    `).join('') + `
      <button type="button" class="mini-card mini-tot" data-type=""
              title="Total de ingresadas: ${active.length}${inactive ? ` (${inactive} inactivas no se cuentan)` : ''}">
        <span class="mini-card-value">${active.length}</span>
        <span class="mini-card-label">TOT</span>
      </button>
    `;

    // Re-renderizar las cards borra el resaltado: se vuelve a aplicar
    this.syncMiniCards(document.getElementById('admin-plate-filter')?.value || '');
  }

  /** Marca la mini card del tipo que está filtrando la lista. */
  syncMiniCards(typeFilter = '') {
    const box = document.getElementById('plates-mini-cards');
    if (!box) return;
    box.querySelectorAll('.mini-card').forEach(c =>
      c.classList.toggle('active', typeFilter ? c.dataset.type === typeFilter : c.dataset.type === '')
    );
  }

  renderPlates(plates) {
    const list = document.getElementById('admin-plates-list');
    if (!list) return;

    if (!plates.length) {
      list.innerHTML = '<div class="admin-empty">No hay patentes</div>';
      return;
    }

   const typeLabels = TYPE_LABELS;

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
      inputType.value = PLATE_TYPES[0].value;
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
    await this.loadPlateStats();
    await this.loadStats();
  }

  async deletePlate(id, plate) {
    const ok = await this.confirm(
      'Eliminar patente',
      `¿Seguro que quieres eliminar la patente ${plate}? Esta acción no se puede deshacer.`
    );
    if (!ok) return;

    // .select() devuelve las filas borradas: si la política RLS de DELETE
    // no existe, PostgREST borra 0 filas SIN devolver error (bug original
    // del botón 🗑️ que fallaba en silencio).
    const { data: deleted, error } = await supabase
      .from('plates')
      .delete()
      .eq('id', id)
      .select();

    if (error) {
      this.toast('Error: ' + error.message, 'error');
      return;
    }
    if (!deleted || deleted.length === 0) {
      this.toast('No se pudo eliminar: la base no permitió el borrado (falta la política RLS de DELETE)', 'error');
      return;
    }

    this.toast('Patente eliminada', 'success');
    await this.loadPlates(
      document.getElementById('admin-plate-search')?.value || '',
      document.getElementById('admin-plate-filter')?.value || ''
    );
    await this.loadPlateStats();
    await this.loadStats();
  }

  // ============================================================
  // INGRESO MASIVO POR TEXTO
  // ============================================================

  /**
   * Analiza el texto pegado. NO escribe nada en la base de datos:
   * solo arma la tabla de revisión.
   */
  async analyzeBulkText() {
    const input = document.getElementById('bulk-text');
    const text = input?.value || '';

    if (!text.trim()) {
      this.toast('Pega el texto a analizar', 'error');
      return;
    }

    const btn = document.getElementById('bulk-analyze');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Analizando...';
    }

    try {
      // 1) Análisis (100% local, no toca la base)
      this.bulkSession.analyze(text, []);

      // 2) Ver contra la base cuáles ya existen
      const plates = this.bulkSession.rows.map(r => r.plate);
      if (plates.length) {
        try {
          const existing = await findExistingPlates(plates);
          this.bulkSession.setExistingPlates(existing);
        } catch (e) {
          console.warn('[Admin] no se pudieron verificar las existentes:', e);
          this.toast('No se pudo verificar si ya existen: ' + e.message, 'error');
        }
      }

      // 3) Mostrar resultados para revisión
      this.renderBulkTable();
      this.hideBulkErrors();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔍 Analizar texto';
      }
    }
  }

  /** Dibuja la tabla de resultados. */
  renderBulkTable() {
    const body = document.getElementById('bulk-table-body');
    const results = document.getElementById('bulk-results');
    const session = this.bulkSession;
    if (!body) return;

    if (results) results.classList.toggle('hidden', !session.analyzed);

    // Con resultados en pantalla el área de texto se compacta: así el
    // resumen y el botón "Guardar" quedan visibles sin tener que scrollear.
    document.getElementById('admin-subtab-plates-bulk')
      ?.classList.toggle('bulk-results-visible', session.analyzed);

    if (!session.rows.length) {
      body.innerHTML = `<tr><td colspan="5" class="bulk-empty">${
        session.analyzed ? 'No se encontraron patentes en el texto' : ''
      }</td></tr>`;
      this.updateBulkSummary();
      return;
    }

    body.innerHTML = session.rows.map(row => this.bulkRowHtml(row)).join('');
    this.updateBulkSummary();
  }

  /** HTML de una fila de la tabla. */
  bulkRowHtml(row) {
    // Sin tipo detectado la fila ya nace con el tipo por defecto
    // (necesidades especiales): el select no ofrece "Revisión necesaria".
    const options = PLATE_TYPES.map(t =>
      `<option value="${t.value}"${row.type === t.value ? ' selected' : ''}>${t.label}</option>`
    ).join('');

    const snippet = row.snippet && row.snippet.match
      ? `<span class="bulk-snippet">${this.escapeHtml(row.snippet.before)}<mark>${this.escapeHtml(row.snippet.match)}</mark>${this.escapeHtml(row.snippet.after)}</span>`
      : '<span class="bulk-snippet bulk-muted">agregada manualmente</span>';

    return `<tr data-id="${row.id}" class="${row.include ? '' : 'bulk-row-off'}">
      <td>
        <input class="bulk-input" data-id="${row.id}" value="${this.escapeHtml(row.plateInput)}"
               placeholder="ABCD12" autocomplete="off" spellcheck="false">
      </td>
      <td><select class="bulk-select" data-id="${row.id}">${options}</select></td>
      <td>${snippet}${row.line ? `<span class="bulk-sub">línea ${row.line}</span>` : ''}</td>
      <td>${this.bulkStatusHtml(row)}</td>
      <td class="bulk-actions">${this.bulkActionsHtml(row)}</td>
    </tr>`;
  }

  /** HTML de la celda "Estado". */
  bulkStatusHtml(row) {
    const status = bulkRowStatus(row);
    const parts = [`<span class="bulk-status ${status.cls}">${status.label}</span>`];

    if (row.plateStatus === 'existing') {
      const current = this.bulkSession.existingMap.get(row.plate)?.type;
      if (current) parts.push(`<span class="bulk-sub">actual: ${this.escapeHtml(getTypeLabel(current))}</span>`);
    }

    if (row.plateStatus === 'duplicate') {
      parts.push(`<span class="bulk-sub">${row.include ? 'se guardará' : 'omitida'}</span>`);
    }

    if (row.manual) parts.push('<span class="bulk-sub">manual</span>');

    return parts.join('');
  }

  /** Botones de acción de la fila. */
  bulkActionsHtml(row) {
    const actions = [];

    if (row.doubtful) {
      actions.push(`<button class="btn-small btn-secondary" data-action="bulk-review" data-id="${row.id}" title="Marcar como revisada">✓</button>`);
    }

    if (row.plateStatus === 'duplicate') {
      const label = row.include ? 'Omitir' : 'Conservar';
      const title = row.include ? 'No guardar esta fila' : 'Guardar esta fila';
      actions.push(`<button class="btn-small btn-secondary" data-action="bulk-keep" data-id="${row.id}" title="${title}">${label}</button>`);
    }

    if (row.plateStatus === 'existing') {
      actions.push(`<button class="btn-small btn-secondary" data-action="bulk-update" data-id="${row.id}" title="Actualizar el tipo del registro existente">Actualizar</button>`);
    }

    actions.push(`<button class="btn-small btn-danger" data-action="bulk-remove" data-id="${row.id}" title="Eliminar fila">🗑</button>`);

    return actions.join('');
  }

  /** Actualiza solo la celda de estado de una fila (sin re-dibujar todo). */
  updateBulkRowStatus(id) {
    const row = this.bulkSession.get(id);
    if (!row) return;
    const tr = document.querySelector(`#bulk-table-body tr[data-id="${id}"]`);
    const cell = tr?.cells?.[3];
    if (!cell) return;
    cell.innerHTML = this.bulkStatusHtml(row);
    tr.classList.toggle('bulk-row-off', !row.include);
  }

  /** Resumen + estado del botón "Guardar patentes". */
  updateBulkSummary() {
    const el = document.getElementById('bulk-summary');
    const saveBtn = document.getElementById('bulk-save');
    const session = this.bulkSession;
    if (!el) return;

    if (!session.analyzed) {
      el.innerHTML = '';
      if (saveBtn) saveBtn.disabled = true;
      return;
    }

    const { summary } = session.validate();
    const chips = [];

    if (summary.ready) chips.push(`<span class="bulk-chip ok">${summary.ready} lista${summary.ready === 1 ? '' : 's'} para guardar</span>`);
    if (summary.review) chips.push(`<span class="bulk-chip warn">${summary.review} requiere${summary.review === 1 ? '' : 'n'} revisión</span>`);

    // Píldora clicable de limpieza: al presionarla se ELIMINAN las
    // duplicadas Y las que ya existen en la base, dejando la lista limpia
    // antes de guardar.
    if (summary.duplicate || summary.existing) {
      const detalle = [];
      if (summary.duplicate) {
        detalle.push(`${summary.duplicate} duplicada${summary.duplicate === 1 ? '' : 's'}`);
      }
      if (summary.existing) {
        detalle.push(`${summary.existing} ya existe${summary.existing === 1 ? '' : 'n'}`);
      }
      chips.push(
        `<button type="button" class="bulk-chip dup bulk-chip-btn" id="bulk-dedup" ` +
        `title="Eliminar las duplicadas y las que ya existen en la base (deja la lista limpia antes de guardar)">` +
        `${detalle.join(' · ')} — clic para eliminar</button>`
      );
    }

    if (summary.invalid) chips.push(`<span class="bulk-chip err">${summary.invalid} inválida${summary.invalid === 1 ? '' : 's'}</span>`);

    el.innerHTML = `
      <div class="bulk-summary-title">Se encontraron ${summary.total} patente${summary.total === 1 ? '' : 's'}</div>
      <div class="bulk-chips">${chips.join('') || '<span class="bulk-chip">Nada listo para guardar todavía</span>'}</div>
      ${summary.discarded ? `<div class="bulk-summary-note">${summary.discarded} token(s) ignorados por formato inválido</div>` : ''}
    `;

    // El botón se habilita después del análisis (pide confirmación al guardar).
    if (saveBtn) saveBtn.disabled = session.rows.length === 0;
  }

  /** Muestra los errores de validación de las filas. */
  showBulkErrors(messages = []) {
    const box = document.getElementById('bulk-errors');
    if (!box) return;
    if (!messages.length) {
      this.hideBulkErrors();
      return;
    }
    box.innerHTML = messages
      .map(m => `<div class="bulk-error-line">• ${this.escapeHtml(m.message || m)}</div>`)
      .join('');
    box.classList.remove('hidden');
  }

  hideBulkErrors() {
    document.getElementById('bulk-errors')?.classList.add('hidden');
  }

  /** Agrega una fila manual a la tabla. */
  addBulkRow() {
    const row = this.bulkSession.addManualRow();
    this.renderBulkTable();
    const input = document.querySelector(`#bulk-table-body tr[data-id="${row.id}"] .bulk-input`);
    input?.focus();
  }

  /** Limpia el editor masivo. */
  clearBulk() {
    this.bulkSession.reset();
    const text = document.getElementById('bulk-text');
    if (text) text.value = '';
    this.hideBulkErrors();
    this.renderBulkTable();
  }

  /**
   * Limpia el lote (píldora "N duplicadas · M ya existen"):
   * elimina las duplicadas (conserva la primera) y las que ya existen
   * en la base de datos.
   */
  removeBulkDuplicates() {
    const { removed, duplicates, existing } = this.bulkSession.removeDuplicates();
    if (!removed) {
      this.toast('No hay nada para limpiar', 'error');
      return;
    }
    this.renderBulkTable();
    const detalle = [];
    if (duplicates) detalle.push(`${duplicates} duplicada${duplicates === 1 ? '' : 's'}`);
    if (existing) detalle.push(`${existing} ya existente${existing === 1 ? '' : 's'}`);
    this.toast(`${detalle.join(' y ')} eliminada${removed === 1 ? '' : 's'}`, 'success');
  }

  /** Extrae la patente mencionada en un error de la base de datos. */
  extractPlateFromError(message = '') {
    const match = String(message).match(/\b([A-Z]{2,4}[0-9]{2,4})\b/);
    return match ? match[1] : null;
  }

  /**
   * Guarda las patentes revisadas con un ÚNICO INSERT (atómico en Postgres:
   * si una fila falla, no se guarda ninguna).
   */
  async saveBulkPlates() {
    const session = this.bulkSession;
    const { errors, warnings, toSave, summary } = session.validate();

    if (!toSave.length) {
      this.showBulkErrors(errors.length ? errors : warnings);
      this.toast(errors[0]?.message || 'No hay patentes listas para guardar', 'error');
      return;
    }

    // Filas con problemas: se informan y no se guardan.
    if (errors.length) this.showBulkErrors(errors);
    else this.hideBulkErrors();

    const lines = [
      `Se encontraron ${summary.total} patente${summary.total === 1 ? '' : 's'}`,
      `• ${summary.ready} lista${summary.ready === 1 ? '' : 's'} para guardar`,
    ];
    if (summary.review) lines.push(`• ${summary.review} requieren revisión (no se guardan)`);
    if (summary.duplicate) lines.push(`• ${summary.duplicate} duplicada${summary.duplicate === 1 ? '' : 's'} (no se guardan)`);
    if (summary.existing) lines.push(`• ${summary.existing} ya existen (no se guardan)`);
    if (summary.invalid) lines.push(`• ${summary.invalid} inválida${summary.invalid === 1 ? '' : 's'} (no se guardan)`);
    lines.push('');
    lines.push(`¿Guardar ${summary.ready} patente${summary.ready === 1 ? '' : 's'}?`);

    const confirmed = await this.confirm('Guardar patentes', lines.join('\n'));
    if (!confirmed) return;

    const btn = document.getElementById('bulk-save');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Guardando...';
    }

    let payload = [];
    try {
      const { data } = await supabase.auth.getUser();
      payload = session.buildPayload(data?.user?.id);
      await insertBulkPlates(supabase, payload);
    } catch (e) {
      console.error('[Admin] error guardandoPatentes masivas:', e);
      this.toast('No se guardó ninguna patente. ' + e.message, 'error');
      const plate = this.extractPlateFromError(e.message);
      if (plate) {
        session.markExisting(plate);
        this.renderBulkTable();
      }
      return;
    } finally {
      if (btn) btn.textContent = '💾 Guardar patentes';
      this.updateBulkSummary();
    }

    this.toast(`${payload.length} patente${payload.length === 1 ? '' : 's'} guardada${payload.length === 1 ? '' : 's'}`, 'success');
    this.clearBulk();
    await this.loadPlates(
      document.getElementById('admin-plate-search')?.value || '',
      document.getElementById('admin-plate-filter')?.value || ''
    );
    await this.loadPlateStats();
    await this.loadStats();
  }

  /** Actualiza el tipo de una patente que ya existe en el sistema. */
  async updateExistingBulkPlate(id) {
    const row = this.bulkSession.get(id);
    if (!row) return;

    if (!row.type) {
      this.toast('Selecciona el tipo antes de actualizar', 'error');
      return;
    }

    const current = this.bulkSession.existingMap.get(row.plate)?.type;
    const ok = await this.confirm(
      'Actualizar patente existente',
      `La patente ${row.plate} ya existe en el sistema.\n` +
      `Tipo actual: ${current ? getTypeLabel(current) : 'sin tipo'}\n` +
      `¿Actualizarla a "${getTypeLabel(row.type)}"?`
    );
    if (!ok) return;

    const { error } = await supabase
      .from('plates')
      .update({ type: row.type })
      .eq('plate', row.plate);

    if (error) {
      this.toast('Error: ' + error.message, 'error');
      return;
    }

    const entry = this.bulkSession.existingMap.get(row.plate);
    if (entry) entry.type = row.type;

    this.toast('Patente actualizada', 'success');
    this.renderBulkTable();
    await this.loadPlates(
      document.getElementById('admin-plate-search')?.value || '',
      document.getElementById('admin-plate-filter')?.value || ''
    );
    await this.loadPlateStats();
    await this.loadStats();
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
          await this.loadRecentScans();
        } else if (target === 'users') {
          // El tab unifica registrados y flotantes (accesos): cargar ambos.
          await this.loadUsers();
          await this.loadWhitelist();
        } else if (target === 'plates') {
          await this.loadPlates();
          await this.loadPlateStats();
        }
        // (La pestaña Escaneos se eliminó: esa info vive en Home)
      };
    });

    // Sub-tabs dentro de una pestaña (Registrados/Flotantes,
    // Individual/Masivo): muestran/ocultan sin recargar nada.
    document.querySelectorAll('.admin-subtab').forEach(btn => {
      btn.addEventListener('click', () => {
        const parent = btn.closest('.admin-tab-content');
        if (!parent) return;
        parent.querySelectorAll('.admin-subtab').forEach(b => b.classList.toggle('active', b === btn));
        parent.querySelectorAll('.admin-subtab-content').forEach(c => {
          c.classList.toggle('active', c.id === `admin-subtab-${btn.dataset.subtab}`);
        });
        // Al abrir Flotantes se refresca la lista unificada
        if (btn.dataset.subtab === 'users-floating') this.loadWhitelist();
      });
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

    // Mini cards: al tocarlas filtran la lista por ese tipo
    const miniCards = document.getElementById('plates-mini-cards');
    if (miniCards) {
      miniCards.addEventListener('click', (e) => {
        const card = e.target.closest('.mini-card');
        if (!card) return;
        const type = card.dataset.type;
        const current = plateFilter?.value || '';
        const next = current === type ? '' : type;
        if (plateFilter) plateFilter.value = next;
        this.syncMiniCards(next);
        this.loadPlates(plateSearch?.value || '', next);
      });
    }

    // (La pestaña Escaneos fue eliminada: la info está en Home)

    // Botón "Agregar patente"
    const addPlate = document.getElementById('admin-add-plate');
    if (addPlate) {
      addPlate.addEventListener('click', () => this.openPlateModal());
    }

    // ============================================================
    // Ingreso masivo por texto
    // ============================================================
    const bulkAnalyze = document.getElementById('bulk-analyze');
    if (bulkAnalyze) {
      bulkAnalyze.addEventListener('click', () => this.analyzeBulkText());
    }
    const bulkClear = document.getElementById('bulk-clear');
    if (bulkClear) {
      bulkClear.addEventListener('click', () => this.clearBulk());
    }
    const bulkAddRow = document.getElementById('bulk-add-row');
    if (bulkAddRow) {
      bulkAddRow.addEventListener('click', () => this.addBulkRow());
    }
    const bulkSave = document.getElementById('bulk-save');
    if (bulkSave) {
      bulkSave.addEventListener('click', () => this.saveBulkPlates());
    }

    // Píldora de duplicados del resumen: la presionan y se eliminan.
    const bulkSummary = document.getElementById('bulk-summary');
    if (bulkSummary) {
      bulkSummary.addEventListener('click', (e) => {
        if (e.target.closest('#bulk-dedup')) this.removeBulkDuplicates();
      });
    }

    const bulkBody = document.getElementById('bulk-table-body');
    if (bulkBody) {
      // Edición directa de la patente (sin re-dibujar la tabla)
      bulkBody.addEventListener('input', (e) => {
        const input = e.target.closest('.bulk-input');
        if (!input) return;
        this.bulkSession.updatePlate(input.dataset.id, input.value);
        this.updateBulkRowStatus(input.dataset.id);
        this.updateBulkSummary();
      });

      // Cambio de tipo
      bulkBody.addEventListener('change', (e) => {
        const select = e.target.closest('.bulk-select');
        if (!select) return;
        this.bulkSession.updateType(select.dataset.id, select.value);
        this.updateBulkRowStatus(select.dataset.id);
        this.updateBulkSummary();
      });

      // Acciones por fila
      bulkBody.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const id = btn.dataset.id;
        const action = btn.dataset.action;

        if (action === 'bulk-remove') {
          this.bulkSession.removeRow(id);
          this.renderBulkTable();
        } else if (action === 'bulk-review') {
          this.bulkSession.markReviewed(id);
          this.renderBulkTable();
        } else if (action === 'bulk-keep') {
          const row = this.bulkSession.get(id);
          if (!row) return;
          this.bulkSession.setInclude(id, !row.include);
          this.renderBulkTable();
        } else if (action === 'bulk-update') {
          await this.updateExistingBulkPlate(id);
        }
      });
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
        // Tab de accesos (lista unificada de flotantes)
    document.getElementById('admin-add-access')?.addEventListener('click', () => this.openAccessModal());
    document.getElementById('admin-access-save')?.addEventListener('click', () => this.saveAccess());
    document.getElementById('admin-access-cancel')?.addEventListener('click', () => {
      this._editingAccessId = null;
      document.getElementById('admin-access-modal')?.classList.add('hidden');
    });
    // Enter en el modal de acceso = guardar
    document.getElementById('admin-access-name')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.saveAccess(); }
    });

    // Ajustes (logout automático): abre el modal con el valor actual
    document.getElementById('admin-settings-btn')?.addEventListener('click', async () => {
      await this.loadTimeoutConfig();
      document.getElementById('admin-settings-modal')?.classList.remove('hidden');
      document.getElementById('admin-timeout-input')?.focus();
    });
    document.getElementById('admin-settings-cancel')?.addEventListener('click', () => {
      document.getElementById('admin-settings-modal')?.classList.add('hidden');
    });
    document.getElementById('admin-timeout-save')?.addEventListener('click', () => this.saveTimeoutConfig());

    // Checkbox "Activar todos"
    document.getElementById('admin-check-all')?.addEventListener('change', (e) => {
      this.setAllActive(e.target.checked);
    });

    // Delegación de acciones de la lista unificada de flotantes
    document.getElementById('view-admin')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'force-logout') {
        await this.forceLogout(btn.dataset.name);
      } else if (action === 'remove-access') {
        await this.removeAccess(btn.dataset.id, btn.dataset.name);
      } else if (action === 'toggle-active') {
        await this.toggleActive(btn.dataset.id, btn.checked);
      } else if (action === 'row-menu') {
        // Muestra/oculta los botones Editar y Borrar de la fila
        const row = btn.closest('.pill-row');
        row?.querySelector('.pill-actions')?.classList.toggle('hidden');
      } else if (action === 'edit-access') {
        const row = btn.closest('.pill-row');
        if (row) this.openAccessModal({ id: row.dataset.id, name: row.dataset.name });
      }
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