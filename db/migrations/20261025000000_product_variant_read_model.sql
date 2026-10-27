-- One public row per product. The legacy variant stays as a deterministic default;
-- variants is the complete purchasable selection. Product cursors remain unique.
create or replace view public.v_catalog_products as
select p.id as product_id, p.category_id, p.name, p.subtitle, p.description,
       p.key_benefits, p.suitable_surfaces, p.box_contents, p.sort_order,
       v.id as variant_id, v.sku, v.title as variant_title, v.price_paise,
       v.compare_at_price_paise,
       greatest(coalesce(i.on_hand - i.reserved, 0), 0) as available,
       coalesce((select jsonb_agg(jsonb_build_object('assetPath', m.asset_path, 'alt', m.alt_text) order by m.position)
                 from public.product_media m where m.product_id = p.id), '[]'::jsonb) as media,
       p.tags, p.seo_title, p.seo_description, p.created_at as product_created_at,
       (select jsonb_agg(jsonb_build_object(
          'id', av.id, 'sku', av.sku, 'title', av.title,
          'pricePaise', av.price_paise, 'comparePaise', av.compare_at_price_paise,
          'currency', 'INR',
          'available', greatest(coalesce(ai.on_hand-ai.reserved,0),0)>0,
          'availableQuantity', least(greatest(coalesce(ai.on_hand-ai.reserved,0),0),10)
        ) order by av.created_at, av.id)
        from public.product_variants av
        left join public.inventory_positions ai on ai.variant_id=av.id
        where av.product_id=p.id and av.active) as variants
from public.products p
join lateral (
  select pv.* from public.product_variants pv
  left join public.inventory_positions pi on pi.variant_id=pv.id
  where pv.product_id=p.id and pv.active
  order by (greatest(coalesce(pi.on_hand-pi.reserved,0),0)>0) desc, pv.created_at, pv.id
  limit 1
) v on true
left join public.inventory_positions i on i.variant_id=v.id
where p.active and p.archived_at is null;
