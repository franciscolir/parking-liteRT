-- ============================================================
-- Migración: 2026-11-04
-- 1) Política RLS de DELETE en public.plates
--    Sin ella, el botón 🗑️ del panel admin "borraba" en silencio:
--    PostgREST devuelve 200 con 0 filas afectadas (verificado en prod
--    siendo admin, con reported_by propio y ajeno).
-- 2) Números de emergencia por defecto (GLOBALES) en app_settings
--    para la vista Llamadas: el admin los edita una vez y todos los
--    usuarios (y invitados) ven los mismos números.
--
-- Cómo aplicarla: pegar en el SQL Editor de Supabase (Dashboard →
-- SQL Editor → New query → Run). Es idempotente: se puede correr
-- más de una vez.
-- ============================================================

-- ------------------------------------------------------------
-- 1) DELETE en plates: solo el reportador o un admin
-- ------------------------------------------------------------
drop policy if exists "Reporter or admin can delete plates" on public.plates;

create policy "Reporter or admin can delete plates"
  on public.plates for delete
  using (
    reported_by = auth.uid()
    or exists (select 1 from public.users where id = auth.uid() and role = 'admin')
  );

-- ------------------------------------------------------------
-- 2) Contactos por defecto globales (solo si la clave no existe)
--    value es json/jsonb: el literal sin cast se adapta al tipo real.
-- ------------------------------------------------------------
insert into public.app_settings (key, value, updated_at)
values (
  'emergency_contacts',
  '[
    {"name":"Carabineros","phone":"133","type":"police","icon":"🚨"},
    {"name":"Bomberos","phone":"132","type":"fire","icon":"🔥"},
    {"name":"Ambulancia","phone":"131","type":"emergency","icon":"🚑"},
    {"name":"Superintendente dpto.","phone":"","type":"office","icon":"🏢"},
    {"name":"Auxiliar","phone":"","type":"custom","icon":"👮"}
  ]',
  now()
)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 3) Cerrar RPCs a anónimos (auditoría 2026-11-04, sin sesión):
--    - increment_scan_stat: cualquier anónimo podía ejecutarla
--      (fallaba solo por FK). Con un UUID obtenible de
--      plates.reported_by podía alterar los contadores de
--      escaneos de cualquier usuario.
--    - get_admin_stats: el anónimo podía llamarla (devolvía null,
--      sin fuga de datos, pero sin ninguna guarda).
--    El admin (rol authenticated) sigue usándolas normalmente.
--    No tocar: lookup_plate, validate_and_start_session,
--    touch_session, end_session (las usa el modo flotante).
-- ------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('increment_scan_stat', 'get_admin_stats')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
    raise notice 'Ejecución restringida a autenticados: %', f.sig;
  end loop;
end $$;
