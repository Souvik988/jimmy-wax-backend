-- EXPAND migration: adds the transactional commerce core used by the Express
-- commerce API WITHOUT changing the legacy checkout path. The legacy trigger
-- (private.finalize_new_order) stays the sole checkout/inventory authority until
-- supabase/cutover/20261002110000_checkout_authority_cutover.sql is applied.
-- See docs/build/MIGRATION_PLAN.md.

-- ---------------------------------------------------------------- roles
-- Group roles only. Login users (with secrets) are provisioned by infrastructure
-- and granted membership; no password ever lives in a migration.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'jw_commerce_api') then create role jw_commerce_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'jw_worker') then create role jw_worker nologin; end if;
end $$;
grant usage on schema public to jw_commerce_api, jw_worker;
grant usage on schema private to jw_commerce_api, jw_worker;

-- Actor propagation helpers. Values are set with set_config(..., true) INSIDE a
-- transaction by the API after verifying the JWT; they never survive COMMIT/ROLLBACK.
create function private.actor_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.actor_id', true), '')::uuid $$;
create function private.is_system() returns boolean
language sql stable as $$ select coalesce(current_setting('app.system', true), '') = '1' $$;
grant execute on function private.actor_id(), private.is_system() to jw_commerce_api, jw_worker;

-- ------------------------------------------------------ store settings gates
alter table public.store_settings
  add column checkout_authority text not null default 'legacy_trigger'
    check (checkout_authority in ('legacy_trigger', 'express')),
  add column online_payments_enabled boolean not null default false,
  add column payment_window_minutes integer check (payment_window_minutes between 5 and 1440),
  add column quote_ttl_minutes integer not null default 15 check (quote_ttl_minutes between 1 and 120),
  add column rules_version integer not null default 1,
  add column version integer not null default 1;
-- payment_window_minutes stays NULL (unconfirmed) so online payment cannot start.

-- ------------------------------------------------------------ admin access
create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('support', 'catalog', 'fulfillment', 'finance', 'admin')),
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.admin_users enable row level security;

-- ---------------------------------------------------------------- carts
create table public.carts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete cascade,
  guest_token_hash text unique,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  check ((user_id is not null) <> (guest_token_hash is not null))
);
create table public.cart_lines (
  cart_id uuid not null references public.carts(id) on delete cascade,
  variant_id text not null references public.product_variants(id) on delete cascade,
  quantity integer not null check (quantity between 1 and 99),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (cart_id, variant_id)
);
-- Carry legacy server-side carts forward (idempotent).
insert into public.carts (user_id)
select distinct user_id from public.cart_items on conflict (user_id) do nothing;
insert into public.cart_lines (cart_id, variant_id, quantity)
select c.id, ci.variant_id, ci.quantity
from public.cart_items ci join public.carts c on c.user_id = ci.user_id
on conflict do nothing;

-- ------------------------------------------------------------- inventory
create table public.inventory_positions (
  variant_id text primary key references public.product_variants(id) on delete cascade,
  on_hand integer not null default 0 check (on_hand >= 0),
  reserved integer not null default 0 check (reserved >= 0),
  low_stock_threshold integer check (low_stock_threshold >= 0),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  check (reserved <= on_hand)
);
insert into public.inventory_positions (variant_id, on_hand)
select id, stock_quantity from public.product_variants on conflict do nothing;

create table public.inventory_movements (
  id bigint generated always as identity primary key,
  variant_id text not null references public.product_variants(id),
  kind text not null check (kind in ('receipt', 'adjustment', 'reserve', 'release', 'commit', 'return_restock', 'correction', 'import')),
  delta_on_hand integer not null default 0,
  delta_reserved integer not null default 0,
  reason text,
  ref_type text,
  ref_id text,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index inventory_movements_variant_idx on public.inventory_movements(variant_id, id desc);
create index inventory_movements_ref_idx on public.inventory_movements(ref_type, ref_id);
insert into public.inventory_movements (variant_id, kind, delta_on_hand, reason)
select variant_id, 'import', on_hand, 'baseline import from product_variants.stock_quantity'
from public.inventory_positions where on_hand > 0;

-- Legacy readers (Flutter reads product_variants.stock_quantity) see AVAILABLE stock,
-- derived from the ledger-backed position. Only this trigger may change it after cutover.
create function private.sync_variant_stock() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.product_variants
     set stock_quantity = greatest(new.on_hand - new.reserved, 0), updated_at = now()
   where id = new.variant_id and stock_quantity is distinct from greatest(new.on_hand - new.reserved, 0);
  return new;
end $$;
revoke all on function private.sync_variant_stock() from public, anon, authenticated;
-- Dormant while legacy authority is active (positions are not written by the legacy path);
-- enabled by the cutover script so exactly one side writes stock.

-- Every variant (including ones created later, e.g. by the seed or an operator) always
-- gets exactly one position row; stock starts at zero until a receipt is recorded.
create function private.ensure_inventory_position() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.inventory_positions (variant_id, on_hand) values (new.id, 0) on conflict do nothing;
  return new;
end $$;
revoke all on function private.ensure_inventory_position() from public, anon, authenticated;
create trigger ensure_inventory_position after insert on public.product_variants
  for each row execute function private.ensure_inventory_position();

create table public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  variant_id text not null references public.product_variants(id),
  quantity integer not null check (quantity > 0),
  status text not null default 'active' check (status in ('active', 'committed', 'released', 'expired')),
  expires_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (order_id, variant_id)
);
create index stock_reservations_expiry_idx on public.stock_reservations(expires_at) where status = 'active';

-- --------------------------------------------------------------- orders
-- Deleting a saved address must never touch purchase history (the immutable
-- snapshot already lives on the order).
alter table public.orders alter column address_id drop not null;
alter table public.orders drop constraint orders_address_id_fkey;
alter table public.orders add constraint orders_address_id_fkey
  foreign key (address_id) references public.addresses(id) on delete set null;

alter table public.orders
  add column currency text not null default 'INR' check (currency = 'INR'),
  add column discount_paise integer not null default 0 check (discount_paise >= 0),
  add column tax_paise integer not null default 0 check (tax_paise >= 0),
  add column quote_id uuid,
  add column idempotency_key text,
  add column rules_version integer not null default 1,
  add column version integer not null default 1,
  add column cancel_reason text,
  add column placed_via text not null default 'legacy_trigger' check (placed_via in ('legacy_trigger', 'express'));
create unique index orders_user_idempotency_uidx on public.orders(user_id, idempotency_key) where idempotency_key is not null;
create index orders_status_created_idx on public.orders(status, created_at desc);

alter table public.orders drop constraint orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check check (payment_method in ('cod', 'online'));
alter table public.orders drop constraint orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check check (payment_status in (
  'pending', 'authorized', 'paid', 'failed', 'refunded', 'partially_refunded',
  'cod_due', 'cod_collected', 'cod_failed', 'exception'));
alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check check (status in (
  'pending_payment', 'placed', 'confirmed', 'processing', 'shipped', 'out_for_delivery',
  'delivered', 'cancelled', 'returned', 'expired'));
alter table public.orders add constraint orders_total_reconciles
  check (placed_via = 'legacy_trigger' or total_paise = subtotal_paise - discount_paise + shipping_paise + tax_paise);

alter table public.payment_records drop constraint payment_records_provider_check;
alter table public.payment_records add constraint payment_records_provider_check check (provider in ('cash_on_delivery', 'gateway'));

-- Order state machine: who may move an order where. Enforced in the database so
-- no code path (API, worker, SQL console) can skip a state.
create table private.order_transitions (from_status text not null, to_status text not null, primary key (from_status, to_status));
insert into private.order_transitions values
  ('pending_payment', 'placed'), ('pending_payment', 'expired'), ('pending_payment', 'cancelled'),
  ('placed', 'confirmed'), ('placed', 'cancelled'),
  ('confirmed', 'processing'), ('confirmed', 'cancelled'),
  ('processing', 'shipped'), ('processing', 'cancelled'),
  ('shipped', 'out_for_delivery'), ('shipped', 'delivered'), ('shipped', 'returned'),
  ('out_for_delivery', 'delivered'), ('out_for_delivery', 'returned'),
  ('delivered', 'returned');
create function private.guard_order_transition() returns trigger language plpgsql
security definer set search_path = pg_catalog, public as $$
begin
  if old.status is distinct from new.status
     and not exists (select 1 from private.order_transitions t where t.from_status = old.status and t.to_status = new.status) then
    raise exception 'Illegal order transition % -> %', old.status, new.status using errcode = '23514';
  end if;
  if new.version = old.version and (old.status is distinct from new.status or old.payment_status is distinct from new.payment_status) then
    new.version := old.version + 1;
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke all on function private.guard_order_transition() from public, anon, authenticated;
create trigger guard_order_transition before update on public.orders
  for each row execute function private.guard_order_transition();

-- ----------------------------------------------------- quotes + idempotency
create table public.checkout_quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cart_id uuid not null references public.carts(id) on delete cascade,
  cart_version integer not null,
  address_id uuid references public.addresses(id) on delete set null,
  address_snapshot jsonb not null,
  payment_method text not null check (payment_method in ('cod', 'online')),
  lines jsonb not null,
  currency text not null default 'INR',
  subtotal_paise integer not null check (subtotal_paise >= 0),
  discount_paise integer not null default 0 check (discount_paise >= 0),
  tax_paise integer not null default 0 check (tax_paise >= 0),
  shipping_paise integer not null check (shipping_paise >= 0),
  total_paise integer not null check (total_paise >= 0),
  rules_version integer not null,
  expires_at timestamptz not null,
  consumed_order_id uuid,
  created_at timestamptz not null default now()
);
create index checkout_quotes_user_idx on public.checkout_quotes(user_id, created_at desc);
alter table public.orders add constraint orders_quote_fk foreign key (quote_id) references public.checkout_quotes(id);

create table public.idempotency_keys (
  scope text not null,                 -- e.g. 'order:<userId>'
  key text not null,
  request_hash text not null,
  state text not null default 'in_progress' check (state in ('in_progress', 'completed')),
  response_status integer,
  response_body jsonb,
  resource_type text,
  resource_id text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null default now() + interval '90 days',
  primary key (scope, key)
);

-- ------------------------------------------------------------- payments
create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  provider text not null,
  method text,
  status text not null default 'created' check (status in ('created', 'pending', 'authorized', 'captured', 'failed', 'expired', 'cancelled')),
  amount_paise integer not null check (amount_paise > 0),
  currency text not null default 'INR',
  provider_order_id text,
  provider_payment_id text,
  idempotency_key text,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_order_id),
  unique (order_id, idempotency_key)
);
-- At most one live attempt per order: prevents unsafe simultaneous attempts.
create unique index payment_attempts_one_live_uidx on public.payment_attempts(order_id) where status in ('created', 'pending', 'authorized');
create index payment_attempts_provider_payment_idx on public.payment_attempts(provider, provider_payment_id);

create table public.payment_events (
  id bigint generated always as identity primary key,
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  payload jsonb not null,
  signature_verified boolean not null,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  attempts integer not null default 0,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, provider_event_id)
);
create index payment_events_pending_idx on public.payment_events(id) where status in ('received', 'failed');

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  payment_attempt_id uuid references public.payment_attempts(id),
  amount_paise integer not null check (amount_paise > 0),
  status text not null default 'requested' check (status in ('requested', 'pending', 'processed', 'failed')),
  reason text not null,
  idempotency_key text not null,
  provider_refund_id text,
  requested_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, idempotency_key)
);
-- Over-refund guard: sum of non-failed refunds can never exceed the order total.
create function private.guard_refund_total() returns trigger language plpgsql
security definer set search_path = pg_catalog, public as $$
declare paid integer; refunded integer;
begin
  -- An idempotent re-insert (same order + key) is discarded by ON CONFLICT DO NOTHING; do not reject it here.
  if tg_op = 'INSERT' and exists (select 1 from public.refunds r where r.order_id = new.order_id and r.idempotency_key = new.idempotency_key) then
    return new;
  end if;
  select o.total_paise into paid from public.orders o where o.id = new.order_id for update;
  select coalesce(sum(amount_paise), 0) into refunded from public.refunds
   where order_id = new.order_id and status <> 'failed' and id is distinct from new.id;
  if new.status <> 'failed' and refunded + new.amount_paise > paid then
    raise exception 'Refund exceeds refundable amount' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.guard_refund_total() from public, anon, authenticated;
create trigger guard_refund_total before insert or update of amount_paise, status on public.refunds
  for each row execute function private.guard_refund_total();

-- ------------------------------------------------- outbox / inbox / audit
create table public.outbox (
  id bigint generated always as identity primary key,
  aggregate_type text not null,
  aggregate_id text not null,
  event_type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  claimed_by text,
  claim_expires_at timestamptz,
  attempts integer not null default 0,
  published_at timestamptz,
  dead_at timestamptz,
  last_error text
);
create index outbox_pending_idx on public.outbox(available_at, id) where published_at is null and dead_at is null;
create table public.inbox (
  consumer text not null,
  event_id bigint not null,
  processed_at timestamptz not null default now(),
  primary key (consumer, event_id)
);
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_role text,
  action text not null,
  resource_type text not null,
  resource_id text,
  reason text,
  before jsonb,
  after jsonb,
  request_id text,
  created_at timestamptz not null default now()
);
create index audit_log_resource_idx on public.audit_log(resource_type, resource_id, id desc);
create function private.audit_log_immutable() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only' using errcode = '55000'; end $$;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function private.audit_log_immutable();

-- ----------------------------------------------- grants + actor-scoped RLS
alter table public.carts enable row level security;
alter table public.cart_lines enable row level security;
alter table public.inventory_positions enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.stock_reservations enable row level security;
alter table public.checkout_quotes enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.payment_attempts enable row level security;
alter table public.payment_events enable row level security;
alter table public.refunds enable row level security;
alter table public.outbox enable row level security;
alter table public.inbox enable row level security;
alter table public.audit_log enable row level security;
-- No Data API access to any new table: anon/authenticated get nothing.

-- jw_commerce_api: customer-owned rows by verified actor; system rows only in system mode.
grant select on public.store_settings, public.categories, public.products, public.product_variants,
  public.product_media, public.admin_users to jw_commerce_api, jw_worker;
grant select, insert, update, delete on public.carts, public.cart_lines, public.addresses,
  public.wishlist_items to jw_commerce_api;
grant select, insert, update on public.profiles, public.notification_preferences to jw_commerce_api;
grant select, update on public.notifications to jw_commerce_api;
grant select, insert, update on public.orders, public.checkout_quotes, public.payment_attempts,
  public.stock_reservations, public.refunds, public.idempotency_keys, public.inventory_positions to jw_commerce_api;
grant select, insert on public.order_items, public.payment_records, public.inventory_movements,
  public.audit_log, public.outbox, public.reviews to jw_commerce_api;
grant update on public.payment_records to jw_commerce_api;
grant select, insert, update on public.payment_events to jw_commerce_api;
grant select, insert, update, delete on public.notifications to jw_worker;
grant select, insert, update on public.outbox, public.inbox, public.payment_events, public.payment_attempts,
  public.orders, public.stock_reservations, public.inventory_positions, public.refunds to jw_worker;
grant select, insert on public.inventory_movements, public.audit_log to jw_worker;
grant select, update on public.idempotency_keys to jw_worker;
grant delete on public.idempotency_keys, public.checkout_quotes to jw_worker;
grant select on public.order_items, public.payment_records, public.checkout_quotes, public.carts, public.cart_lines,
  public.notification_preferences to jw_worker;
grant update on public.payment_records to jw_worker;
grant usage, select on all sequences in schema public to jw_commerce_api, jw_worker;
grant execute on function private.sync_variant_stock() to jw_commerce_api, jw_worker;

create policy api_carts on public.carts for all to jw_commerce_api
  using (user_id = private.actor_id() or private.is_system() or guest_token_hash is not null)
  with check (user_id = private.actor_id() or private.is_system() or guest_token_hash is not null);
create policy api_cart_lines on public.cart_lines for all to jw_commerce_api
  using (exists (select 1 from public.carts c where c.id = cart_id and (c.user_id = private.actor_id() or private.is_system() or c.guest_token_hash is not null)))
  with check (exists (select 1 from public.carts c where c.id = cart_id and (c.user_id = private.actor_id() or private.is_system() or c.guest_token_hash is not null)));
create policy api_addresses on public.addresses for all to jw_commerce_api
  using (user_id = private.actor_id()) with check (user_id = private.actor_id());
create policy api_wishlist on public.wishlist_items for all to jw_commerce_api
  using (user_id = private.actor_id()) with check (user_id = private.actor_id());
create policy api_profiles on public.profiles for all to jw_commerce_api
  using (id = private.actor_id()) with check (id = private.actor_id());
create policy api_notif_prefs on public.notification_preferences for all to jw_commerce_api
  using (user_id = private.actor_id()) with check (user_id = private.actor_id());
create policy api_notifications on public.notifications for all to jw_commerce_api
  using (user_id = private.actor_id()) with check (user_id = private.actor_id());
create policy api_orders on public.orders for all to jw_commerce_api
  using (user_id = private.actor_id() or private.is_system()) with check (user_id = private.actor_id() or private.is_system());
create policy api_order_items on public.order_items for all to jw_commerce_api
  using (exists (select 1 from public.orders o where o.id = order_id and (o.user_id = private.actor_id() or private.is_system())))
  with check (exists (select 1 from public.orders o where o.id = order_id and (o.user_id = private.actor_id() or private.is_system())));
create policy api_payment_records on public.payment_records for all to jw_commerce_api
  using (exists (select 1 from public.orders o where o.id = order_id and (o.user_id = private.actor_id() or private.is_system())))
  with check (exists (select 1 from public.orders o where o.id = order_id and (o.user_id = private.actor_id() or private.is_system())));
create policy api_quotes on public.checkout_quotes for all to jw_commerce_api
  using (user_id = private.actor_id()) with check (user_id = private.actor_id());
create policy api_attempts on public.payment_attempts for all to jw_commerce_api
  using (exists (select 1 from public.orders o where o.id = order_id and (o.user_id = private.actor_id() or private.is_system())))
  with check (exists (select 1 from public.orders o where o.id = order_id and (o.user_id = private.actor_id() or private.is_system())));
create policy api_reservations on public.stock_reservations for all to jw_commerce_api
  using (private.is_system() or exists (select 1 from public.orders o where o.id = order_id and o.user_id = private.actor_id()))
  with check (private.is_system() or exists (select 1 from public.orders o where o.id = order_id and o.user_id = private.actor_id()));
create policy api_refunds on public.refunds for all to jw_commerce_api
  using (private.is_system() or exists (select 1 from public.orders o where o.id = order_id and o.user_id = private.actor_id()))
  with check (private.is_system() or exists (select 1 from public.orders o where o.id = order_id and o.user_id = private.actor_id()));
create policy api_idem on public.idempotency_keys for all to jw_commerce_api
  using (private.actor_id() is not null or private.is_system()) with check (private.actor_id() is not null or private.is_system());
create policy api_positions on public.inventory_positions for all to jw_commerce_api using (true) with check (true);
create policy api_movements on public.inventory_movements for all to jw_commerce_api using (true) with check (true);
create policy api_audit on public.audit_log for all to jw_commerce_api using (true) with check (true);
create policy api_outbox on public.outbox for all to jw_commerce_api using (true) with check (true);
create policy api_payment_events on public.payment_events for all to jw_commerce_api using (private.is_system()) with check (private.is_system());
create policy api_reviews on public.reviews for all to jw_commerce_api
  using (status = 'approved' or user_id = private.actor_id() or private.is_system())
  with check (user_id = private.actor_id() or private.is_system());
create policy api_admin_users on public.admin_users for select to jw_commerce_api, jw_worker using (true);
create policy api_catalog_store on public.store_settings for select to jw_commerce_api, jw_worker using (true);
create policy api_catalog_cat on public.categories for select to jw_commerce_api, jw_worker using (true);
create policy api_catalog_prod on public.products for select to jw_commerce_api, jw_worker using (true);
create policy api_catalog_var on public.product_variants for select to jw_commerce_api, jw_worker using (true);
create policy api_catalog_media on public.product_media for select to jw_commerce_api, jw_worker using (true);

-- Worker: system-wide on operational tables.
create policy worker_all_orders on public.orders for all to jw_worker using (true) with check (true);
create policy worker_all_notifications on public.notifications for all to jw_worker using (true) with check (true);
create policy worker_outbox on public.outbox for all to jw_worker using (true) with check (true);
create policy worker_inbox on public.inbox for all to jw_worker using (true) with check (true);
create policy worker_events on public.payment_events for all to jw_worker using (true) with check (true);
create policy worker_attempts on public.payment_attempts for all to jw_worker using (true) with check (true);
create policy worker_res on public.stock_reservations for all to jw_worker using (true) with check (true);
create policy worker_pos on public.inventory_positions for all to jw_worker using (true) with check (true);
create policy worker_mov on public.inventory_movements for all to jw_worker using (true) with check (true);
create policy worker_audit on public.audit_log for all to jw_worker using (true) with check (true);
create policy worker_refunds on public.refunds for all to jw_worker using (true) with check (true);
create policy worker_idem on public.idempotency_keys for all to jw_worker using (true) with check (true);
create policy worker_quotes on public.checkout_quotes for all to jw_worker using (true) with check (true);
create policy worker_items on public.order_items for select to jw_worker using (true);
create policy worker_pay on public.payment_records for all to jw_worker using (true) with check (true);
create policy worker_carts on public.carts for select to jw_worker using (true);
create policy worker_lines on public.cart_lines for select to jw_worker using (true);
create policy worker_prefs on public.notification_preferences for select to jw_worker using (true);
