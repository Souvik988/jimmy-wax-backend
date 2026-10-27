-- B9: Experience Studio (documents, releases, preview tokens, campaigns, content library) + public read models.
-- Releases are immutable snapshots; the public API reads ONLY the effective snapshot through a view.

-- ----------------------------------------------------------- store facts
alter table public.store_settings
  add column support_email text check (support_email is null or support_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add column support_phone text check (support_phone is null or length(support_phone) between 7 and 20),
  add column brand_name text not null default 'JIMMY WAX' check (length(brand_name) between 2 and 60);
grant update (support_email, support_phone, brand_name) on public.store_settings to jw_commerce_api;

alter table public.media_assets add column bundled_key text check (bundled_key is null or length(bundled_key) <= 300);
create index media_assets_bundled_idx on public.media_assets(bundled_key) where bundled_key is not null;

-- ------------------------------------------------------------ read models
create or replace view public.v_catalog_products as
select p.id as product_id, p.category_id, p.name, p.subtitle, p.description, p.key_benefits, p.suitable_surfaces,
       p.box_contents, p.sort_order,
       v.id as variant_id, v.sku, v.title as variant_title, v.price_paise, v.compare_at_price_paise,
       greatest(coalesce(i.on_hand - i.reserved, 0), 0) as available,
       coalesce((select jsonb_agg(jsonb_build_object('assetPath', m.asset_path, 'alt', m.alt_text) order by m.position)
                   from public.product_media m where m.product_id = p.id), '[]'::jsonb) as media,
       p.tags, p.seo_title, p.seo_description, p.created_at as product_created_at
  from public.products p
  join public.product_variants v on v.product_id = p.id and v.active
  left join public.inventory_positions i on i.variant_id = v.id
 where p.active and p.archived_at is null;

create or replace view public.v_categories as
  select id, name, sort_order, description, image_media_id from public.categories where active;

create or replace view public.v_public_store_settings as
  select shipping_fee_paise, free_shipping_threshold_paise, cod_enabled, cod_max_order_paise,
         (checkout_enabled and checkout_policy_confirmed and checkout_authority = 'express') as checkout_open,
         delivery_estimate, cod_fee_paise, gst_rate_bps, tax_inclusive,
         support_email, support_phone, brand_name
    from public.store_settings where id = 1;

create view public.v_collections as
  select id, name, description, kind, rule, seo_title, seo_description, rev from public.collections where visible;
create view public.v_collection_items as
  select i.collection_id, i.product_id, i.position
    from public.collection_items i join public.collections c on c.id = i.collection_id where c.visible;

revoke all on public.v_collections, public.v_collection_items from public, anon, authenticated;
grant select on public.v_collections, public.v_collection_items to jw_experience;
grant select on public.v_catalog_products, public.v_categories, public.v_public_store_settings,
  public.v_collections, public.v_collection_items to jw_commerce_api;

-- --------------------------------------------------------- content library
create table public.care_guides (
  id text primary key check (id ~ '^[a-z0-9-]{2,60}$'),
  title text not null check (length(title) between 2 and 160),
  intro text not null default '' check (length(intro) <= 600),
  steps jsonb not null check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 8),
  cta jsonb,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  rev integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.stories (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 2 and 120),
  line text not null default '' check (length(line) <= 240),
  video_media_id uuid not null references public.media_assets(id),
  poster_media_id uuid not null references public.media_assets(id),
  alt text not null check (length(alt) between 3 and 300),
  product_id text references public.products(id),
  position integer not null default 0,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  rev integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.journal_notes (
  id text primary key check (id ~ '^[a-z0-9-]{2,80}$'),
  kicker text not null default '' check (length(kicker) <= 60),
  read_minutes integer not null default 2 check (read_minutes between 1 and 60),
  title text not null check (length(title) between 2 and 160),
  excerpt text not null default '' check (length(excerpt) <= 400),
  image_media_id uuid references public.media_assets(id),
  alt text not null default '' check (length(alt) <= 300),
  body_md text not null default '' check (length(body_md) <= 20000),
  product_id text references public.products(id),
  published_at timestamptz,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  rev integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.testimonials (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 80),
  city text check (city is null or length(city) <= 80),
  avatar_media_id uuid references public.media_assets(id),
  quote text not null check (length(quote) between 10 and 600),
  rating integer not null default 5 check (rating between 1 and 5),
  source text not null default 'placeholder' check (source in ('verified_review', 'owner_supplied', 'placeholder')),
  consent jsonb,
  channels text[] not null default '{app,web}' check (channels <@ array['app', 'web'] and cardinality(channels) >= 1),
  -- the website shows video testimonials; the app is text-only and ignores these two columns
  video_media_id uuid references public.media_assets(id),
  poster_media_id uuid references public.media_assets(id),
  position integer not null default 0,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  rev integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (video_media_id is null or poster_media_id is not null)
);
create table public.faq_groups (
  id text primary key check (id ~ '^[a-z0-9-]{2,60}$'),
  title text not null check (length(title) between 2 and 120),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 40),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  rev integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  text text not null check (length(text) between 3 and 200),
  action jsonb,
  tone text not null default 'info' check (tone in ('info', 'promo', 'warning')),
  starts_at timestamptz,
  ends_at timestamptz,
  channels text[] not null default '{app,web}' check (channels <@ array['app', 'web'] and cardinality(channels) >= 1),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  rev integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

-- ------------------------------------------------------ documents + releases
create table public.exp_documents (
  channel text not null check (channel in ('app', 'web', 'shared')),
  kind text not null check (kind in ('tokens', 'navigation', 'chrome', 'page')),
  key text not null check (key ~ '^[a-z0-9:_-]{1,80}$'),
  rev integer not null default 1,
  body jsonb not null check (pg_column_size(body) < 262144),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (channel, kind, key)
);
create table public.exp_document_revisions (
  id bigint generated always as identity primary key,
  channel text not null,
  kind text not null,
  key text not null,
  rev integer not null,
  body jsonb not null,
  updated_by uuid,
  created_at timestamptz not null default now()
);
create index exp_document_revisions_idx on public.exp_document_revisions(channel, kind, key, rev desc);

create table public.exp_releases (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('app', 'web')),
  number integer not null check (number >= 1),
  status text not null check (status in ('scheduled', 'live', 'superseded', 'cancelled', 'failed')),
  label text not null check (length(label) between 2 and 120),
  note text check (note is null or length(note) <= 500),
  snapshot jsonb not null,
  checksum text not null,
  scheduled_at timestamptz,
  activated_at timestamptz,
  rollback_of uuid references public.exp_releases(id),
  bundle_id uuid,
  idempotency_key text,
  payload_hash text,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (channel, number),
  check (status <> 'scheduled' or scheduled_at is not null)
);
create unique index exp_releases_idem on public.exp_releases(channel, idempotency_key) where idempotency_key is not null;

create table public.exp_channel_state (
  channel text primary key check (channel in ('app', 'web')),
  enabled boolean not null default true,
  kill_reason text,
  kill_by uuid,
  kill_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.exp_channel_state (channel) values ('app'), ('web');

create table public.exp_preview_tokens (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('app', 'web')),
  token_hash text not null unique,
  release_id uuid references public.exp_releases(id),
  expires_at timestamptz not null,
  created_by uuid not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.exp_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 120),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  app jsonb,
  web jsonb,
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  rev integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

-- the effective release per channel: highest-numbered live/scheduled release whose activation time has arrived
create view public.v_exp_effective as
select s.channel, s.enabled, r.id as release_id, r.number, r.label, r.checksum,
       coalesce(r.scheduled_at, r.activated_at) as published_at, r.snapshot
  from public.exp_channel_state s
  left join lateral (
    select * from public.exp_releases x
     where x.channel = s.channel and x.status in ('live', 'scheduled')
       and coalesce(x.scheduled_at, x.activated_at) <= now()
     order by x.number desc limit 1
  ) r on true;
revoke all on public.v_exp_effective from public, anon, authenticated;
grant select on public.v_exp_effective to jw_experience, jw_commerce_api;

-- --------------------------------------------------------------- RLS + grants
do $$
declare t text;
begin
  foreach t in array array['care_guides', 'stories', 'journal_notes', 'testimonials', 'faq_groups', 'announcements',
                           'exp_documents', 'exp_campaigns', 'exp_preview_tokens'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to jw_commerce_api', t);
    execute format($p$create policy %I_read on public.%I for select to jw_commerce_api
      using (private.admin_role() is not null or private.is_system())$p$, t, t);
    execute format($p$create policy %I_write on public.%I for all to jw_commerce_api
      using (private.admin_role() in ('admin', 'designer')) with check (private.admin_role() in ('admin', 'designer'))$p$, t, t);
  end loop;
end $$;

alter table public.exp_document_revisions enable row level security;
grant select, insert on public.exp_document_revisions to jw_commerce_api;
create policy exp_rev_read on public.exp_document_revisions for select to jw_commerce_api
  using (private.admin_role() is not null);
create policy exp_rev_insert on public.exp_document_revisions for insert to jw_commerce_api
  with check (private.admin_role() in ('admin', 'designer'));

alter table public.exp_releases enable row level security;
grant select, insert, update on public.exp_releases to jw_commerce_api;
grant select, update on public.exp_releases to jw_worker;
create policy exp_releases_read on public.exp_releases for select to jw_commerce_api, jw_worker
  using (private.admin_role() is not null or private.is_system());
create policy exp_releases_write on public.exp_releases for all to jw_commerce_api
  using (private.admin_role() = 'admin' or private.is_system())
  with check (private.admin_role() = 'admin' or private.is_system());
create policy exp_releases_worker on public.exp_releases for update to jw_worker using (true) with check (true);

alter table public.exp_channel_state enable row level security;
grant select, update on public.exp_channel_state to jw_commerce_api, jw_worker;
create policy exp_state_read on public.exp_channel_state for select to jw_commerce_api, jw_worker using (true);
create policy exp_state_write on public.exp_channel_state for update to jw_commerce_api
  using (private.admin_role() = 'admin' or private.is_system()) with check (private.admin_role() = 'admin' or private.is_system());
create policy exp_state_worker on public.exp_channel_state for update to jw_worker using (true) with check (true);

-- Aggregated, PII-free popularity signal for "bestsellers" rails (units in the last 90 days, excluding unpaid/cancelled orders).
create view public.v_product_sales as
  select oi.product_id, sum(oi.quantity)::int as units_90d
    from public.order_items oi join public.orders o on o.id = oi.order_id
   where o.created_at > now() - interval '90 days'
     and o.status in ('placed', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered')
   group by oi.product_id;
revoke all on public.v_product_sales from public, anon, authenticated;
grant select on public.v_product_sales to jw_experience, jw_commerce_api;

-- Advisory "who is editing" heartbeat (best-effort; never blocks saving).
create table public.exp_presence (
  channel text not null check (channel in ('app', 'web')),
  page_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  seen_at timestamptz not null default now(),
  primary key (channel, page_key, user_id)
);
alter table public.exp_presence enable row level security;
grant select, insert, update, delete on public.exp_presence to jw_commerce_api;
create policy exp_presence_all on public.exp_presence for all to jw_commerce_api
  using (private.admin_role() is not null) with check (private.admin_role() is not null);

-- A release is an immutable record of what customers saw: only its lifecycle fields may change.
create function private.guard_release_immutable() returns trigger language plpgsql
security definer set search_path = pg_catalog, public as $$
begin
  if new.snapshot is distinct from old.snapshot or new.checksum is distinct from old.checksum
     or new.number is distinct from old.number or new.channel is distinct from old.channel
     or new.label is distinct from old.label or new.note is distinct from old.note
     or new.rollback_of is distinct from old.rollback_of or new.created_by is distinct from old.created_by then
    raise exception 'Experience releases are immutable' using errcode = '23514';
  end if;
  if old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception 'A cancelled release cannot be revived' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function private.guard_release_immutable() from public, anon, authenticated;
create trigger guard_release_immutable before update on public.exp_releases
  for each row execute function private.guard_release_immutable();
create function private.guard_release_no_delete() returns trigger language plpgsql
security definer set search_path = pg_catalog, public as $$
begin raise exception 'Experience releases cannot be deleted' using errcode = '23514'; end $$;
revoke all on function private.guard_release_no_delete() from public, anon, authenticated;
create trigger guard_release_no_delete before delete on public.exp_releases
  for each row execute function private.guard_release_no_delete();
