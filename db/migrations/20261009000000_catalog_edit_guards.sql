-- Catalogue edit guards (dashboard requests DASH-BR-021, -025, -029).
--
-- 1. Variant metadata edits (SKU, package dimensions, weight, HSN, barcode, cost) go through the audited, versioned
--    PATCH /v1/admin/catalog/variants/{id}; the API role needs UPDATE on those columns (RLS still limits it to admin/catalog).
-- 2. A price/availability change must invalidate outstanding checkout quotes by bumping store_settings.rules_version, but the
--    settings UPDATE policy is admin-only, so a Catalog operator's bump would silently match zero rows. A narrow SECURITY DEFINER
--    function performs exactly that one bump.

grant update (sku, weight_grams, length_mm, width_mm, height_mm, hsn_code, barcode, cost_price_paise) on public.product_variants to jw_commerce_api;

do $$
begin
  -- low-stock threshold lives on the inventory position; only that column is writable here.
  execute 'grant update (low_stock_threshold) on public.inventory_positions to jw_commerce_api';
exception when others then
  raise notice 'inventory_positions grant skipped: %', sqlerrm;
end $$;

create or replace function private.bump_rules_version() returns void
language sql security definer set search_path = public, pg_temp as
$$ update public.store_settings set rules_version = rules_version + 1 where id = 1 $$;

revoke all on function private.bump_rules_version() from public;
grant execute on function private.bump_rules_version() to jw_commerce_api;
