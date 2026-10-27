-- Contract hardening (dashboard requests DASH-BR-009, -032, -037, -042). Forward-only; safe to re-run is NOT promised, apply once.
--
-- 1. Public media: only approved, ready, non-archived assets may be served from the content-addressed public URL.
-- 2. Media rights/provenance fields (separate from the 300-char licence string).
-- 3. Categories get a revision so concurrent edits are detectable.
-- 4. Order status history, recorded by the database itself so no code path can skip it.

-- 1 ---------------------------------------------------------------------------------------------------------------
create or replace view public.v_public_media as
  select sha256, kind from public.media_assets
   where approval = 'approved' and status = 'ready' and archived_at is null;
grant select on public.v_public_media to jw_experience, jw_commerce_api;

-- 2 ---------------------------------------------------------------------------------------------------------------
alter table public.media_assets
  add column if not exists rights_holder text check (rights_holder is null or length(rights_holder) <= 200),
  add column if not exists provenance_note text check (provenance_note is null or length(provenance_note) <= 500),
  add column if not exists consent_reference text check (consent_reference is null or length(consent_reference) <= 200);

-- 3 ---------------------------------------------------------------------------------------------------------------
alter table public.categories
  add column if not exists rev integer not null default 1,
  add column if not exists updated_at timestamptz not null default now();

-- 5 manual shipments can carry an overridden package snapshot (DASH-BR-012)
alter table public.shipments
  add column if not exists package jsonb,
  add column if not exists package_override_reason text check (package_override_reason is null or length(package_override_reason) between 3 and 200);

-- 4 ---------------------------------------------------------------------------------------------------------------
create table if not exists public.order_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  from_status text,
  to_status text not null,
  occurred_at timestamptz not null default now()
);
create index if not exists order_status_history_order_idx on public.order_status_history(order_id, id);
alter table public.order_status_history enable row level security;
grant select on public.order_status_history to jw_commerce_api, jw_worker;
create policy order_status_history_read on public.order_status_history for select to jw_commerce_api using (true);
create policy order_status_history_worker on public.order_status_history for select to jw_worker using (true);

create or replace function private.record_order_status() returns trigger
language plpgsql security definer set search_path = public, pg_temp as
$$
begin
  if tg_op = 'INSERT' then
    insert into public.order_status_history(order_id, from_status, to_status, occurred_at) values (new.id, null, new.status, new.created_at);
  elsif new.status is distinct from old.status then
    insert into public.order_status_history(order_id, from_status, to_status) values (new.id, old.status, new.status);
  end if;
  return null;
end
$$;
drop trigger if exists orders_record_status on public.orders;
create trigger orders_record_status after insert or update of status on public.orders
  for each row execute function private.record_order_status();

-- Orders that predate the trigger get one row for their current status so the timeline is never empty.
insert into public.order_status_history(order_id, from_status, to_status, occurred_at)
  select o.id, null, o.status, o.created_at from public.orders o
   where not exists (select 1 from public.order_status_history h where h.order_id = o.id);

-- 6 Email bounce handling -----------------------------------------------------------------------------------------
-- An address that hard-bounced (permanent SMTP failure) or complained is never mailed again until an operator lifts the entry.
create table if not exists public.email_suppressions (
  email text primary key check (email = lower(email) and length(email) <= 320),
  reason text not null check (reason in ('hard_bounce', 'complaint', 'manual')),
  detail text check (detail is null or length(detail) <= 300),
  created_at timestamptz not null default now()
);
alter table public.email_suppressions enable row level security;
grant select, insert, delete on public.email_suppressions to jw_commerce_api;
grant select, insert on public.email_suppressions to jw_worker;
create policy email_suppressions_api on public.email_suppressions for all to jw_commerce_api using (true) with check (true);
create policy email_suppressions_worker on public.email_suppressions for all to jw_worker using (true) with check (true);
