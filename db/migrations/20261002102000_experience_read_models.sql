-- Read models for the cacheable experience API. The experience role can read ONLY these views
-- (owner-privileged, curated columns); it has no table grants and cannot write anything.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'jw_experience') then create role jw_experience nologin; end if;
end $$;
grant usage on schema public to jw_experience;

create view public.v_catalog_products as
select p.id as product_id, p.category_id, p.name, p.subtitle, p.description, p.key_benefits, p.suitable_surfaces,
       p.box_contents, p.sort_order,
       v.id as variant_id, v.sku, v.title as variant_title, v.price_paise, v.compare_at_price_paise,
       greatest(coalesce(i.on_hand - i.reserved, 0), 0) as available,
       coalesce((select jsonb_agg(jsonb_build_object('assetPath', m.asset_path, 'alt', m.alt_text) order by m.position)
                   from public.product_media m where m.product_id = p.id), '[]'::jsonb) as media
  from public.products p
  join public.product_variants v on v.product_id = p.id and v.active
  left join public.inventory_positions i on i.variant_id = v.id
 where p.active;

create view public.v_categories as
  select id, name, sort_order from public.categories where active;

create view public.v_public_store_settings as
  select shipping_fee_paise, free_shipping_threshold_paise, cod_enabled, cod_max_order_paise,
         (checkout_enabled and checkout_policy_confirmed and checkout_authority = 'express') as checkout_open,
         delivery_estimate
    from public.store_settings where id = 1;

create view public.v_approved_reviews as
  select id, product_id, rating, title, body, created_at, verified_purchase
    from public.reviews where status = 'approved';

revoke all on public.v_catalog_products, public.v_categories, public.v_public_store_settings, public.v_approved_reviews from public, anon, authenticated;
grant select on public.v_catalog_products, public.v_categories, public.v_public_store_settings, public.v_approved_reviews to jw_experience;
create index if not exists reviews_product_approved_keyset_idx on public.reviews(product_id, created_at desc, id desc) where status = 'approved';
