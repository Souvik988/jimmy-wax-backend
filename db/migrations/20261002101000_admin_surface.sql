-- Operator (admin) write surface for the Express admin API. Admin identity is verified in the
-- API (admin_users + MFA claim); this migration adds a DATABASE-level second gate: admin writes
-- only succeed inside a transaction where the API bound a verified admin role (app.admin_role).

create function private.admin_role() returns text
language sql stable as $$ select nullif(current_setting('app.admin_role', true), '') $$;
grant execute on function private.admin_role() to jw_commerce_api, jw_worker;

grant update (name, subtitle, description, key_benefits, suitable_surfaces, box_contents, active, sort_order, updated_at)
  on public.products to jw_commerce_api;
grant update (price_paise, compare_at_price_paise, active, title, updated_at) on public.product_variants to jw_commerce_api;
grant update (shipping_fee_paise, free_shipping_threshold_paise, cod_enabled, cod_max_order_paise, checkout_enabled,
  checkout_policy_confirmed, delivery_estimate, online_payments_enabled, payment_window_minutes, quote_ttl_minutes,
  rules_version, version, updated_at) on public.store_settings to jw_commerce_api;
grant update on public.outbox to jw_commerce_api;
grant select on public.refunds, public.payment_attempts to jw_commerce_api;

create policy admin_update_products on public.products for update to jw_commerce_api
  using (private.admin_role() in ('admin', 'catalog')) with check (private.admin_role() in ('admin', 'catalog'));
create policy admin_update_variants on public.product_variants for update to jw_commerce_api
  using (private.admin_role() in ('admin', 'catalog')) with check (private.admin_role() in ('admin', 'catalog'));
create policy admin_update_settings on public.store_settings for update to jw_commerce_api
  using (private.admin_role() = 'admin') with check (private.admin_role() = 'admin');
-- Admins may read every order/refund/etc. (support is redacted in the API layer).
create policy admin_read_orders on public.orders for select to jw_commerce_api using (private.admin_role() is not null);
create policy admin_read_items on public.order_items for select to jw_commerce_api using (private.admin_role() is not null);
create policy admin_update_orders on public.orders for update to jw_commerce_api
  using (private.admin_role() in ('admin', 'fulfillment', 'finance')) with check (private.admin_role() in ('admin', 'fulfillment', 'finance'));
create policy admin_read_attempts on public.payment_attempts for select to jw_commerce_api using (private.admin_role() is not null);
create policy admin_all_refunds on public.refunds for all to jw_commerce_api
  using (private.admin_role() in ('admin', 'finance')) with check (private.admin_role() in ('admin', 'finance'));
create policy admin_read_addresses on public.addresses for select to jw_commerce_api using (private.admin_role() in ('admin', 'support', 'fulfillment'));
-- Fulfilment may QUEUE a refund as a side effect of cancelling a paid order; only finance/admin can process it.
create policy admin_queue_refund on public.refunds for insert to jw_commerce_api
  with check (private.admin_role() in ('fulfillment') and status = 'requested');
-- INSERT ... ON CONFLICT also needs SELECT visibility; fulfilment/support may see refund status anyway.
create policy admin_read_refunds on public.refunds for select to jw_commerce_api
  using (private.admin_role() in ('fulfillment', 'support'));
