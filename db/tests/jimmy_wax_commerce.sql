begin;

select plan(18);

select has_table('public', 'products', 'catalog products are present');
select has_table('public', 'product_variants', 'inventory-bearing variants are present');
select has_table('public', 'addresses', 'customer addresses are present');
select has_table('public', 'orders', 'orders are present');
select has_table('public', 'order_items', 'order snapshots are present');
select has_table('public', 'payment_records', 'payment records are present');

select ok(
  (select count(*) = 4 from public.products),
  'the four supplied catalog products are seeded'
);
select ok(
  (select coalesce(sum(stock_quantity), 0) = 0 from public.product_variants),
  'seeded inventory is zero until merchant counts are entered'
);
select ok(
  (select not checkout_enabled from public.store_settings where id = 1),
  'checkout is disabled in the unconfirmed seed'
);
select ok(
  (select not checkout_policy_confirmed from public.store_settings where id = 1),
  'store policy is marked unconfirmed'
);
select ok(
  (select count(*) = 0 from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  'every public table has row-level security enabled'
);

select ok(has_table_privilege('anon', 'public.products', 'select'), 'anonymous users can read the catalog');
select ok(not has_table_privilege('anon', 'public.addresses', 'select'), 'anonymous users cannot read customer addresses');
select ok(has_table_privilege('authenticated', 'public.addresses', 'select'), 'signed-in users can use the address API');
select ok(has_table_privilege('authenticated', 'public.orders', 'insert'), 'signed-in users can request an order');
select ok(not has_table_privilege('authenticated', 'public.order_items', 'insert'), 'clients cannot forge order line items');
select ok(not has_function_privilege('anon', 'public.replace_my_cart(jsonb)', 'execute'), 'anonymous users cannot replace a cart');
select ok(has_function_privilege('authenticated', 'public.replace_my_cart(jsonb)', 'execute'), 'signed-in users can atomically replace their own cart');

select * from finish();
rollback;
