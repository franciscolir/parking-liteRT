-- ============================================================
-- 2026-11-03 · Las patentes registradas (incluidas NE) no deben
--               contar como "desconocidas" en las estadísticas.
--
-- Motivo: el escaneo guarda en scan_history.status el TIPO de la
-- patente (special_needs / administration / first_aid / unknown).
-- La función de estadísticas solo contaba como "registrada" a
-- 'administration', así que las placas de necesidades especiales
-- (y las de primeros auxilios se contaban aparte) terminaban en el
-- contador de "Desconocidos".
--
-- Qué hace:
--   registered_count = administration + special_needs (registradas)
--   stolen_count     = first_aid
--   unknown_count    = unknown / error
--
-- Aplicar en el SQL Editor de Supabase (una sola vez).
-- ============================================================

create or replace function public.increment_scan_stat(
  p_user_id uuid,
  p_status text
) returns void language plpgsql security definer as $$
declare
  -- Espejo de countScan() en app-supabase.js:
  -- administration / special_needs -> registered_count (están registradas)
  -- first_aid -> stolen_count
  -- unknown / error -> unknown_count
  v_reg_inc integer := case when p_status in ('administration', 'special_needs') then 1 else 0 end;
  v_sto_inc integer := case when p_status = 'first_aid' then 1 else 0 end;
  v_unk_inc integer := case when p_status not in ('administration', 'special_needs', 'first_aid') then 1 else 0 end;
begin
  insert into public.scan_stats (user_id, total_scans, registered_count, stolen_count, unknown_count, last_scan_at)
  values (p_user_id, 1, v_reg_inc, v_sto_inc, v_unk_inc, now())
  on conflict (user_id) do update set
    total_scans = scan_stats.total_scans + 1,
    registered_count = scan_stats.registered_count + v_reg_inc,
    stolen_count = scan_stats.stolen_count + v_sto_inc,
    unknown_count = scan_stats.unknown_count + v_unk_inc,
    last_scan_at = now(),
    updated_at = now();
end;
$$;
