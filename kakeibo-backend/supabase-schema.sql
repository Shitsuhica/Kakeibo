-- ══════════════════════════════════════════════════
-- Kakeibo — Schema de base de datos para Supabase
-- Ejecuta este SQL en Supabase → SQL Editor → Run
-- ══════════════════════════════════════════════════

-- Habilitar UUID extension
create extension if not exists "uuid-ossp";

-- ── Perfiles de usuario ──
create table if not exists profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  name text not null,
  lang text default 'es' check (lang in ('es','en','ja')),
  currency text default 'JPY' check (currency in ('JPY','PEN','MXN')),
  budgets jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── Gastos ──
create table if not exists expenses (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  desc text not null,
  category text not null,
  amount numeric(12,2) not null check (amount >= 0),
  date date not null,
  note text default '',
  created_at timestamptz default now()
);

-- ── Ingresos ──
create table if not exists incomes (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  desc text not null,
  type text not null,
  freq text not null check (freq in ('unico','diario','semanal','quincenal','mensual')),
  amount numeric(12,2) not null check (amount >= 0),
  date date not null,
  note text default '',
  created_at timestamptz default now()
);

-- ── Gastos bancarios ──
create table if not exists bank_expenses (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  desc text not null,
  bank_type text not null check (bank_type in ('servicio','tarjeta','comision')),
  category text not null,
  card_name text default '',
  amount numeric(12,2) not null check (amount >= 0),
  date date not null,
  note text default '',
  created_at timestamptz default now()
);

-- ── Índices de rendimiento ──
create index if not exists expenses_user_date on expenses(user_id, date desc);
create index if not exists incomes_user_date on incomes(user_id, date desc);
create index if not exists bank_expenses_user_date on bank_expenses(user_id, date desc);

-- ── Row Level Security (RLS) — cada usuario solo ve sus datos ──
alter table profiles enable row level security;
alter table expenses enable row level security;
alter table incomes enable row level security;
alter table bank_expenses enable row level security;

-- Policies para profiles
create policy "Users can view own profile"
  on profiles for select using (auth.uid() = id);
create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);
create policy "Users can insert own profile"
  on profiles for insert with check (auth.uid() = id);

-- Policies para expenses
create policy "Users can view own expenses"
  on expenses for select using (auth.uid() = user_id);
create policy "Users can insert own expenses"
  on expenses for insert with check (auth.uid() = user_id);
create policy "Users can delete own expenses"
  on expenses for delete using (auth.uid() = user_id);

-- Policies para incomes
create policy "Users can view own incomes"
  on incomes for select using (auth.uid() = user_id);
create policy "Users can insert own incomes"
  on incomes for insert with check (auth.uid() = user_id);
create policy "Users can delete own incomes"
  on incomes for delete using (auth.uid() = user_id);

-- Policies para bank_expenses
create policy "Users can view own bank_expenses"
  on bank_expenses for select using (auth.uid() = user_id);
create policy "Users can insert own bank_expenses"
  on bank_expenses for insert with check (auth.uid() = user_id);
create policy "Users can delete own bank_expenses"
  on bank_expenses for delete using (auth.uid() = user_id);

-- ── Trigger: actualizar updated_at en profiles ──
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger profiles_updated_at
  before update on profiles
  for each row execute function update_updated_at();

-- ══════════════════════════════════════════════════
-- ✓ Schema listo. Ahora configura las variables
--   de entorno en tu backend (.env):
--   SUPABASE_URL=https://XXXX.supabase.co
--   SUPABASE_SERVICE_ROLE_KEY=eyJ...
-- ══════════════════════════════════════════════════
