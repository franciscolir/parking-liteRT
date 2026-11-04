-- ============================================================
-- Migración: 2026-11-05 - Los datos SOLO se obtienen con login
-- ------------------------------------------------------------
-- Antes: con la anon key (que va pública en el bundle) cualquiera
-- podía leer la tabla plates (135 filas con nombre del dueño),
-- app_settings y el RPC lookup_plate, sin pasar por el login.
--
-- Ahora:
--   - Admin     → sesión de Supabase (rol authenticated): lee las
--                 tablas como siempre.
--   - Flotante  → nombre de whitelist + token de sesión: usa los
--                 RPCs flotante_* que validan ese token.
--   - Anónimo   → sin acceso a datos.
--
-- IMPORTANTE: aplicar DESPUÉS de 2026-11-04 (o junto con él).
-- El cliente tiene fallback: si estas funciones todavía no existen,
-- el flotante usa la ruta vieja y la app no se rompe.
--
-- Idempotente: se puede correr más de una vez.
-- ============================================================

-- ------------------------------------------------------------
-- 1) RPCs del modo flotante
-- ------------------------------------------------------------
-- La validación reutiliza touch_session(), que es la misma función
-- que usa el heartbeat de la app (comprueba whitelist y expiración)
-- y devuelve un json con {"ok": true|false}. Se interpreta de forma
-- tolerante por si el tipo de retorno cambia.

create or replace function public.flotante_plates(
  p_name text,
  p_session_token uuid,
  p_type text default null,
  p_limit int default 500
)
returns table (
  plate text,
  type text,
  vehicle_type text,
  owner_name text,
  description text,
  is_active boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_ok boolean;
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

  return query
    select p.plate, p.type, p.vehicle_type, p.owner_name, p.description, p.is_active
    from public.plates p
    where p.is_active = true
      and (p_type is null or p.type = p_type)
    order by p.created_at desc
    limit greatest(1, least(coalesce(p_limit, 500), 1000));
end;
$$;

create or replace function public.flotante_lookup_plate(
  p_plate text,
  p_name text,
  p_session_token uuid
)
returns table (
  plate text,
  type text,
  vehicle_type text,
  owner_name text,
  description text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_ok boolean;
  v_plate text;
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

  v_plate := upper(regexp_replace(coalesce(p_plate, ''), '[^A-Z0-9]', '', 'g'));

  return query
    select p.plate, p.type, p.vehicle_type, p.owner_name, p.description
    from public.plates p
    where p.is_active = true
      and p.plate = v_plate
    limit 1;
end;
$$;

create or replace function public.flotante_search_plates(
  p_search text,
  p_name text,
  p_session_token uuid,
  p_limit int default 30
)
returns table (
  plate text,
  type text,
  vehicle_type text,
  owner_name text,
  is_active boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_ok boolean;
  v_q text;
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

  -- Solo letras, números y espacios (sin comodines de SQL).
  v_q := upper(regexp_replace(coalesce(p_search, ''), '[^A-Z0-9 ]', '', 'g'));
  if v_q = '' then
    return;
  end if;

  return query
    select p.plate, p.type, p.vehicle_type, p.owner_name, p.is_active
    from public.plates p
    where p.is_active = true
      and p.plate ilike '%' || v_q || '%'
    order by p.plate asc
    limit greatest(1, least(coalesce(p_limit, 30), 200));
end;
$$;

create or replace function public.flotante_emergency_contacts(
  p_name text,
  p_session_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_ok boolean;
  v_value jsonb;
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

  select value into v_value from public.app_settings where key = 'emergency_contacts';
  return v_value;
end;
$$;

grant execute on function public.flotante_plates(text, uuid, text, int) to anon, authenticated;
grant execute on function public.flotante_lookup_plate(text, text, uuid) to anon, authenticated;
grant execute on function public.flotante_search_plates(text, text, uuid, int) to anon, authenticated;
grant execute on function public.flotante_emergency_contacts(text, uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- 2) Cerrar la lectura directa al anónimo
-- ------------------------------------------------------------
-- plates: el anónimo (y el rol PUBLIC) pierde el SELECT; el admin
-- (authenticated) y service_role lo conservan.
revoke select on table public.plates from public, anon;
grant select on table public.plates to authenticated, service_role;

-- app_settings: solo el admin lo lee directo. Los flotantes usan
-- flotante_emergency_contacts().
revoke select on table public.app_settings from public, anon;
grant select on table public.app_settings to authenticated, service_role;

-- lookup_plate: deja de ser público; el flotante usa
-- flotante_lookup_plate() y el admin sigue usándola con su sesión.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'lookup_plate'
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
    raise notice 'lookup_plate restringida a autenticados: %', f.sig;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 3) Verificación (lectura: se puede correr las veces que quieras)
-- ------------------------------------------------------------
-- Expectativa: plate_reads = 0 (el anónimo ya no lee la tabla).
select 'anónimo lee plates' as check_name,
       count(*)::int as plate_reads
from public.plates;
