-- B10: shipping provider integration (Shiprocket via a provider boundary). Manual shipments keep working.

-- ------------------------------------------------------------- shipment model
alter table public.shipments drop constraint shipments_status_check;
alter table public.shipments add constraint shipments_status_check check (status in (
  'pending_provider', 'label_created', 'awb_assigned', 'pickup_scheduled', 'picked_up', 'in_transit', 'out_for_delivery',
  'delivered', 'undelivered', 'rto_initiated', 'rto_in_transit', 'returned_to_origin', 'cancelled', 'lost', 'damaged', 'failed'));
alter table public.shipments
  add column provider text not null default 'manual' check (provider in ('manual', 'shiprocket', 'fake')),
  add column provider_order_id text,
  add column provider_shipment_id text,
  add column courier_id text,
  add column label_key text,
  add column pickup_scheduled_at timestamptz,
  add column etd timestamptz,
  add column charges_paise integer check (charges_paise is null or charges_paise >= 0),
  add column cod_amount_paise integer not null default 0 check (cod_amount_paise >= 0),
  add column weight_grams integer,
  add column dims jsonb,
  add column ndr_count integer not null default 0,
  add column rto_state text,
  add column raw_status text,
  add column raw_status_id integer,
  add column last_event_at timestamptz,
  add column is_return boolean not null default false;
create unique index shipments_provider_shipment_idx on public.shipments(provider, provider_shipment_id) where provider_shipment_id is not null;
create index shipments_awb_idx on public.shipments(tracking_number);
create index shipments_active_idx on public.shipments(last_event_at)
  where status not in ('delivered', 'returned_to_origin', 'cancelled', 'lost', 'damaged', 'failed');
grant update, insert on public.shipments to jw_worker;
grant insert on public.shipment_events to jw_worker;
create policy shipments_worker_update on public.shipments for update to jw_worker using (true) with check (true);
create policy shipments_worker_insert on public.shipments for insert to jw_worker with check (true);
create policy shipment_events_worker on public.shipment_events for all to jw_worker using (true) with check (true);
grant select, update on public.orders to jw_worker;

create table public.shipping_settings (
  id integer primary key default 1 check (id = 1),
  pickup_location text,
  default_weight_grams integer not null default 300 check (default_weight_grams between 1 and 50000),
  default_length_mm integer not null default 150 check (default_length_mm between 1 and 2000),
  default_width_mm integer not null default 100 check (default_width_mm between 1 and 2000),
  default_height_mm integer not null default 80 check (default_height_mm between 1 and 2000),
  courier_rule text not null default 'balanced' check (courier_rule in ('cheapest', 'fastest', 'balanced', 'preferred')),
  preferred_couriers text[] not null default '{}',
  auto_ship boolean not null default false,
  bulk_confirm_threshold integer not null default 5 check (bulk_confirm_threshold between 1 and 200),
  require_provider_check boolean not null default false,
  pickup_pin text check (pickup_pin is null or pickup_pin ~ '^[0-9]{6}$'),
  stuck_after_hours integer not null default 72 check (stuck_after_hours between 6 and 720),
  updated_at timestamptz not null default now()
);
insert into public.shipping_settings (id) values (1);
alter table public.shipping_settings enable row level security;
grant select, update on public.shipping_settings to jw_commerce_api;
grant select on public.shipping_settings to jw_worker;
create policy shipping_settings_read on public.shipping_settings for select to jw_commerce_api, jw_worker
  using (private.admin_role() is not null or private.is_system());
create policy shipping_settings_write on public.shipping_settings for update to jw_commerce_api
  using (private.admin_role() in ('admin', 'fulfillment')) with check (private.admin_role() in ('admin', 'fulfillment'));

-- The state machine for creating a provider shipment. One row per attempt; the provider order id is persisted
-- IMMEDIATELY so a crash or timeout never leads to a second provider order for the same reference.
create table public.shipment_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  reference text not null unique,
  attempt integer not null default 1,
  state text not null default 'planned'
    check (state in ('planned', 'provider_order_created', 'awb_assigned', 'pickup_scheduled', 'done', 'failed', 'cancelled')),
  provider text not null check (provider in ('shiprocket', 'fake')),
  provider_order_id text,
  provider_shipment_id text,
  awb text,
  courier_id text,
  courier_name text,
  charges_paise integer,
  courier_choice text,
  package jsonb not null,
  error_code text,
  error text,
  shipment_id uuid references public.shipments(id),
  lease_until timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index shipment_requests_open_order on public.shipment_requests(order_id)
  where state not in ('done', 'failed', 'cancelled');
alter table public.shipment_requests enable row level security;
grant select, insert, update on public.shipment_requests to jw_commerce_api, jw_worker;
create policy shipment_requests_read on public.shipment_requests for select to jw_commerce_api, jw_worker
  using (private.admin_role() is not null or private.is_system());
create policy shipment_requests_write on public.shipment_requests for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'fulfillment')) with check (private.admin_role() in ('admin', 'fulfillment'));
create policy shipment_requests_worker on public.shipment_requests for all to jw_worker using (true) with check (true);

create table public.shipping_provider_events (
  id bigint generated always as identity primary key,
  provider text not null,
  dedupe_key text not null unique,
  awb text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);
create index shipping_provider_events_pending_idx on public.shipping_provider_events(id) where processed_at is null;
alter table public.shipping_provider_events enable row level security;
grant select, insert, update on public.shipping_provider_events to jw_commerce_api, jw_worker;
create policy spe_read on public.shipping_provider_events for select to jw_commerce_api
  using (private.admin_role() in ('admin', 'fulfillment', 'finance', 'support') or private.is_system());
create policy spe_intake on public.shipping_provider_events for insert to jw_commerce_api with check (private.is_system());
create policy spe_update on public.shipping_provider_events for update to jw_commerce_api
  using (private.is_system()) with check (private.is_system());
create policy spe_worker on public.shipping_provider_events for all to jw_worker using (true) with check (true);

create table public.shipping_bulk_jobs (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null,
  strategy text not null check (strategy in ('cheapest', 'fastest', 'balanced', 'preferred', 'courier')),
  courier_id text,
  order_ids uuid[] not null check (cardinality(order_ids) between 1 and 100),
  status text not null default 'queued' check (status in ('queued', 'running', 'done')),
  results jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.shipping_bulk_jobs enable row level security;
grant select, insert, update on public.shipping_bulk_jobs to jw_commerce_api, jw_worker;
create policy bulk_read on public.shipping_bulk_jobs for select to jw_commerce_api
  using (private.admin_role() is not null or private.is_system());
create policy bulk_write on public.shipping_bulk_jobs for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'fulfillment') or private.is_system())
  with check (private.admin_role() in ('admin', 'fulfillment') or private.is_system());
create policy bulk_worker on public.shipping_bulk_jobs for all to jw_worker using (true) with check (true);

-- Cached provider verdict per delivery PIN (customer quotes never wait on a network call).
create table public.pin_serviceability_cache (
  pin text primary key check (pin ~ '^[0-9]{6}$'),
  serviceable boolean not null,
  couriers integer not null default 0,
  min_etd_days integer,
  checked_at timestamptz not null default now()
);
alter table public.pin_serviceability_cache enable row level security;
grant select, insert, update on public.pin_serviceability_cache to jw_commerce_api, jw_worker;
create policy pin_cache_read on public.pin_serviceability_cache for select to jw_commerce_api, jw_worker using (true);
create policy pin_cache_write on public.pin_serviceability_cache for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'fulfillment') or private.is_system())
  with check (private.admin_role() in ('admin', 'fulfillment') or private.is_system());
create policy pin_cache_worker on public.pin_serviceability_cache for all to jw_worker using (true) with check (true);

-- Provider events and manual events never duplicate (webhook retries, reconciliation overlap).
create unique index shipment_events_dedupe on public.shipment_events(shipment_id, occurred_at, status, md5(description));

-- Customer quotes consult the cached provider verdict through a narrow definer function (settings stay private).
create function private.pin_provider_blocked(p text) returns boolean language sql stable
security definer set search_path = pg_catalog, public as $$
  select coalesce((select s.require_provider_check from public.shipping_settings s where s.id = 1), false)
     and exists (select 1 from public.pin_serviceability_cache k where k.pin = p and not k.serviceable and k.checked_at > now() - interval '24 hours')
$$;
revoke all on function private.pin_provider_blocked(text) from public, anon, authenticated;
grant execute on function private.pin_provider_blocked(text) to jw_commerce_api, jw_worker;

-- Provider webhooks and reconciliation apply shipment progress as the system actor.
create policy shipments_system_update on public.shipments for update to jw_commerce_api
  using (private.is_system()) with check (private.is_system());
create policy shipment_events_system_insert on public.shipment_events for insert to jw_commerce_api
  with check (private.is_system());
