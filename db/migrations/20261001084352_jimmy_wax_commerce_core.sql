-- JIMMY WAX commerce foundation. All browser/mobile access is RLS-protected.
-- Prices are stored as integer paisa; quantities and order totals are server-owned.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.store_settings (
  id smallint primary key default 1 check (id = 1),
  shipping_fee_paise integer not null default 4000 check (shipping_fee_paise >= 0),
  free_shipping_threshold_paise integer check (free_shipping_threshold_paise >= 0),
  cod_enabled boolean not null default true,
  cod_max_order_paise integer check (cod_max_order_paise >= 0),
  checkout_enabled boolean not null default false,
  checkout_policy_confirmed boolean not null default false,
  delivery_estimate text not null default '3–5 business days',
  updated_at timestamptz not null default now()
);

create table public.categories (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  name text not null unique,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.products (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  category_id text not null references public.categories(id),
  name text not null,
  subtitle text not null default '',
  description text not null default '',
  key_benefits text[] not null default '{}',
  suitable_surfaces text,
  box_contents text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.product_variants (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  product_id text not null references public.products(id) on delete cascade,
  sku text not null unique,
  title text not null default 'Default',
  price_paise integer not null check (price_paise >= 0),
  compare_at_price_paise integer check (compare_at_price_paise is null or compare_at_price_paise >= price_paise),
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index product_variants_product_id_idx on public.product_variants(product_id);

create table public.product_media (
  id bigint generated always as identity primary key,
  product_id text not null references public.products(id) on delete cascade,
  asset_path text not null,
  alt_text text not null,
  position integer not null default 0 check (position >= 0),
  unique (product_id, position)
);
create index product_media_product_id_idx on public.product_media(product_id, position);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  default_payment_method text not null default 'cod' check (default_payment_method = 'cod'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recipient_name text not null check (length(trim(recipient_name)) between 1 and 120),
  phone text not null check (phone ~ '^[0-9+() -]{7,20}$'),
  line1 text not null check (length(trim(line1)) between 1 and 240),
  landmark text not null default '',
  city text not null check (length(trim(city)) between 1 and 100),
  state text not null check (length(trim(state)) between 1 and 100),
  postal_code text not null check (postal_code ~ '^[0-9]{6}$'),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index addresses_user_id_idx on public.addresses(user_id);
create unique index addresses_one_default_per_user_idx on public.addresses(user_id) where is_default;

create table public.cart_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  variant_id text not null references public.product_variants(id) on delete cascade,
  quantity integer not null check (quantity between 1 and 99),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, variant_id)
);

create table public.wishlist_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references public.products(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  title text not null check (length(trim(title)) between 1 and 120),
  body text not null check (length(trim(body)) between 1 and 3000),
  photo_path text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  verified_purchase boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, user_id)
);
create index reviews_product_approved_idx on public.reviews(product_id, created_at desc) where status = 'approved';

create table public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  order_updates boolean not null default true,
  offers_and_care_tips boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null,
  data jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_created_idx on public.notifications(user_id, created_at desc);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  user_id uuid not null references auth.users(id),
  address_id uuid not null references public.addresses(id),
  address_snapshot jsonb not null default '{}',
  payment_method text not null check (payment_method in ('cod')),
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid', 'failed', 'refunded')),
  status text not null default 'placed' check (status in ('placed', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'returned')),
  subtotal_paise integer not null default 0 check (subtotal_paise >= 0),
  shipping_paise integer not null default 0 check (shipping_paise >= 0),
  total_paise integer not null default 0 check (total_paise >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_user_created_idx on public.orders(user_id, created_at desc);

create table public.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id text not null references public.products(id),
  variant_id text not null references public.product_variants(id),
  sku text not null,
  product_name text not null,
  variant_title text not null,
  asset_path text not null,
  unit_price_paise integer not null check (unit_price_paise >= 0),
  quantity integer not null check (quantity between 1 and 99),
  line_total_paise integer not null check (line_total_paise >= 0)
);
create index order_items_order_id_idx on public.order_items(order_id);

create table public.payment_records (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  provider text not null check (provider in ('cash_on_delivery', 'gateway')),
  status text not null check (status in ('pending', 'authorized', 'captured', 'failed', 'refunded')),
  amount_paise integer not null check (amount_paise >= 0),
  provider_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function private.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), ''))
  on conflict (id) do nothing;
  insert into public.notification_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function private.create_profile_for_auth_user() from public, anon, authenticated;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.create_profile_for_auth_user();

create function private.prepare_new_order()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  saved_address public.addresses%rowtype;
begin
  if auth.uid() is null or new.user_id is distinct from auth.uid() then
    raise exception 'An authenticated user may only place their own order' using errcode = '42501';
  end if;
  if new.payment_method <> 'cod' then
    raise exception 'This payment method is not configured' using errcode = '22023';
  end if;
  select * into saved_address
  from public.addresses
  where id = new.address_id and user_id = new.user_id;
  if not found then
    raise exception 'Choose one of your saved delivery addresses' using errcode = '23503';
  end if;
  new.order_number := 'JW-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' || upper(substr(replace(new.id::text, '-', ''), 1, 8));
  new.address_snapshot := jsonb_build_object(
    'name', saved_address.recipient_name,
    'phone', saved_address.phone,
    'address', saved_address.line1,
    'landmark', saved_address.landmark,
    'city', saved_address.city,
    'state', saved_address.state,
    'pin', saved_address.postal_code
  );
  new.status := 'placed';
  new.payment_status := 'pending';
  new.subtotal_paise := 0;
  new.shipping_paise := 0;
  new.total_paise := 0;
  return new;
end;
$$;
revoke all on function private.prepare_new_order() from public, anon, authenticated;
create trigger prepare_new_order_before_insert
  before insert on public.orders
  for each row execute function private.prepare_new_order();

create function private.finalize_new_order()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  policy public.store_settings%rowtype;
  line record;
  item_count integer := 0;
  subtotal integer := 0;
  shipping integer := 0;
begin
  if auth.uid() is null or new.user_id is distinct from auth.uid() then
    raise exception 'An authenticated user may only place their own order' using errcode = '42501';
  end if;
  select * into policy from public.store_settings where id = 1 for share;
  if not found or not policy.checkout_enabled or not policy.checkout_policy_confirmed then
    raise exception 'Checkout is not available until store policies are confirmed' using errcode = '55000';
  end if;
  if new.payment_method <> 'cod' or not policy.cod_enabled then
    raise exception 'Cash on Delivery is not currently available' using errcode = '22023';
  end if;

  for line in
    select ci.variant_id, ci.quantity, v.product_id, v.sku, v.title,
           v.price_paise, v.stock_quantity, p.name, m.asset_path
    from public.cart_items ci
    join public.product_variants v on v.id = ci.variant_id and v.active
    join public.products p on p.id = v.product_id and p.active
    join lateral (
      select pm.asset_path from public.product_media pm
      where pm.product_id = p.id order by pm.position limit 1
    ) m on true
    where ci.user_id = new.user_id
    order by ci.variant_id
    for update of v
  loop
    if line.stock_quantity < line.quantity then
      raise exception 'Insufficient stock for %', line.name using errcode = '23514';
    end if;
    item_count := item_count + 1;
    subtotal := subtotal + line.price_paise * line.quantity;
    insert into public.order_items (
      order_id, product_id, variant_id, sku, product_name, variant_title,
      asset_path, unit_price_paise, quantity, line_total_paise
    ) values (
      new.id, line.product_id, line.variant_id, line.sku, line.name, line.title,
      line.asset_path, line.price_paise, line.quantity, line.price_paise * line.quantity
    );
    update public.product_variants
      set stock_quantity = stock_quantity - line.quantity, updated_at = now()
      where id = line.variant_id;
  end loop;

  if item_count = 0 then
    raise exception 'Your cart is empty or contains unavailable products' using errcode = '22023';
  end if;
  if policy.cod_max_order_paise is not null and subtotal > policy.cod_max_order_paise then
    raise exception 'This order exceeds the Cash on Delivery limit' using errcode = '22023';
  end if;
  shipping := case
    when policy.free_shipping_threshold_paise is not null
      and subtotal >= policy.free_shipping_threshold_paise then 0
    else policy.shipping_fee_paise
  end;

  update public.orders
    set subtotal_paise = subtotal, shipping_paise = shipping,
        total_paise = subtotal + shipping, updated_at = now()
    where id = new.id;
  delete from public.cart_items where user_id = new.user_id;
  insert into public.payment_records (order_id, provider, status, amount_paise)
    values (new.id, 'cash_on_delivery', 'pending', subtotal + shipping);
  insert into public.notifications (user_id, kind, title, body, data)
    values (new.user_id, 'order_placed', 'Order placed',
      'Your JIMMY WAX order ' || new.order_number || ' has been placed.',
      jsonb_build_object('order_id', new.id, 'order_number', new.order_number));
  return new;
end;
$$;
revoke all on function private.finalize_new_order() from public, anon, authenticated;
create trigger finalize_new_order_after_insert
  after insert on public.orders
  for each row execute function private.finalize_new_order();

-- Batch replacement APIs keep each app-side cart/wishlist update atomic without
-- requiring a privileged key or allowing a caller to target another account.
create function public.replace_my_cart(p_items jsonb)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to save your cart' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Cart payload is invalid' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'Cart payload is too large' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) as items(value)
    where coalesce(value ->> 'variant_id', '') !~ '^[a-z0-9-]+$'
      or coalesce(value ->> 'quantity', '') !~ '^[1-9][0-9]?$'
      or (value ->> 'quantity')::integer > 99
  ) then
    raise exception 'Cart payload contains an invalid item' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) as items(value)
    group by value ->> 'variant_id' having count(*) > 1
  ) then
    raise exception 'Cart payload contains duplicate variants' using errcode = '22023';
  end if;

  delete from public.cart_items ci
  where ci.user_id = auth.uid()
    and not exists (
      select 1 from jsonb_array_elements(p_items) as items(value)
      where value ->> 'variant_id' = ci.variant_id
    );

  insert into public.cart_items (user_id, variant_id, quantity)
  select auth.uid(), value ->> 'variant_id', (value ->> 'quantity')::integer
  from jsonb_array_elements(p_items) as items(value)
  join public.product_variants v on v.id = value ->> 'variant_id' and v.active
  join public.products p on p.id = v.product_id and p.active
  on conflict (user_id, variant_id) do update
    set quantity = excluded.quantity, updated_at = now();
end;
$$;
revoke all on function public.replace_my_cart(jsonb) from public, anon;
grant execute on function public.replace_my_cart(jsonb) to authenticated;

create function public.replace_my_wishlist(p_product_ids text[])
returns void
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to save your wishlist' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_product_ids), 0) > 100 then
    raise exception 'Wishlist payload is too large' using errcode = '22023';
  end if;
  delete from public.wishlist_items wi
  where wi.user_id = auth.uid()
    and not (wi.product_id = any(coalesce(p_product_ids, '{}'::text[])));
  insert into public.wishlist_items (user_id, product_id)
  select auth.uid(), candidate.id
  from unnest(coalesce(p_product_ids, '{}'::text[])) as requested(id)
  join public.products candidate on candidate.id = requested.id and candidate.active
  on conflict (user_id, product_id) do nothing;
end;
$$;
revoke all on function public.replace_my_wishlist(text[]) from public, anon;
grant execute on function public.replace_my_wishlist(text[]) to authenticated;

alter table public.store_settings enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_media enable row level security;
alter table public.profiles enable row level security;
alter table public.addresses enable row level security;
alter table public.cart_items enable row level security;
alter table public.wishlist_items enable row level security;
alter table public.reviews enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notifications enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payment_records enable row level security;

create policy "public reads store settings" on public.store_settings for select to anon, authenticated using (true);
create policy "admins manage store settings" on public.store_settings for all to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy "public reads active categories" on public.categories for select to anon, authenticated using (active);
create policy "admins manage categories" on public.categories for all to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy "public reads active products" on public.products for select to anon, authenticated using (active);
create policy "admins manage products" on public.products for all to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy "public reads active variants" on public.product_variants for select to anon, authenticated using (active);
create policy "admins manage variants" on public.product_variants for all to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy "public reads product media" on public.product_media for select to anon, authenticated
  using (exists (select 1 from public.products p where p.id = product_id and p.active));
create policy "admins manage product media" on public.product_media for all to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "users read own profile" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "users update own profile" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "users manage own addresses" on public.addresses for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "users manage own cart" on public.cart_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "users manage own wishlist" on public.wishlist_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "users read visible reviews" on public.reviews for select to anon, authenticated
  using (status = 'approved' or user_id = (select auth.uid()));
create policy "users submit own pending reviews" on public.reviews for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'pending' and not verified_purchase);
create policy "admins manage reviews" on public.reviews for all to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy "users read own notification preferences" on public.notification_preferences for select to authenticated
  using (user_id = (select auth.uid()));
create policy "users update own notification preferences" on public.notification_preferences for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "users read own notifications" on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy "users mark own notifications read" on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "admins create notifications" on public.notifications for insert to authenticated
  with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy "users read own orders" on public.orders for select to authenticated
  using (user_id = (select auth.uid()));
create policy "users create own orders" on public.orders for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "users read own order items" on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid())));
create policy "users read own payment records" on public.payment_records for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid())));

-- Explicit Data API grants are required; RLS is the row-level authorization layer.
grant select on public.store_settings, public.categories, public.products,
  public.product_variants, public.product_media to anon, authenticated;
grant select on public.reviews to anon;
grant select, insert, update, delete on public.addresses, public.cart_items,
  public.wishlist_items to authenticated;
grant select, update on public.profiles, public.notification_preferences,
  public.notifications to authenticated;
grant select, insert on public.reviews, public.orders to authenticated;
grant select on public.order_items, public.payment_records to authenticated;
grant insert, update, delete on public.categories, public.products,
  public.product_variants, public.product_media, public.store_settings,
  public.reviews, public.notifications to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Product imagery remains the supplied, authentic bundled photography. Database media
-- records point to Flutter asset paths; no invented product artwork is introduced.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('product-media', 'product-media', true, 10485760, array['image/jpeg', 'image/png', 'image/webp']),
  ('review-photos', 'review-photos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
create policy "public reads product media objects" on storage.objects for select to anon, authenticated
  using (bucket_id = 'product-media');
create policy "admins manage product media objects" on storage.objects for all to authenticated
  using (bucket_id = 'product-media' and (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check (bucket_id = 'product-media' and (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
create policy "users manage own review photos" on storage.objects for all to authenticated
  using (bucket_id = 'review-photos' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'review-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
