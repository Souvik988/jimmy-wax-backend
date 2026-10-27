-- B11: store pause, customer admin fields, order notes, app versions, feature flags, integration checks.

-- ------------------------------------------------------------- store pause
alter table public.store_settings
  add column if not exists orders_paused boolean not null default false,
  add column if not exists pause_message text not null default '' check (length(pause_message) <= 300);

-- The API role updates store_settings by column.
grant update (orders_paused, pause_message) on public.store_settings to jw_commerce_api;

create or replace view public.v_public_store_settings as
  select shipping_fee_paise, free_shipping_threshold_paise, cod_enabled, cod_max_order_paise,
         (checkout_enabled and checkout_policy_confirmed and checkout_authority = 'express' and not orders_paused) as checkout_open,
         delivery_estimate, cod_fee_paise, gst_rate_bps, tax_inclusive,
         support_email, support_phone, brand_name,
         orders_paused, pause_message
    from public.store_settings where id = 1;

-- --------------------------------------------------------------- customers
alter table public.profiles
  add column if not exists admin_notes text not null default '' check (length(admin_notes) <= 2000),
  add column if not exists admin_tags text[] not null default '{}',
  add column if not exists blocked_at timestamptz,
  add column if not exists blocked_reason text;

create policy admin_read_profiles on public.profiles for select to jw_commerce_api
  using (private.admin_role() is not null);
create policy admin_update_profiles on public.profiles for update to jw_commerce_api
  using (private.admin_role() in ('admin', 'support')) with check (private.admin_role() in ('admin', 'support'));

-- ------------------------------------------------------------- order notes
create table public.order_notes (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  author_id uuid not null,
  author_role text not null,
  body text not null check (length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index order_notes_order_idx on public.order_notes(order_id, id desc);
alter table public.order_notes enable row level security;
grant select, insert on public.order_notes to jw_commerce_api;
create policy order_notes_read on public.order_notes for select to jw_commerce_api
  using (private.admin_role() is not null);
create policy order_notes_write on public.order_notes for insert to jw_commerce_api
  with check (private.admin_role() in ('admin', 'support', 'fulfillment', 'finance') and author_id = private.actor_id());

-- ------------------------------------------------------------ app versions
create table public.app_versions (
  platform text primary key check (platform in ('android', 'ios')),
  latest_version text not null default '1.0.0' check (latest_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  min_supported_version text not null default '1.0.0' check (min_supported_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  store_url text not null default '',
  message text not null default '' check (length(message) <= 300),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into public.app_versions (platform) values ('android'), ('ios');
alter table public.app_versions enable row level security;
grant select, update on public.app_versions to jw_commerce_api;
grant select on public.app_versions to jw_experience;
create policy app_versions_read on public.app_versions for select to jw_commerce_api, jw_experience using (true);
create policy app_versions_write on public.app_versions for update to jw_commerce_api
  using (private.admin_role() = 'admin') with check (private.admin_role() = 'admin');

-- ----------------------------------------------------------- feature flags
create table public.feature_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  description text not null default '',
  enabled boolean not null default false,
  rollout_percent integer not null default 100 check (rollout_percent between 0 and 100),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.feature_flags enable row level security;
grant select, insert, update, delete on public.feature_flags to jw_commerce_api;
grant select on public.feature_flags to jw_experience;
create policy feature_flags_read on public.feature_flags for select to jw_commerce_api, jw_experience using (true);
create policy feature_flags_write on public.feature_flags for all to jw_commerce_api
  using (private.admin_role() = 'admin') with check (private.admin_role() = 'admin');

-- ------------------------------------------------------ integration checks
create table public.integration_checks (
  id bigint generated always as identity primary key,
  integration text not null check (integration in ('razorpay', 'sms', 'smtp', 'shipping', 'storage', 'maps')),
  ok boolean not null,
  detail text not null default '' check (length(detail) <= 500),
  checked_by uuid,
  checked_at timestamptz not null default now()
);
create index integration_checks_idx on public.integration_checks(integration, id desc);
alter table public.integration_checks enable row level security;
grant select, insert on public.integration_checks to jw_commerce_api;
create policy integration_checks_read on public.integration_checks for select to jw_commerce_api
  using (private.admin_role() is not null);
create policy integration_checks_write on public.integration_checks for insert to jw_commerce_api
  with check (private.admin_role() = 'admin');
