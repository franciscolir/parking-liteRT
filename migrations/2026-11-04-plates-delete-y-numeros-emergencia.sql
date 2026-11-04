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
