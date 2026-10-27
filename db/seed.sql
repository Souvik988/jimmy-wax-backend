-- Reference catalog (prices/MRP confirmed by the owner 2026-10-02 as shown in the customer app).
-- Store policy lives in migration 20261003000200. Inventory is deliberately zero until counts are entered.
-- Inventory is deliberately zero and checkout remains disabled until real operations
-- values are confirmed; sample data can never accept a live customer order as-is.

insert into public.store_settings (
  id, shipping_fee_paise, free_shipping_threshold_paise, cod_enabled,
  cod_max_order_paise, checkout_enabled, checkout_policy_confirmed,
  delivery_estimate
) values (1, 4000, 200000, false, 200000, false, false, '3–5 business days')
on conflict (id) do nothing;

insert into public.categories (id, name, sort_order) values
  ('polish', 'Polish', 1),
  ('kits', 'Kits', 2),
  ('accessories', 'Accessories', 3),
  ('gift-pack', 'Gift Pack', 4)
on conflict (id) do nothing;

insert into public.products (
  id, category_id, name, subtitle, description, key_benefits,
  suitable_surfaces, box_contents, sort_order
) values
  (
    'twinkle-shine-leather-polish', 'polish', 'Twinkle Shine Leather Polish',
    '100 ml · Premium finish',
    'A 100 ml leather polish for a straightforward shoe-care routine. Apply and buff according to the directions on pack.',
    array['Premium shine', 'Protects leather', 'Easy application', 'Long lasting'],
    'Use only on surfaces listed on the product label. Test a discreet area first.',
    '1 × 100 ml bottle of Twinkle Shine Leather Polish.', 1
  ),
  (
    'polish-cloth-kit', 'kits', 'Polish + Cloth Kit',
    'Everything for a quick shine',
    'A compact care pairing for a quick shine.',
    array['A quick care ritual', 'Polish and cloth kit'],
    'Follow the directions supplied with each item and test a discreet area first.',
    'The kit contents are shown in the supplied product photograph.', 2
  ),
  (
    'complete-care-kit', 'kits', 'Complete Care Kit',
    'Polish, cloth and essentials',
    'A combined set of polish, cloth and care essentials.',
    array['Care essentials together', 'A complete shoe-care kit'],
    'Follow the directions supplied with each item and test a discreet area first.',
    'Polish, cloth and essentials, as listed in the catalog.', 3
  ),
  (
    'black-shoe-care', 'accessories', 'Black Shoe Care',
    'A refined care ritual',
    'A refined care presentation for black-shoe upkeep.',
    array['Black-shoe care', 'A refined care ritual'],
    'Follow the directions supplied with each item and test a discreet area first.',
    'The care items are shown in the supplied product photograph.', 4
  )
on conflict (id) do nothing;

insert into public.product_variants (
  id, product_id, sku, title, price_paise, compare_at_price_paise,
  stock_quantity, active
) values
  ('twinkle-shine-leather-polish', 'twinkle-shine-leather-polish', 'JW-TS-100', '100 ml', 29900, 39900, 0, true),
  ('polish-cloth-kit', 'polish-cloth-kit', 'JW-PC-KIT', 'Standard kit', 49900, 59900, 0, true),
  ('complete-care-kit', 'complete-care-kit', 'JW-CC-KIT', 'Standard kit', 79900, 99900, 0, true),
  ('black-shoe-care', 'black-shoe-care', 'JW-BSC-SET', 'Standard set', 39900, 49900, 0, true)
on conflict (id) do nothing;

insert into public.product_media (product_id, asset_path, alt_text, position) values
  ('twinkle-shine-leather-polish', 'assets/runtime/products/twinkle_shine_polish_and_brown_shoe_v01.jpg', 'Twinkle Shine polish beside a brown leather shoe', 0),
  ('twinkle-shine-leather-polish', 'assets/runtime/education/twinkle_shine_apply_to_sponge_v01.jpg', 'Applying Twinkle Shine polish to an applicator sponge', 1),
  ('twinkle-shine-leather-polish', 'assets/runtime/education/twinkle_shine_apply_to_cloth_v01.jpg', 'Buffing a leather shoe with a cloth', 2),
  ('polish-cloth-kit', 'assets/runtime/products/twinkle_shine_pouch_duo_v01.jpg', 'Twinkle Shine polish and cloth kit', 0),
  ('complete-care-kit', 'assets/runtime/products/jimmy_wax_complete_care_kit_v01.jpg', 'JIMMY WAX complete care kit', 0),
  ('black-shoe-care', 'assets/runtime/products/jimmy_wax_black_shoe_care_v01.jpg', 'JIMMY WAX black shoe care set', 0)
on conflict (product_id, position) do nothing;
