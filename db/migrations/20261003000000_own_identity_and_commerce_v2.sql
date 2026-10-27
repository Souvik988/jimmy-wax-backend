-- Own identity (no Supabase) + commerce v2: GST, COD fee, shipping, returns, invoices, reviews media,
-- devices, content, email outbox. Expand-only.

-- =============================================================== identity
alter table auth.users
  add column if not exists password_hash text,
  add column if not exists phone text,
  add column if not exists email_verified_at timestamptz,
  add column if not exists status text not null default 'active' check (status in ('active', 'disabled', 'deleted')),
  add column if not exists failed_logins integer not null default 0,
  add column if not exists locked_until timestamptz,
  add column if not exists last_login_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
create unique index if not exists users_email_lower_uidx on auth.users (lower(email)) where email is not null;

create table auth.refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  family_id uuid not null,
  token_hash text not null unique,
  client text not null default 'app' check (client in ('app', 'admin')),
  aal text not null default 'aal1' check (aal in ('aal1', 'aal2')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by uuid
);
create index refresh_tokens_user_idx on auth.refresh_tokens(user_id) where revoked_at is null;
create index refresh_tokens_family_idx on auth.refresh_tokens(family_id);

create table auth.one_time_tokens (
  token_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose in ('password_reset', 'email_verify')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table auth.admin_totp (
  user_id uuid primary key references auth.users(id) on delete cascade,
  secret_enc text not null,
  verified_at timestamptz,
  last_counter bigint not null default 0,
  created_at timestamptz not null default now()
);

grant usage on schema auth to jw_commerce_api, jw_worker;
grant select, insert, update on auth.users to jw_commerce_api;
grant select on auth.users to jw_worker;
grant select, insert, update, delete on auth.refresh_tokens, auth.one_time_tokens, auth.admin_totp to jw_commerce_api;
grant delete on auth.refresh_tokens, auth.one_time_tokens to jw_worker;
grant select on auth.refresh_tokens to jw_worker;

-- ========================================================== tax + COD fee
alter table public.store_settings
  add column gst_rate_bps integer not null default 1800 check (gst_rate_bps between 0 and 4000),
  add column tax_inclusive boolean not null default true,
  add column cod_fee_paise integer not null default 0 check (cod_fee_paise >= 0),
  add column merchant_legal_name text,
  add column merchant_gstin text check (merchant_gstin is null or merchant_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  add column merchant_state text,
  add column merchant_address text,
  add column invoice_prefix text not null default 'JW' check (invoice_prefix ~ '^[A-Z0-9]{1,6}$'),
  add column return_window_days integer check (return_window_days between 1 and 90);  -- NULL = returns not configured

alter table public.checkout_quotes
  add column cod_fee_paise integer not null default 0 check (cod_fee_paise >= 0),
  add column tax_inclusive boolean not null default true,
  add column tax_breakdown jsonb not null default '{}';
alter table public.orders
  add column cod_fee_paise integer not null default 0 check (cod_fee_paise >= 0),
  add column tax_inclusive boolean not null default true,
  add column tax_breakdown jsonb not null default '{}';

-- total = items - discount + shipping + COD fee (+ tax only when prices are tax-EXCLUSIVE).
alter table public.orders drop constraint orders_total_reconciles;
alter table public.orders add constraint orders_total_reconciles check (
  placed_via = 'legacy_trigger'
  or total_paise = subtotal_paise - discount_paise + shipping_paise + cod_fee_paise + case when tax_inclusive then 0 else tax_paise end);

grant update (gst_rate_bps, tax_inclusive, cod_fee_paise, merchant_legal_name, merchant_gstin, merchant_state,
  merchant_address, invoice_prefix, return_window_days) on public.store_settings to jw_commerce_api;

-- ================================================================ shipping
create table public.serviceable_pin_prefixes (
  prefix text primary key check (prefix ~ '^[0-9]{3,6}$'),
  note text,
  created_at timestamptz not null default now()
);
create table public.shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  courier text not null check (length(trim(courier)) between 2 and 80),
  tracking_number text not null check (length(trim(tracking_number)) between 3 and 80),
  tracking_url text check (tracking_url is null or tracking_url ~ '^https://'),
  status text not null default 'label_created' check (status in ('label_created', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned_to_origin')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (courier, tracking_number)
);
create index shipments_order_idx on public.shipments(order_id);
create table public.shipment_events (
  id bigint generated always as identity primary key,
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  status text not null,
  description text not null default '',
  occurred_at timestamptz not null default now(),
  source text not null default 'manual' check (source in ('manual', 'provider')),
  created_by uuid
);
create index shipment_events_idx on public.shipment_events(shipment_id, occurred_at, id);

-- ================================================================= returns
create table public.returns (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  user_id uuid not null references auth.users(id),
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'received', 'closed')),
  reason text not null check (length(trim(reason)) between 3 and 500),
  decision_note text,
  decided_by uuid,
  received_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- one open return per order
create unique index returns_one_open_uidx on public.returns(order_id) where status in ('requested', 'approved');
create table public.return_items (
  return_id uuid not null references public.returns(id) on delete cascade,
  order_item_id bigint not null references public.order_items(id),
  quantity integer not null check (quantity > 0),
  primary key (return_id, order_item_id)
);

-- =============================================================== invoices
create table public.invoice_counters (
  fy text primary key check (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  last_number integer not null default 0
);
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id),
  invoice_number text not null unique,
  issued_at timestamptz not null default now(),
  snapshot jsonb not null
);
-- invoices are immutable
create function private.invoice_immutable() returns trigger language plpgsql as $$
begin raise exception 'invoices are immutable' using errcode = '55000'; end $$;
create trigger invoices_no_change before update or delete on public.invoices for each row execute function private.invoice_immutable();

-- ================================================================ reviews
alter table public.reviews add column if not exists moderated_by uuid, add column if not exists moderation_note text;
create table public.review_media (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  original_key text not null,          -- private (quarantine) object
  public_key text,                     -- sanitised derivative, set only on approval
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  bytes integer not null check (bytes > 0),
  width integer not null, height integer not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);
create index review_media_review_idx on public.review_media(review_id);

-- ================================================ devices, content, email
create table public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('android', 'ios', 'web')),
  token text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (token)
);
create table public.content_pages (
  slug text primary key check (slug ~ '^[a-z0-9-]{2,60}$'),
  kind text not null check (kind in ('policy', 'care_guide', 'page')),
  title text not null,
  body_md text not null,
  version integer not null default 1,
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
create table public.content_versions (
  slug text not null, version integer not null, title text not null, body_md text not null,
  created_by uuid, created_at timestamptz not null default now(), primary key (slug, version)
);
create table public.email_outbox (
  id bigint generated always as identity primary key,
  dedupe_key text unique,
  to_email text not null,
  template text not null,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'suppressed')),
  attempts integer not null default 0,
  last_error text,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamp with time zone
);
create index email_outbox_pending_idx on public.email_outbox(available_at, id) where status = 'pending';

-- ======================================================== grants + policies
alter table public.serviceable_pin_prefixes enable row level security;
alter table public.shipments enable row level security;
alter table public.shipment_events enable row level security;
alter table public.returns enable row level security;
alter table public.return_items enable row level security;
alter table public.invoice_counters enable row level security;
alter table public.invoices enable row level security;
alter table public.review_media enable row level security;
alter table public.device_tokens enable row level security;
alter table public.content_pages enable row level security;
alter table public.content_versions enable row level security;
alter table public.email_outbox enable row level security;

grant select, insert, update, delete on public.serviceable_pin_prefixes to jw_commerce_api;
grant select on public.serviceable_pin_prefixes to jw_worker;
grant select, insert, update on public.shipments, public.returns to jw_commerce_api;
grant select, insert on public.shipment_events, public.return_items, public.invoices, public.content_versions to jw_commerce_api;
grant select, insert, update on public.invoice_counters, public.review_media, public.content_pages to jw_commerce_api;
grant select, insert, update, delete on public.device_tokens to jw_commerce_api;
grant update, delete on public.reviews to jw_commerce_api;
grant delete on public.notifications, public.checkout_quotes to jw_commerce_api;
-- The API may enqueue emails but can never read recipients/payloads back (tokens live there until sent).
grant insert on public.email_outbox to jw_commerce_api;
grant select (id, dedupe_key, status, template, created_at) on public.email_outbox to jw_commerce_api;
grant select, insert, update on public.email_outbox to jw_worker;
grant select on public.shipments, public.shipment_events, public.returns, public.review_media to jw_worker;
grant select on public.invoices to jw_worker;
grant usage, select on all sequences in schema public to jw_commerce_api, jw_worker;

create policy pins_read on public.serviceable_pin_prefixes for select to jw_commerce_api, jw_worker using (true);
create policy pins_admin on public.serviceable_pin_prefixes for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'fulfillment')) with check (private.admin_role() in ('admin', 'fulfillment'));

create policy shipments_read on public.shipments for select to jw_commerce_api
  using (private.admin_role() is not null or private.is_system()
         or exists (select 1 from public.orders o where o.id = order_id and o.user_id = private.actor_id()));
create policy shipments_write on public.shipments for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'fulfillment')) with check (private.admin_role() in ('admin', 'fulfillment'));
create policy shipment_events_read on public.shipment_events for select to jw_commerce_api
  using (private.admin_role() is not null or private.is_system()
         or exists (select 1 from public.shipments s join public.orders o on o.id = s.order_id
                     where s.id = shipment_id and o.user_id = private.actor_id()));
create policy shipment_events_write on public.shipment_events for insert to jw_commerce_api
  with check (private.admin_role() in ('admin', 'fulfillment'));
create policy worker_shipments on public.shipments for select to jw_worker using (true);
create policy worker_shipment_events on public.shipment_events for select to jw_worker using (true);

create policy returns_owner on public.returns for all to jw_commerce_api
  using (user_id = private.actor_id()) with check (user_id = private.actor_id());
create policy returns_admin_read on public.returns for select to jw_commerce_api using (private.admin_role() is not null);
create policy returns_admin_update on public.returns for update to jw_commerce_api
  using (private.admin_role() in ('admin', 'fulfillment', 'finance')) with check (private.admin_role() in ('admin', 'fulfillment', 'finance'));
create policy return_items_owner on public.return_items for all to jw_commerce_api
  using (exists (select 1 from public.returns r where r.id = return_id and (r.user_id = private.actor_id() or private.admin_role() is not null)))
  with check (exists (select 1 from public.returns r where r.id = return_id and r.user_id = private.actor_id()));
create policy worker_returns on public.returns for select to jw_worker using (true);

create policy invoices_read on public.invoices for select to jw_commerce_api
  using (private.admin_role() is not null or private.is_system()
         or exists (select 1 from public.orders o where o.id = order_id and o.user_id = private.actor_id()));
create policy invoices_issue on public.invoices for insert to jw_commerce_api
  with check (private.admin_role() in ('admin', 'finance', 'fulfillment') or private.is_system()
              or exists (select 1 from public.orders o where o.id = order_id and o.user_id = private.actor_id()));
create policy worker_invoices on public.invoices for select to jw_worker using (true);
create policy invoice_counters_all on public.invoice_counters for all to jw_commerce_api using (true) with check (true);

create policy review_media_owner on public.review_media for all to jw_commerce_api
  using (exists (select 1 from public.reviews r where r.id = review_id and (r.user_id = private.actor_id() or private.admin_role() is not null)))
  with check (exists (select 1 from public.reviews r where r.id = review_id and (r.user_id = private.actor_id() or private.admin_role() in ('admin', 'support'))));
-- Tighten the baseline broad policy: reading is wide, MODIFYING is owner-only (admins moderate via reviews_admin_update).
drop policy api_reviews on public.reviews;
create policy reviews_read on public.reviews for select to jw_commerce_api
  using (status = 'approved' or user_id = private.actor_id() or private.is_system() or private.admin_role() is not null);
create policy reviews_owner_write on public.reviews for insert to jw_commerce_api with check (user_id = private.actor_id());
create policy reviews_owner_update on public.reviews for update to jw_commerce_api
  using (user_id = private.actor_id()) with check (user_id = private.actor_id());
create policy reviews_owner_delete on public.reviews for delete to jw_commerce_api using (user_id = private.actor_id());
create policy reviews_admin_update on public.reviews for update to jw_commerce_api
  using (private.admin_role() in ('admin', 'support')) with check (private.admin_role() in ('admin', 'support'));
create policy worker_review_media on public.review_media for select to jw_worker using (true);

create policy devices_owner on public.device_tokens for all to jw_commerce_api
  using (user_id = private.actor_id() or private.is_system()) with check (user_id = private.actor_id());
create policy content_admin on public.content_pages for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'catalog')) with check (private.admin_role() in ('admin', 'catalog'));
create policy content_read on public.content_pages for select to jw_commerce_api using (true);
create policy content_versions_admin on public.content_versions for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'catalog')) with check (private.admin_role() in ('admin', 'catalog'));
create policy email_insert on public.email_outbox for insert to jw_commerce_api with check (true);
-- INSERT .. ON CONFLICT needs row visibility; the column grant above limits WHAT is visible.
create policy email_read on public.email_outbox for select to jw_commerce_api using (true);
create policy worker_email on public.email_outbox for all to jw_worker using (true) with check (true);

-- Experience read models for content and approved review media.
create view public.v_content_pages as
  select slug, kind, title, body_md, version, published_at from public.content_pages where status = 'published';
create view public.v_approved_review_media as
  select m.id, m.review_id, r.product_id, m.public_key, m.mime, m.width, m.height
    from public.review_media m join public.reviews r on r.id = m.review_id
   where m.status = 'approved' and r.status = 'approved' and m.public_key is not null;
revoke all on public.v_content_pages, public.v_approved_review_media from public, anon, authenticated;
grant select on public.v_content_pages, public.v_approved_review_media to jw_experience;

-- Legacy Data-API roles lose everything: there is no PostgREST and nobody should log in as them.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- Public store policy now also exposes the COD handling fee and GST basis (columns appended: allowed by CREATE OR REPLACE).
create or replace view public.v_public_store_settings as
  select shipping_fee_paise, free_shipping_threshold_paise, cod_enabled, cod_max_order_paise,
         (checkout_enabled and checkout_policy_confirmed and checkout_authority = 'express') as checkout_open,
         delivery_estimate, cod_fee_paise, gst_rate_bps, tax_inclusive
    from public.store_settings where id = 1;
