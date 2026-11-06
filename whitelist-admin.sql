-- ============================================================
-- whitelist-admin.sql
-- Ejecutar en Supabase → SQL Editor (una sola vez)
--
-- Agrega las funciones que la app usa para:
--   1) Activar / desactivar nombres de la whitelist
--   2) Editar un nombre de la whitelist
--   3) Consultar si un nombre está desactivado (login de flotantes)
--   4) Normaliza los nombres existentes a MAYÚSCULAS
--   5) Número destino de reportes (office_phone) para flotantes
-- ============================================================

-- ------------------------------------------------------------
-- 0) Normalizar whitelist a MAYÚSCULAS
--    (importante: el login ahora envía todo en mayúsculas)
-- ------------------------------------------------------------
update public.name_whitelist
   set allowed_name = upper(allowed_name),
       updated_at   = now()
 where allowed_name is distinct from upper(allowed_name);

-- ------------------------------------------------------------
-- 1) Activar / desactivar un nombre (checkbox por fila)
--    set_whitelist_active(uuid, boolean)
-- ------------------------------------------------------------
create or replace function public.set_whitelist_active(p_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'admin') then
    return jsonb_build_object('ok', false, 'error', 'Solo admin puede hacer esto');
  end if;

  update public.name_whitelist
     set is_active  = p_active,
         updated_at = now()
   where id = p_id
     and is_active is distinct from p_active;

  get diagnostics v_count = row_count;

  if v_count = 0 then
    -- Puede ser que el valor ya fuera el mismo → no es error real
    if exists (select 1 from public.name_whitelist where id = p_id) then
      return jsonb_build_object('ok', true);
    end if;
    return jsonb_build_object('ok', false, 'error', 'Nombre no encontrado');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- ------------------------------------------------------------
-- 2) Editar un nombre de la whitelist (siempre en MAYÚSCULAS)
--    update_whitelist_entry(uuid, text)
-- ------------------------------------------------------------
create or replace function public.update_whitelist_entry(p_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if not exists (select 1 from public.users where id = auth.uid() and role = 'admin') then
    return jsonb_build_object('ok', false, 'error', 'Solo admin puede hacer esto');
  end if;

  v_name := upper(trim(p_name));

  if v_name is null or length(v_name) < 2 then
    return jsonb_build_object('ok', false, 'error', 'Mínimo 2 caracteres');
  end if;

  if length(v_name) > 32 then
    return jsonb_build_object('ok', false, 'error', 'Máximo 32 caracteres');
  end if;

  begin
    update public.name_whitelist
       set allowed_name = v_name,
           updated_at   = now()
     where id = p_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'Ese nombre ya existe');
  end;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'Nombre no encontrado');
  end if;

  return jsonb_build_object('ok', true, 'name', v_name);
end;
$$;

-- ------------------------------------------------------------
-- 3) ¿Está el nombre desactivado? (lo consulta el login guest)
--    Devuelve { ok: true, active: false } SOLO si existe una fila
--    con is_active = false. Si el nombre no existe, devuelve
--    active: true para que decida validate_and_start_session.
-- ------------------------------------------------------------
create or replace function public.is_name_active(p_name text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'ok', true,
    'active', not exists (
      select 1
        from public.name_whitelist
       where upper(allowed_name) = upper(trim(p_name))
         and is_active = false
    )
  );
$$;

-- ------------------------------------------------------------
-- 3b) Whitelist con el flag is_active (la usa el panel admin)
-- ------------------------------------------------------------
create or replace function public.get_whitelist_active()
returns table (id uuid, allowed_name text, is_active boolean)
language sql
stable
security definer
set search_path = public
as $$
  select w.id, w.allowed_name, coalesce(w.is_active, true) as is_active
    from public.name_whitelist w
   order by w.allowed_name;
$$;

-- ------------------------------------------------------------
-- 4) Permisos de ejecución
-- ------------------------------------------------------------
grant execute on function public.set_whitelist_active(uuid, boolean) to authenticated;
grant execute on function public.update_whitelist_entry(uuid, text) to authenticated;
grant execute on function public.is_name_active(text) to anon, authenticated;
grant execute on function public.get_whitelist_active() to authenticated;

-- ------------------------------------------------------------
-- 5) Número destino de reportes (app_settings → office_phone)
--    El campo de la vista Llamadas ALMACENA este número y lo usa
--    sendWhatsAppReport(). El flotante no puede leer app_settings
--    directo: su RPC (con token de sesión) le devuelve el valor
--    global.
-- ------------------------------------------------------------
create or replace function public.flotante_office_phone(
  p_name text,
  p_session_token uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_ok boolean;
  v_value text;
begin
  v := to_jsonb(public.touch_session(p_name, p_session_token));
  v_ok := case
    when jsonb_typeof(v) = 'object' then coalesce((v ->> 'ok')::boolean, false)
    when jsonb_typeof(v) = 'boolean' then coalesce((v #>> '{}')::boolean, false)
    when jsonb_typeof(v) = 'array' and jsonb_array_length(v) > 0
      then coalesce((v -> 0 ->> 'ok')::boolean, false)
    else false
  end;
  if not v_ok then
    raise exception 'Sesión flotante no válida o expirada';
  end if;

  select case when jsonb_typeof(a.value) = 'string'
              then a.value #>> '{}'
              else null end
    into v_value
    from public.app_settings a
   where a.key = 'office_phone';

  return coalesce(v_value, '');
end;
$$;

grant execute on function public.flotante_office_phone(text, uuid) to anon, authenticated;

-- ============================================================
-- (OPCIONAL, recomendado) Bloquear en el servidor el login de
-- nombres inactivos también dentro de validate_and_start_session.
--
-- Primero mira la definición actual:
--   select pg_get_functiondef(oid)
--     from pg_proc
--    where proname = 'validate_and_start_session';
--
-- Y agrégale una condición extra a la búsqueda del nombre en la
-- whitelist, por ejemplo:
--
--   ... and (w.is_active is not false) ...
--
-- La app ya hace esta validación por su cuenta con is_name_active,
-- pero con este cambio queda protegida también del lado servidor.
-- ============================================================
