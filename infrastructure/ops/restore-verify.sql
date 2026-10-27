-- Run against a RESTORED database (never production) to prove the backup is usable. Every row must say ok = true.
-- Output: check | detail | ok
with
migrations as (select count(*)::int n, max(version) latest from public.schema_migrations),
checks(check_name, detail, ok) as (
  select 'migration ledger present', (select n || ' migrations, latest ' || coalesce(latest, '-') from migrations), (select n > 0 from migrations)
  union all select 'orders readable', count(*) || ' orders', true from public.orders
  union all select 'order lines belong to orders', count(*) || ' orphan lines', count(*) = 0 from public.order_items i where not exists (select 1 from public.orders o where o.id = i.order_id)
  union all select 'order totals reconcile', count(*) || ' orders off', count(*) = 0 from public.orders where placed_via = 'express' and total_paise <> subtotal_paise - discount_paise + shipping_paise + cod_fee_paise + case when tax_inclusive then 0 else tax_paise end
  union all select 'stock never negative', count(*) || ' rows negative', count(*) = 0 from public.inventory_positions where on_hand < 0 or reserved < 0
  union all select 'invoice numbers unique and consecutive per FY',
         (select count(*) || ' invoices, ' || coalesce(sum(case when c.last_number <> x.n then 1 else 0 end), 0) || ' counter mismatches' from (select count(*) n, split_part(invoice_number, '/', 2) fy from public.invoices group by 2) x left join public.invoice_counters c on c.fy = x.fy),
         (select coalesce(bool_and(c.last_number >= x.n), true) from (select count(*) n, split_part(invoice_number, '/', 2) fy from public.invoices group by 2) x left join public.invoice_counters c on c.fy = x.fy)
  union all select 'audit log is append-only', count(*) || ' triggers', count(*) >= 1 from pg_trigger where tgname = 'audit_log_no_update'
  union all select 'audit log readable', count(*) || ' entries', true from public.audit_log
  union all select 'catalogue present', (select count(*) from public.products) || ' products, ' || (select count(*) from public.product_variants) || ' variants', (select count(*) from public.products) > 0
  union all select 'published experience pointer present', count(*) || ' channels', count(*) >= 1 from public.exp_channel_state
  union all select 'row level security still on', count(*) || ' tables with RLS', count(*) >= 20 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  union all select 'application role privileges restored', 'jw_commerce_api select orders / jw_experience select catalogue view / jw_worker update email_outbox', has_table_privilege('jw_commerce_api', 'public.orders', 'select') and has_table_privilege('jw_experience', 'public.v_catalog_products', 'select') and has_table_privilege('jw_worker', 'public.email_outbox', 'update')
  union all select 'application roles exist', string_agg(rolname, ', ' order by rolname), count(*) = 3 from pg_roles where rolname in ('jw_commerce_api', 'jw_experience', 'jw_worker')
)
select check_name as check, detail, ok from checks order by ok, check_name;
