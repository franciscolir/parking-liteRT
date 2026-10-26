-- ============================================================
-- PlateDetect - Supabase Schema (CORREGIDO)
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- Extensiones necesarias
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ============================================================
-- FUNCIÓN: moddatetime() - REQUERIDA ANTES DE CUALQUIER TRIGGER
-- ============================================================
create or replace function public.moddatetime()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- TABLA: users (perfiles extendidos de auth.users)
-- ============================================================
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text,
  role text default 'user' check (role in ('user', 'admin', 'operator')),
  phone text,
  avatar_url text,
  settings jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Trigger updated_at
create trigger update_users_updated_at
  before update on public.users
  for each row execute function public.moddatetime();

-- RLS
alter table public.users enable row level security;

create policy "Users can view own profile"
  on public.users for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.users for update
  using (auth.uid() = id);

create policy "Admins can view all users"
  on public.users for select
  using (exists (select 1 from public.users where id = auth.uid() and role = 'admin'));

-- ============================================================
-- TABLA: plates (patentes registradas y denunciadas)
-- ============================================================
create table public.plates (
  id uuid primary key default uuid_generate_v4(),
  plate text not null unique,
  type text not null check (type in ('registered', 'stolen', 'wanted', 'suspicious')),
  vehicle_type text check (vehicle_type in ('auto', 'camioneta', 'moto', 'camion', 'utilitario', 'otro')),
  owner_name text,
  owner_phone text,
  location text,
  description text,
  reported_by uuid references public.users(id),
  is_active boolean default true,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Índices
create index idx_plates_plate on public.plates(plate);
create index idx_plates_type on public.plates(type);
create index idx_plates_active on public.plates(is_active);
create index idx_plates_reported_by on public.plates(reported_by);

-- Trigger updated_at
create trigger update_plates_updated_at
  before update on public.plates
  for each row execute function public.moddatetime();

-- RLS
alter table public.plates enable row level security;

-- Todos pueden leer patentes activas (para verificación en escaneo)
create policy "Anyone can read active plates"
  on public.plates for select
  using (is_active = true);

-- Usuarios autenticados pueden insertar (reportar)
create policy "Authenticated users can insert plates"
  on public.plates for insert
  with check (auth.uid() is not null);

-- Solo el reportador o admin pueden actualizar
create policy "Reporter or admin can update plates"
  on public.plates for update
  using (reported_by = auth.uid() or exists (select 1 from public.users where id = auth.uid() and role = 'admin'));

-- ============================================================
-- TABLA: scan_history (historial de detecciones)
-- ============================================================
create table public.scan_history (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.users(id) on delete set null,
  plate text not null,
  status text not null check (status in ('registered', 'stolen', 'unknown', 'error')),
  confidence real,
  latitude real,
  longitude real,
  location_name text,
  image_url text, -- URL a storage si se guarda foto
  raw_ocr_text text,
  corrected_text text,
  detection_box jsonb, -- {x1, y1, x2, y2}
  device_info jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- Índices
create index idx_scan_history_user on public.scan_history(user_id);
create index idx_scan_history_plate on public.scan_history(plate);
create index idx_scan_history_status on public.scan_history(status);
create index idx_scan_history_created on public.scan_history(created_at desc);
create index idx_scan_history_user_created on public.scan_history(user_id, created_at desc);

-- RLS
alter table public.scan_history enable row level security;

create policy "Users can view own scan history"
  on public.scan_history for select
  using (user_id = auth.uid() or auth.uid() is null); -- null = anónimo

create policy "Users can insert own scan history"
  on public.scan_history for insert
  with check (user_id = auth.uid() or auth.uid() is null);

create policy "Admins can view all scan history"
  on public.scan_history for select
  using (exists (select 1 from public.users where id = auth.uid() and role = 'admin'));

-- ============================================================
-- TABLA: contacts (contactos de emergencia)
-- ============================================================
create table public.contacts (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  phone text not null,
  type text default 'custom' check (type in ('police', 'fire', 'emergency', 'office', 'custom')),
  icon text default '📞',
  is_default boolean default false,
  sort_order integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Índices
create index idx_contacts_user on public.contacts(user_id);
create index idx_contacts_user_sort on public.contacts(user_id, sort_order);

-- Trigger updated_at
create trigger update_contacts_updated_at
  before update on public.contacts
  for each row execute function public.moddatetime();

-- RLS
alter table public.contacts enable row level security;

create policy "Users can manage own contacts"
  on public.contacts for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================
-- TABLA: scan_stats (estadísticas agregadas por usuario)
-- ============================================================
create table public.scan_stats (
  user_id uuid primary key references public.users(id) on delete cascade,
  total_scans integer default 0,
  registered_count integer default 0,
  stolen_count integer default 0,
  unknown_count integer default 0,
  last_scan_at timestamptz,
  updated_at timestamptz default now()
);

-- RLS
alter table public.scan_stats enable row level security;

create policy "Users can view own stats"
  on public.scan_stats for select
  using (user_id = auth.uid());

create policy "Users can upsert own stats"
  on public.scan_stats for insert
  with check (user_id = auth.uid());

create policy "Users can update own stats"
  on public.scan_stats for update
  using (user_id = auth.uid());

-- ============================================================
-- FUNCIÓN: Incrementar stats atómicamente
-- ============================================================
create or replace function public.increment_scan_stat(
  p_user_id uuid,
  p_status text
) returns void language plpgsql security definer as $$
declare
  v_reg_inc integer := case when p_status = 'registered' then 1 else 0 end;
  v_sto_inc integer := case when p_status = 'stolen' then 1 else 0 end;
  v_unk_inc integer := case when p_status = 'unknown' then 1 else 0 end;
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

-- ============================================================
-- FUNCIÓN: Buscar patente (para verificación en escaneo)
-- ============================================================
create or replace function public.lookup_plate(p_plate text)
returns table (
  plate text,
  type text,
  vehicle_type text,
  owner_name text,
  description text
) language sql security definer as $$
  select plate, type, vehicle_type, owner_name, description
  from public.plates
  where plate = upper(p_plate) and is_active = true
  limit 1;
$$;

-- ============================================================
-- STORAGE BUCKET: scan-images (opcional, para fotos de detecciones)
-- ============================================================
-- Ejecutar en Supabase Dashboard > Storage > New bucket
-- Nombre: scan-images
-- Public: false
-- File size limit: 5MB
-- Allowed MIME types: image/*

-- Política de storage (ejecutar después de crear bucket):
/*
create policy "Users can upload own scan images"
  on storage.objects for insert
  with check (bucket_id = 'scan-images' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users can view own scan images"
  on storage.objects for select
  using (bucket_id = 'scan-images' and auth.uid()::text = (storage.foldername(name))[1]);
*/

-- ============================================================
-- DATOS INICIALES (seed) - Patentes de ejemplo
-- ============================================================
insert into public.plates (plate, type, vehicle_type, owner_name, description) values
  ('ABC123', 'registered', 'auto', 'Juan Pérez', 'Vehículo particular'),
  ('DEF456', 'registered', 'camioneta', 'María García', 'Empresa XYZ'),
  ('GHI789', 'registered', 'moto', 'Carlos López', 'Reparto'),
  ('JKL012', 'registered', 'auto', 'Ana Martínez', 'Particular'),
  ('MNO345', 'registered', 'utilitario', 'Pedro Sánchez', 'Servicio técnico'),
  ('PQR678', 'registered', 'camion', 'Laura Fernández', 'Transporte'),
  ('STU901', 'registered', 'auto', 'Diego Ruiz', 'Particular'),
  ('BBBB10', 'registered', 'camioneta', 'Sofía Torres', 'Empresa ABC'),
  ('XYZ789', 'stolen', 'auto', null, 'Robado 15/03/2024 - Denuncia #12345'),
  ('LMN456', 'stolen', 'moto', null, 'Hurto 22/01/2024 - Denuncia #12346'),
  ('WVU321', 'stolen', 'camioneta', null, 'Secuestro 10/02/2024 - Denuncia #12347')
on conflict (plate) do nothing;

-- ============================================================
-- CONTACTOS POR DEFECTO (se crean al registrar usuario via trigger)
-- ============================================================
create or replace function public.create_default_contacts()
returns trigger language plpgsql security definer as $$
begin
  insert into public.contacts (user_id, name, phone, type, icon, is_default, sort_order) values
    (new.id, 'Policía', '911', 'police', '🚨', true, 1),
    (new.id, 'Bomberos', '100', 'fire', '🔥', true, 2),
    (new.id, 'Emergencia Médica', '107', 'emergency', '🚑', true, 3),
    (new.id, 'Oficina', '', 'office', '🏢', true, 4)
  on conflict do nothing;
  return new;
end;
$$;

create trigger trigger_create_default_contacts
  after insert on public.users
  for each row execute function public.create_default_contacts();

-- ============================================================
-- VISTA: stats_dashboard (para admin)
-- ============================================================
create view public.stats_dashboard as
select
  (select count(*) from public.users) as total_users,
  (select count(*) from public.plates where type = 'registered' and is_active) as total_registered,
  (select count(*) from public.plates where type = 'stolen' and is_active) as total_stolen,
  (select count(*) from public.scan_history) as total_scans,
  (select count(*) from public.scan_history where created_at > now() - interval '24 hours') as scans_24h,
  (select count(*) from public.scan_history where created_at > now() - interval '7 days') as scans_7d;

-- Permiso para admins
grant select on public.stats_dashboard to authenticated;

-- ============================================================
-- REALTIME: Habilitar para tablas que necesiten sync en vivo
-- ============================================================
alter publication supabase_realtime add table public.plates;
alter publication supabase_realtime add table public.scan_history;
alter publication supabase_realtime add table public.contacts;