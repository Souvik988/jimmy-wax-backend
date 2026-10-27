-- B8: platform (team, invites, recovery codes), catalogue management, media library, collections.
-- Forward-only. Admin writes are gated twice: the API checks role/MFA, and RLS checks the role the API bound
-- inside the transaction (private.admin_role()).

-- ------------------------------------------------------------------ roles
alter table public.admin_users drop constraint admin_users_role_check;
alter table public.admin_users add constraint admin_users_role_check
  check (role in ('support', 'catalog', 'fulfillment', 'finance', 'designer', 'admin'));

grant insert on public.admin_users to jw_commerce_api;
grant update (role, disabled, updated_at) on public.admin_users to jw_commerce_api;
create policy admin_team_update on public.admin_users for update to jw_commerce_api
  using (private.admin_role() = 'admin') with check (private.admin_role() = 'admin');
-- Accepting an invite runs as the system actor (the invitee has no role yet).
create policy admin_team_insert on public.admin_users for insert to jw_commerce_api
  with check (private.is_system() or private.admin_role() = 'admin');

create table public.admin_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email) and length(email) between 5 and 254),
  role text not null check (role in ('support', 'catalog', 'fulfillment', 'finance', 'designer', 'admin')),
  token_hash text not null unique,
  invited_by uuid not null references auth.users(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index admin_invites_open_email on public.admin_invites(email)
  where accepted_at is null and revoked_at is null;
alter table public.admin_invites enable row level security;
grant select, insert, update on public.admin_invites to jw_commerce_api;
create policy invites_admin on public.admin_invites for all to jw_commerce_api
  using (private.admin_role() = 'admin' or private.is_system())
  with check (private.admin_role() = 'admin' or private.is_system());

create table auth.mfa_recovery_codes (
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, code_hash)
);
grant select, insert, update, delete on auth.mfa_recovery_codes to jw_commerce_api;

-- ------------------------------------------------------------ media library
create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('image', 'video', 'font')),
  sha256 text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  mime text not null,
  bytes bigint not null check (bytes > 0),
  width integer,
  height integer,
  duration_ms integer,
  filename text not null check (length(filename) between 1 and 200),
  status text not null default 'ready' check (status in ('processing', 'ready', 'failed')),
  provenance text not null default 'original_photo'
    check (provenance in ('original_photo', 'edited_photo', 'generated', 'illustration')),
  approval text not null default 'draft' check (approval in ('draft', 'approved', 'rejected')),
  approval_by uuid,
  approval_at timestamptz,
  approval_note text,
  packaging_attested boolean not null default false,
  alt text not null default '',
  decorative boolean not null default false,
  focal_x real check (focal_x is null or focal_x between 0 and 1),
  focal_y real check (focal_y is null or focal_y between 0 and 1),
  tags text[] not null default '{}',
  folder text not null default '' check (length(folder) <= 80),
  role text check (role is null or role in ('product_packshot', 'campaign', 'brand', 'mascot', 'state_art', 'avatar', 'poster', 'font')),
  license text,
  variants jsonb not null default '[]',
  poster_media_id uuid references public.media_assets(id),
  archived_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- an approved asset must say who approved it; a generated asset must carry the packaging attestation
  check (approval <> 'approved' or (approval_by is not null and approval_at is not null)),
  check (approval <> 'approved' or provenance <> 'generated' or packaging_attested),
  check (kind <> 'font' or license is not null)
);
create index media_assets_filter_idx on public.media_assets(kind, approval, archived_at);
create index media_assets_tags_idx on public.media_assets using gin (tags);
alter table public.media_assets enable row level security;
grant select, insert, update on public.media_assets to jw_commerce_api;
grant select on public.media_assets to jw_worker;
create policy media_read on public.media_assets for select to jw_commerce_api
  using (private.admin_role() is not null or private.is_system());
create policy media_write on public.media_assets for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'catalog', 'designer'))
  with check (private.admin_role() in ('admin', 'catalog', 'designer'));
create policy media_worker on public.media_assets for select to jw_worker using (true);

-- ------------------------------------------------------------- catalogue
alter table public.products
  add column tags text[] not null default '{}',
  add column seo_title text check (seo_title is null or length(seo_title) <= 120),
  add column seo_description text check (seo_description is null or length(seo_description) <= 320),
  add column version integer not null default 1,
  add column archived_at timestamptz;

alter table public.product_variants
  add column weight_grams integer check (weight_grams is null or weight_grams between 1 and 50000),
  add column length_mm integer check (length_mm is null or length_mm between 1 and 2000),
  add column width_mm integer check (width_mm is null or width_mm between 1 and 2000),
  add column height_mm integer check (height_mm is null or height_mm between 1 and 2000),
  add column hsn_code text check (hsn_code is null or hsn_code ~ '^[0-9]{4,8}$'),
  add column barcode text check (barcode is null or length(barcode) between 4 and 40),
  add column cost_price_paise integer check (cost_price_paise is null or cost_price_paise >= 0);

alter table public.categories
  add column description text not null default '',
  add column image_media_id uuid references public.media_assets(id),
  add column seo_title text,
  add column seo_description text,
  add column updated_at timestamptz not null default now();

alter table public.product_media add column media_id uuid references public.media_assets(id);

grant insert, update on public.products, public.product_variants to jw_commerce_api;
grant insert, update, delete on public.categories, public.product_media to jw_commerce_api;
create policy admin_insert_products on public.products for insert to jw_commerce_api
  with check (private.admin_role() in ('admin', 'catalog'));
create policy admin_insert_variants on public.product_variants for insert to jw_commerce_api
  with check (private.admin_role() in ('admin', 'catalog'));
create policy admin_write_categories on public.categories for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'catalog')) with check (private.admin_role() in ('admin', 'catalog'));
create policy admin_write_product_media on public.product_media for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'catalog')) with check (private.admin_role() in ('admin', 'catalog'));

-- Cost price is finance/admin-only: column privileges cannot express roles, so the API never selects it for others
-- and a DB view exposes the safe columns; direct reads stay behind the API.

-- ------------------------------------------------------------ collections
create table public.collections (
  id text primary key check (id ~ '^[a-z0-9-]{2,60}$'),
  name text not null check (length(name) between 2 and 120),
  description text not null default '',
  kind text not null default 'manual' check (kind in ('manual', 'smart')),
  rule jsonb,
  visible boolean not null default true,
  seo_title text,
  seo_description text,
  rev integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'smart') = (rule is not null))
);
create table public.collection_items (
  collection_id text not null references public.collections(id) on delete cascade,
  product_id text not null references public.products(id) on delete cascade,
  position integer not null check (position >= 0),
  primary key (collection_id, product_id),
  unique (collection_id, position) deferrable initially deferred
);
alter table public.collections enable row level security;
alter table public.collection_items enable row level security;
grant select, insert, update, delete on public.collections, public.collection_items to jw_commerce_api;
grant select on public.collections, public.collection_items to jw_worker;
create policy collections_read on public.collections for select to jw_commerce_api, jw_worker using (true);
create policy collection_items_read on public.collection_items for select to jw_commerce_api, jw_worker using (true);
create policy collections_write on public.collections for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'catalog')) with check (private.admin_role() in ('admin', 'catalog'));
create policy collection_items_write on public.collection_items for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'catalog')) with check (private.admin_role() in ('admin', 'catalog'));
