-- B12: coupons + discount allocation, message templates.

create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  description text not null default '' check (length(description) <= 300),
  kind text not null check (kind in ('percentage', 'flat', 'free_shipping')),
  value_bps integer check (value_bps between 1 and 10000),
  value_paise integer check (value_paise > 0),
  min_order_paise integer not null default 0 check (min_order_paise >= 0),
  max_discount_paise integer check (max_discount_paise > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit_total integer check (usage_limit_total > 0),
  usage_limit_per_customer integer not null default 1 check (usage_limit_per_customer > 0),
  first_order_only boolean not null default false,
  scope_product_ids text[] not null default '{}',
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'percentage' and value_bps is not null and value_paise is null)
      or (kind = 'flat' and value_paise is not null and value_bps is null)
      or (kind = 'free_shipping' and value_bps is null and value_paise is null)),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table public.coupon_redemptions (
  id bigint generated always as identity primary key,
  coupon_id uuid not null references public.coupons(id),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  user_id uuid not null,
  discount_paise integer not null check (discount_paise >= 0),
  shipping_discount_paise integer not null default 0 check (shipping_discount_paise >= 0),
  released_at timestamptz,
  created_at timestamptz not null default now()
);
create index coupon_redemptions_coupon_idx on public.coupon_redemptions(coupon_id) where released_at is null;
create index coupon_redemptions_user_idx on public.coupon_redemptions(coupon_id, user_id) where released_at is null;

alter table public.carts add column if not exists coupon_code text;
alter table public.checkout_quotes
  add column if not exists coupon_id uuid references public.coupons(id),
  add column if not exists coupon_code text,
  add column if not exists shipping_discount_paise integer not null default 0;
alter table public.orders
  add column if not exists coupon_id uuid references public.coupons(id),
  add column if not exists coupon_code text,
  add column if not exists shipping_discount_paise integer not null default 0;
alter table public.order_items add column if not exists discount_paise integer not null default 0 check (discount_paise >= 0);

-- A cancelled/expired order gives its coupon use back.
create function private.release_coupon_on_end() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('cancelled', 'expired') and old.status is distinct from new.status then
    update public.coupon_redemptions set released_at = now() where order_id = new.id and released_at is null;
  end if;
  return new;
end $$;
revoke all on function private.release_coupon_on_end() from public, anon, authenticated;
create trigger orders_release_coupon after update of status on public.orders
  for each row execute function private.release_coupon_on_end();

alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;
grant select, insert, update on public.coupons to jw_commerce_api;
grant select, insert, update on public.coupon_redemptions to jw_commerce_api;
grant select, update on public.coupon_redemptions to jw_worker;

-- Customers can read ACTIVE coupons (needed to validate a code they typed); admins read/write all.
create policy coupons_read on public.coupons for select to jw_commerce_api
  using (active or private.admin_role() is not null);
create policy coupons_admin_insert on public.coupons for insert to jw_commerce_api
  with check (private.admin_role() = 'admin');
create policy coupons_admin_update on public.coupons for update to jw_commerce_api
  using (private.admin_role() = 'admin') with check (private.admin_role() = 'admin');
create policy redemptions_read on public.coupon_redemptions for select to jw_commerce_api
  using (user_id = private.actor_id() or private.admin_role() is not null or private.is_system());
create policy redemptions_insert on public.coupon_redemptions for insert to jw_commerce_api
  with check (user_id = private.actor_id() or private.is_system());
create policy redemptions_update on public.coupon_redemptions for update to jw_commerce_api
  using (private.is_system()) with check (private.is_system());

-- ------------------------------------------------------- message templates
create table public.message_templates (
  key text primary key check (key ~ '^[a-z][a-z0-9_.]{2,63}$'),
  channel text not null default 'email' check (channel in ('email')),
  subject text not null check (length(subject) between 1 and 200),
  body text not null check (length(body) between 1 and 8000),
  enabled boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.message_templates enable row level security;
grant select, insert, update, delete on public.message_templates to jw_commerce_api;
grant select on public.message_templates to jw_worker;
create policy message_templates_read on public.message_templates for select to jw_commerce_api, jw_worker
  using (private.admin_role() is not null or private.is_system());
create policy message_templates_write on public.message_templates for all to jw_commerce_api
  using (private.admin_role() = 'admin') with check (private.admin_role() = 'admin');

-- Usage totals span ALL customers, which row-level security hides from the customer role, so they are computed here.
create function private.coupon_usage(p_coupon uuid, p_user uuid)
  returns table (total integer, mine integer) language sql stable security definer set search_path = public as $$
  select count(*)::int, (count(*) filter (where user_id = p_user))::int
    from public.coupon_redemptions where coupon_id = p_coupon and released_at is null
$$;
revoke all on function private.coupon_usage(uuid, uuid) from public, anon, authenticated;
grant execute on function private.coupon_usage(uuid, uuid) to jw_commerce_api;
