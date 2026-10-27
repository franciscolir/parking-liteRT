/**
 * guest-auth.js - Sistema de autenticación para usuarios flotantes
 *
 * Modelo:
 *   - Admin: usa Supabase Auth (email + password)
 *   - Flotante: solo ingresa un nombre de la whitelist
 *
 * Persistencia:
 *   - localStorage: { name, session_token, started_at }
 *   - active_sessions (Supabase): valida contra timeout
 */

import { supabase } from './supabase-client.js';

const STORAGE_KEY = 'platedetect_guest_session';
const HEARTBEAT_MS = 60 * 1000;      // 60s
const TIMEOUT_DEFAULT = 30;          // minutos

export class GuestAuth {
  constructor() {
    this.session = null;              // { name, session_token }
    this.heartbeatTimer = null;
    this.timeoutMinutes = TIMEOUT_DEFAULT;
    this.onExpired = null;            // callback cuando se expira la sesión
  }

  // ============================================================
  // INICIALIZACIÓN
  // ============================================================
  async init() {
    // 1. Leer sesión guardada
    const saved = this.loadFromStorage();

    if (saved?.name && saved?.session_token) {
      // 2. Validar contra el backend (puede haber expirado)
      const valid = await this.touchSession(saved.name, saved.session_token);
      if (valid) {
        this.session = saved;
        this.startHeartbeat();
        return { ok: true, session: saved };
      }
      // Sesión expirada o inválida
      this.clearStorage();
    }

    return { ok: false };
  }

  // ============================================================
  // LOGIN
  // ============================================================
  async login(name) {
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return { ok: false, error: 'Ingresa un nombre' };
    }
    if (cleanName.length < 2) {
      return { ok: false, error: 'El nombre debe tener al menos 2 caracteres' };
    }
    if (cleanName.length > 32) {
      return { ok: false, error: 'El nombre no puede tener más de 32 caracteres' };
    }

    const { data, error } = await supabase.rpc('validate_and_start_session', {
      p_name: cleanName,
    });

    if (error) {
      console.error('[GuestAuth] login error:', error);
      return { ok: false, error: 'Error de conexión. Intenta de nuevo.' };
    }

    if (!data?.ok) {
      return { ok: false, error: data?.error || 'No autorizado' };
    }

    // Guardar sesión
    this.session = {
      name: data.name,
      session_token: data.session_token,
      started_at: new Date().toISOString(),
    };
    this.saveToStorage(this.session);
    this.startHeartbeat();

    return { ok: true, session: this.session };
  }

  // ============================================================
  // LOGOUT
  // ============================================================
  async logout() {
    if (!this.session) {
      this.clearStorage();
      return { ok: true };
    }

    try {
      await supabase.rpc('end_session', {
        p_name: this.session.name,
        p_session_token: this.session.session_token,
      });
    } catch (e) {
      console.warn('[GuestAuth] logout error:', e);
    }

    this.stopHeartbeat();
    this.clearStorage();
    this.session = null;
    return { ok: true };
  }

  // ============================================================
  // HEARTBEAT
  // ============================================================
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (!this.session) return;

      const ok = await this.touchSession(this.session.name, this.session.session_token);
      if (!ok) {
        console.warn('[GuestAuth] Sesión expirada o revocada');
        this.stopHeartbeat();
        this.clearStorage();
        this.session = null;
        this.onExpired?.();
      }
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async touchSession(name, token) {
    const { data, error } = await supabase.rpc('touch_session', {
      p_name: name,
      p_session_token: token,
    });

    if (error) {
      console.warn('[GuestAuth] touch error:', error);
      return false;
    }

    return data?.ok === true;
  }

  // ============================================================
  // STORAGE
  // ============================================================
  loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  saveToStorage(session) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch (e) {
      console.warn('[GuestAuth] save error:', e);
    }
  }

  clearStorage() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }

  // ============================================================
  // GETTERS
  // ============================================================
  get isAuthenticated() {
    return !!this.session;
  }

  get displayName() {
    return this.session?.name || '';
  }
}

// Instancia global (para usar desde app-supabase.js y admin.js)
export const guestAuth = new GuestAuth();