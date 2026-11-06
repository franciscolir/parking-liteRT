/**
 * Supabase Client para PlateDetect
 * Configuración y helpers de base de datos
 */

import { SUPABASE_CONFIG } from './supabase-config.js';
import { normalizePlate } from './validator.js';
import { normalizeEmergencyContacts } from './emergency-contacts.js';

// supabase-js viene como script UMD clásico (vendor/supabase.js) y se carga en
// index.html ANTES del módulo ES, así que globalThis.supabase ya existe acá.
const { createClient } = globalThis.supabase || {};
if (typeof createClient !== 'function') {
  throw new Error('[Supabase] globalThis.supabase no existe: falta <script src="./vendor/supabase.js"> en index.html');
}

export const supabase = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  },
  realtime: {
    params: { eventsPerSecond: 10 }
  }
});

// ============================================================
// HELPERS DE AUTENTICACIÓN
// ============================================================

export async function signUp(email, password, fullName) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName } }
  });
  return { data, error };
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return { data, error };
}

export async function signInWithOAuth(provider) {
  const { data, error } = await supabase.auth.signInWithOAuth({ provider });
  return { data, error };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  return { error };
}

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange(callback);
}

// ============================================================
// HELPERS DE PATENTES (plates)
// ============================================================

// ------------------------------------------------------------
// SESIÓN FLOTANTE (modo invitado)
// ------------------------------------------------------------
// Los flotantes no usan Supabase Auth: su sesión es un nombre de
// la whitelist + un token uuid (ver guest-auth.js).
//
// Para que las patentes y los contactos de emergencia NO sean
// públicos, el acceso del flotante va por RPCs que validan ese
// token contra la sesión activa. El admin (Supabase Auth) sigue
// leyendo las tablas directamente con su sesión.
let flotanteSession = null;

export function setFlotanteSession(session) {
  flotanteSession = session && session.session_token ? session : null;
}

export function getFlotanteSession() {
  return flotanteSession;
}

/** ¿Hay un usuario de Supabase Auth (admin)? Solo lee la sesión local. */
async function haySesionAdmin() {
  const { data } = await supabase.auth.getSession();
  return !!data?.session?.user;
}

/** ¿Estamos en modo flotante? (sesión flotante y sin admin) */
async function esFlotante() {
  if (!flotanteSession) return false;
  return !(await haySesionAdmin());
}

/**
 * ¿El error es "esa función no existe"?
 * Sirve para el despliegue gradual: mientras la migración SQL de
 * "datos solo con login" no esté aplicada, el flotante cae a la
 * ruta vieja (lectura directa) en vez de quedarse sin datos.
 */
function esErrorDeFuncionInexistente(error) {
  if (!error) return false;
  const code = error.code || '';
  const msg = String(error.message || '').toLowerCase();
  return code === 'PGRST202' || code === 'PGRST205' || code === '42883'
    || msg.includes('could not find the function')
    || msg.includes('does not exist');
}

export async function lookupPlate(plate) {
  const p = plate.toUpperCase();

  if (await esFlotante()) {
    const { data, error } = await supabase.rpc('flotante_lookup_plate', {
      p_plate: p,
      p_name: flotanteSession.name,
      p_session_token: flotanteSession.session_token,
    });
    if (!error) return data?.[0] || null;
    if (!esErrorDeFuncionInexistente(error)) throw error;
    // La migración todavía no está aplicada → ruta legacy.
  }

  const { data, error } = await supabase.rpc('lookup_plate', { p_plate: p });
  if (error) throw error;
  return data?.[0] || null;
}

export async function getPlates({ type, search, limit = 100, offset = 0 } = {}) {
  if (await esFlotante()) {
    const { data, error } = await supabase.rpc('flotante_plates', {
      p_name: flotanteSession.name,
      p_session_token: flotanteSession.session_token,
      p_type: type || null,
      p_limit: limit,
    });
    if (!error) return data || [];
    if (!esErrorDeFuncionInexistente(error)) throw error;
  }

  let query = supabase
    .from('plates')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (type) query = query.eq('type', type);
  if (search) query = query.ilike('plate', `%${search.toUpperCase()}%`);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Búsqueda parcial de patentes (modo Manual de la vista unificada).
 *
 * Usa `ilike` para coincidencia parcial (ej. "AB" finds "AB123" and
 * "XAB9"), ordena por patente y limita la cantidad de resultados.
 * Solo lee patentes activas.
 *
 * El flotante va por su RPC (valida la sesión); el admin lee la
 * tabla con su sesión de Supabase.
 *
 * @param {{search?: string, limit?: number}} opts
 * @returns {Promise<Array<{plate:string,type:string,vehicle_type?:string,owner_name?:string}>>}
 */
export async function searchPlates({ search, limit = 30 } = {}) {
  // Solo letras, números y espacios: sin comodines de SQL ('%', '_').
  const q = String(search || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
  if (!q) return [];

  if (await esFlotante()) {
    const { data, error } = await supabase.rpc('flotante_search_plates', {
      p_search: q,
      p_name: flotanteSession.name,
      p_session_token: flotanteSession.session_token,
      p_limit: limit,
    });
    if (!error) return data || [];
    if (!esErrorDeFuncionInexistente(error)) throw error;
  }

  const { data, error } = await supabase
    .from('plates')
    .select('plate,type,vehicle_type,owner_name,is_active')
    .eq('is_active', true)
    .ilike('plate', `%${q}%`)
    .order('plate', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

/**
 * Busca qué de las patentes indicadas ya existen en la base de datos.
 * Se usa en el ingreso masivo por texto para marcar "Ya existente".
 * Devuelve [{ plate, type, is_active }] solo con las que coinciden.
 *
 * @param {Array<string|{plate:string}>} plates
 * @returns {Promise<Array<{plate:string,type:string,is_active:boolean}>>}
 */
export async function findExistingPlates(plates = []) {
  const list = [...new Set(
    (plates || [])
      .map(p => normalizePlate(typeof p === 'string' ? p : p?.plate || ''))
      .filter(Boolean)
  )];

  if (!list.length) return [];

  const { data, error } = await supabase
    .from('plates')
    .select('plate,type,is_active')
    .in('plate', list);

  if (error) throw error;
  return data || [];
}

export async function reportPlate(plateData) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('plates')
    .insert({
      ...plateData,
      plate: plateData.plate.toUpperCase().replace(/[^A-Z0-9]/g, ''),
      reported_by: user?.id
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updatePlate(id, updates) {
  const { data, error } = await supabase
    .from('plates')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deactivatePlate(id) {
  return updatePlate(id, { is_active: false });
}

export function subscribeToPlates(callback) {
  return supabase
    .channel('plates_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'plates' }, callback)
    .subscribe();
}

// ============================================================
// HELPERS DE HISTORIAL (scan_history)
// ============================================================

export async function saveScan(scanData) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('scan_history')
    .insert({
      ...scanData,
      user_id: user?.id || null,
      plate: scanData.plate.toUpperCase()
    })
    .select()
    .single();
  if (error) throw error;

  // Actualizar stats atómicamente
  if (user?.id) {
    await supabase.rpc('increment_scan_stat', {
      p_user_id: user.id,
      p_status: scanData.status
    });
  }
  return data;
}

export async function getScanHistory({ userId, limit = 20, offset = 0 } = {}) {
  let query = supabase
    .from('scan_history')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (userId) query = query.eq('user_id', userId);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getScanStats(userId) {
  const { data, error } = await supabase
    .from('scan_stats')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle(); 
  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
  return data || { total_scans: 0, registered_count: 0, stolen_count: 0, unknown_count: 0 };
}

export function subscribeToScanHistory(userId, callback) {
  return supabase
    .channel(`scan_history_${userId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'scan_history',
      filter: `user_id=eq.${userId}`
    }, callback)
    .subscribe();
}

// ============================================================
// HELPERS DE CONTACTOS (contacts)
// ============================================================

export async function getContacts(userId) {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('user_id', userId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function addContact(contactData) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('No autenticado');

  const { data, error } = await supabase
    .from('contacts')
    .insert({ ...contactData, user_id: user.id })
    .select()
    .maybeSingle(); 
  if (error) throw error;
  return data;
}

export async function updateContact(id, updates) {
  const { data, error } = await supabase
    .from('contacts')
    .update(updates)
    .eq('id', id)
    .select()
    .maybeSingle(); 
  if (error) throw error;
  return data;
}

export async function deleteContact(id) {
  const { error } = await supabase
    .from('contacts')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ============================================================
// HELPERS DE NÚMEROS POR DEFECTO (app_settings → emergency_contacts)
// ------------------------------------------------------------
// Los 5 contactos por defecto de la vista Llamadas son globales:
// el admin los edita una vez y todos los usuarios (y invitados)
// ven los mismos números. Se guardan como array JSON en la tabla
// app_settings, que es legible sin sesión y escribible por admin.
// ============================================================

export async function getEmergencyContacts() {
  // El flotante no puede leer app_settings directamente (queda cerrado
  // a anónimos): usa su RPC, que valida la sesión.
  if (await esFlotante()) {
    const { data, error } = await supabase.rpc('flotante_emergency_contacts', {
      p_name: flotanteSession.name,
      p_session_token: flotanteSession.session_token,
    });
    if (!error) return normalizeEmergencyContacts(data);
    if (!esErrorDeFuncionInexistente(error)) throw error;
    // Migración SQL aún no aplicada → sigue la lectura directa.
  }

  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'emergency_contacts')
    .maybeSingle();
  if (error) throw error;
  return normalizeEmergencyContacts(data?.value);
}

export async function saveEmergencyContacts(list) {
  const { error } = await supabase
    .from('app_settings')
    .upsert({
      key: 'emergency_contacts',
      value: list,
      updated_at: new Date().toISOString(),
    });
  if (error) throw error;
}

// ============================================================
// NÚMERO DESTINO DE REPORTES (app_settings → office_phone)
// ------------------------------------------------------------
// El campo de la vista Llamadas ALMACENA el número destino tipo
// 'office': es global (app_settings) y lo usan los reportes de
// incidente que manda `sendWhatsAppReport()`. El admin lo edita una
// vez y todos los equipos ven lo mismo.
// ============================================================

/** Normaliza el valor leído de app_settings a un string de teléfono. */
export function normalizeOfficePhone(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

/** Lee el número destino. Sin sesión flotante ni permiso → ''. */
export async function getOfficePhone() {
  // El flotante no puede leer app_settings (queda cerrado a anónimos):
  // usa su RPC, que valida el token de sesión.
  if (await esFlotante()) {
    const { data, error } = await supabase.rpc('flotante_office_phone', {
      p_name: flotanteSession.name,
      p_session_token: flotanteSession.session_token,
    });
    if (!error) return normalizeOfficePhone(data);
    if (!esErrorDeFuncionInexistente(error)) throw error;
    // Migración SQL aún no aplicada → sigue la lectura directa.
  }

  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'office_phone')
      .maybeSingle();
    if (error) throw error;
    return normalizeOfficePhone(data?.value);
  } catch {
    // Sin permiso de lectura (anónimo): el reporte cae al contacto 'office'.
    return '';
  }
}

/** Guarda el número destino (solo admin: RLS de app_settings). */
export async function saveOfficePhone(value) {
  const phone = normalizeOfficePhone(value);
  const { error } = await supabase
    .from('app_settings')
    .upsert({
      key: 'office_phone',
      value: phone,
      updated_at: new Date().toISOString(),
    });
  if (error) throw error;
  return phone;
}

export function subscribeToContacts(userId, callback) {
  return supabase
    .channel(`contacts_${userId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'contacts',
      filter: `user_id=eq.${userId}`
    }, callback)
    .subscribe();
}

// ============================================================
// HELPERS DE USUARIO (users/profile)
// ============================================================

export async function getProfile(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle(); 
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

export async function updateProfile(updates) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('No autenticado');

  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', user.id)
    .select()
    .maybeSingle(); 
  if (error) throw error;
  return data;
}

export async function uploadAvatar(file) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('No autenticado');

  const fileExt = file.name.split('.').pop();
  const fileName = `${user.id}/avatar.${fileExt}`;

  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(fileName, file, { upsert: true });

  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from('avatars').getPublicUrl(fileName);
  await updateProfile({ avatar_url: data.publicUrl });

  return data.publicUrl;
}

// ============================================================
// STORAGE: Imágenes de escaneos
// ============================================================

export async function uploadScanImage(file, scanId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('No autenticado');

  const fileExt = file.name.split('.').pop();
  const fileName = `${user.id}/${scanId}.${fileExt}`;

  const { error } = await supabase.storage
    .from('scan-images')
    .upload(fileName, file, { upsert: true });

  if (error) throw error;

  const { data } = supabase.storage.from('scan-images').getPublicUrl(fileName);
  return data.publicUrl;
}

export async function getScanImageUrl(scanId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = supabase.storage
    .from('scan-images')
    .getPublicUrl(`${user.id}/${scanId}.jpg`);

  return data.publicUrl;
}

// ============================================================
// UTILIDADES
// ============================================================

export function isAuthenticated() {
  return supabase.auth.getUser().then(({ data: { user } }) => !!user);
}

export function getUserId() {
  return supabase.auth.getUser().then(({ data: { user } }) => user?.id || null);
}

// Exportar tipos para TypeScript (opcional)
export const PlateType = {
  SPECIAL_NEEDS: 'special_needs',
  ADMINISTRATION: 'administration',
  FIRST_AID: 'first_aid',
};

export const ScanStatus = {
  SPECIAL_NEEDS: 'special_needs',
  ADMINISTRATION: 'administration',
  FIRST_AID: 'first_aid',
  UNKNOWN: 'unknown',
  ERROR: 'error',
};

export const ContactType = {
  POLICE: 'police',
  FIRE: 'fire',
  EMERGENCY: 'emergency',
  OFFICE: 'office',
  CUSTOM: 'custom'
};