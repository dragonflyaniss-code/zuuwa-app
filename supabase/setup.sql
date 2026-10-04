-- ZUUWA Waterproofing Ventures — Supabase setup (run once in Supabase → SQL Editor)
-- Safe to re-run: every statement is idempotent.
-- Before running: create the two users in Authentication → Users (see SETUP.md).

-- ---------- users / roles ----------
create table if not exists public.zw_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  name text not null,
  role text not null check (role in ('admin','user'))
);
alter table public.zw_profiles enable row level security;

-- Role map by login email. Anis = admin, Firdaus = user.
create or replace function public.zw_role_for(e text) returns table(name text, role text) language sql immutable as $$
  select v.name, v.role from (values
    ('cik_anissa@yahoo.com', 'Anis', 'admin'),
    ('firdausjaafar44@gmail.com', 'Firdaus', 'user')
  ) as v(email, name, role) where v.email = lower(e)
$$;

insert into public.zw_profiles (user_id, email, name, role)
select u.id, lower(u.email), r.name, r.role from auth.users u cross join lateral public.zw_role_for(u.email) r
on conflict (user_id) do update set name = excluded.name, role = excluded.role, email = excluded.email;

-- Users created later in the dashboard get their profile automatically (only the two known emails).
create or replace function public.zw_on_auth_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.zw_profiles (user_id, email, name, role)
  select new.id, lower(new.email), r.name, r.role from public.zw_role_for(new.email) r
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists zw_on_auth_user on auth.users;
create trigger zw_on_auth_user after insert on auth.users for each row execute function public.zw_on_auth_user();

create or replace function public.zw_is_member() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.zw_profiles where user_id = auth.uid())
$$;
create or replace function public.zw_is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.zw_profiles where user_id = auth.uid() and role = 'admin')
$$;
create or replace function public.zw_my_name() returns text language sql stable security definer set search_path = public as $$
  select name from public.zw_profiles where user_id = auth.uid()
$$;

drop policy if exists zw_profiles_read on public.zw_profiles;
create policy zw_profiles_read on public.zw_profiles for select to authenticated using (public.zw_is_member());

-- ---------- business tables (record kept whole in `data`; key columns carry the relationships) ----------
create table if not exists public.zw_customers (
  id text primary key, data jsonb not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by uuid default auth.uid()
);
create table if not exists public.zw_quotations (
  id text primary key, number text not null unique,
  customer_id text references public.zw_customers(id) on delete set null,
  data jsonb not null, created_by uuid default auth.uid(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by uuid default auth.uid()
);
create table if not exists public.zw_invoices (
  id text primary key, number text not null unique,
  customer_id text references public.zw_customers(id) on delete set null,
  quotation_id text references public.zw_quotations(id) on delete restrict,
  parent_invoice_id text references public.zw_invoices(id) on delete restrict,
  data jsonb not null, created_by uuid default auth.uid(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by uuid default auth.uid()
);
create table if not exists public.zw_payments (
  id text primary key,
  invoice_id text references public.zw_invoices(id) on delete restrict,
  quotation_id text references public.zw_quotations(id) on delete restrict,
  data jsonb not null, created_by uuid default auth.uid(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by uuid default auth.uid()
);
create table if not exists public.zw_receipts (
  id text primary key, number text not null unique,
  invoice_id text references public.zw_invoices(id) on delete restrict,
  data jsonb not null, created_by uuid default auth.uid(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by uuid default auth.uid()
);
create table if not exists public.zw_warranties (
  id text primary key, number text not null unique,
  invoice_id text references public.zw_invoices(id) on delete restrict,
  quotation_id text references public.zw_quotations(id) on delete restrict,
  data jsonb not null, created_by uuid default auth.uid(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by uuid default auth.uid()
);
-- Shared settings and numbering counters.
create table if not exists public.zw_kv (
  key text primary key, value jsonb not null,
  updated_at timestamptz not null default now(), updated_by uuid default auth.uid()
);

-- ---------- server-side rules ----------
-- Creator is always the signed-in user (demo records stay blank), never changed afterwards.
-- Non-admins can never change an existing document number.
create or replace function public.zw_doc_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare nm text := public.zw_my_name();
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if coalesce(new.data->>'demo','false') <> 'true' then
      new.data := jsonb_set(jsonb_set(new.data, '{createdBy}', to_jsonb(coalesce(nm,''))), '{createdById}', to_jsonb(coalesce(auth.uid()::text,'')));
    else
      new.data := jsonb_set(jsonb_set(new.data, '{createdBy}', '""'), '{createdById}', '""');
    end if;
  else
    new.created_by := old.created_by; new.created_at := old.created_at;
    new.data := jsonb_set(jsonb_set(new.data, '{createdBy}', coalesce(old.data->'createdBy','""')), '{createdById}', coalesce(old.data->'createdById','""'));
    new.data := jsonb_set(jsonb_set(new.data, '{lastModifiedBy}', to_jsonb(coalesce(nm,''))), '{lastModifiedById}', to_jsonb(coalesce(auth.uid()::text,'')));
    if not public.zw_is_admin() and (to_jsonb(new)->>'number') is distinct from (to_jsonb(old)->>'number') then
      raise exception 'Only the admin can change document numbers.' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;

create or replace function public.zw_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;

-- Settings (company details, company stamp, job scopes, numbering, bank details…) are read-only for non-admins.
-- The shared 'counters' row stays writable by both users so automatic numbering keeps working.
create or replace function public.zw_kv_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.key = 'settings' or (tg_op = 'UPDATE' and old.key = 'settings')) and not public.zw_is_admin() then
    raise exception 'Only the admin can create or change settings.' using errcode = '42501';
  end if;
  new.updated_at := now(); new.updated_by := auth.uid();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['zw_quotations','zw_invoices','zw_payments','zw_receipts','zw_warranties'] loop
    execute format('drop trigger if exists zw_guard on public.%I', t);
    execute format('create trigger zw_guard before insert or update on public.%I for each row execute function public.zw_doc_guard()', t);
  end loop;
  execute 'drop trigger if exists zw_touch on public.zw_customers';
  execute 'create trigger zw_touch before insert or update on public.zw_customers for each row execute function public.zw_touch()';
  execute 'drop trigger if exists zw_guard on public.zw_kv';
  execute 'create trigger zw_guard before insert or update on public.zw_kv for each row execute function public.zw_kv_guard()';

  -- RLS: only signed-in ZUUWA users; nothing is readable by anonymous visitors.
  foreach t in array array['zw_customers','zw_quotations','zw_invoices','zw_payments','zw_receipts','zw_warranties','zw_kv'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('drop policy if exists zw_member_all on public.%I', t);
  end loop;
  foreach t in array array['zw_customers','zw_quotations','zw_invoices','zw_payments','zw_receipts','zw_warranties'] loop
    execute format('create policy zw_member_all on public.%I for all to authenticated using (public.zw_is_member()) with check (public.zw_is_member())', t);
  end loop;
end $$;
revoke all on public.zw_profiles from anon;

-- zw_kv: both users can read everything. Settings may only be created, changed or deleted by the admin;
-- the numbering 'counters' row can be written by both users (automatic numbering); deleting any row is admin-only.
drop policy if exists zw_kv_read on public.zw_kv;
create policy zw_kv_read on public.zw_kv for select to authenticated using (public.zw_is_member());
drop policy if exists zw_kv_write on public.zw_kv;
create policy zw_kv_write on public.zw_kv for insert to authenticated
  with check (public.zw_is_member() and (key <> 'settings' or public.zw_is_admin()));
drop policy if exists zw_kv_update on public.zw_kv;
create policy zw_kv_update on public.zw_kv for update to authenticated
  using (public.zw_is_member() and (key <> 'settings' or public.zw_is_admin()))
  with check (public.zw_is_member() and (key <> 'settings' or public.zw_is_admin()));
drop policy if exists zw_kv_delete on public.zw_kv;
create policy zw_kv_delete on public.zw_kv for delete to authenticated using (public.zw_is_admin());

-- ---------- private file storage (for uploaded / generated files) ----------
insert into storage.buckets (id, name, public) values ('zuuwa-private', 'zuuwa-private', false)
on conflict (id) do update set public = false;
-- Both users can read files. Files under settings/ (company stamp, logo, signature…) can only be
-- uploaded, replaced or deleted by the admin; other document files can be written by both users.
drop policy if exists zw_files_rw on storage.objects;
drop policy if exists zw_files_read on storage.objects;
create policy zw_files_read on storage.objects for select to authenticated
  using (bucket_id = 'zuuwa-private' and public.zw_is_member());
drop policy if exists zw_files_insert on storage.objects;
create policy zw_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'zuuwa-private' and public.zw_is_member() and (name not like 'settings/%' or public.zw_is_admin()));
drop policy if exists zw_files_update on storage.objects;
create policy zw_files_update on storage.objects for update to authenticated
  using (bucket_id = 'zuuwa-private' and public.zw_is_member() and (name not like 'settings/%' or public.zw_is_admin()))
  with check (bucket_id = 'zuuwa-private' and public.zw_is_member() and (name not like 'settings/%' or public.zw_is_admin()));
drop policy if exists zw_files_delete on storage.objects;
create policy zw_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'zuuwa-private' and public.zw_is_member() and (name not like 'settings/%' or public.zw_is_admin()));

-- Check: both users should be listed here with the right role.
select email, name, role from public.zw_profiles order by role;
