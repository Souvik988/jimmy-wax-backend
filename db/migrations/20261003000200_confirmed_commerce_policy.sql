-- Owner-confirmed commerce policy (2026-10-02): prices/MRP/shipping as shown in the customer app (seed),
-- GST 18% included in listed prices (Indian MRP is tax-inclusive), Cash on Delivery handling fee ₹25.
-- checkout_enabled / checkout_policy_confirmed stay FALSE: an operator activates checkout in the console
-- after stock counts and a serviceability list exist.
insert into public.store_settings (id, shipping_fee_paise, free_shipping_threshold_paise, delivery_estimate,
  gst_rate_bps, tax_inclusive, cod_enabled, cod_fee_paise, cod_max_order_paise, checkout_enabled, checkout_policy_confirmed)
values (1, 4000, 200000, '3–5 business days', 1800, true, true, 2500, null, false, false)
on conflict (id) do update set
  shipping_fee_paise = excluded.shipping_fee_paise, free_shipping_threshold_paise = excluded.free_shipping_threshold_paise,
  delivery_estimate = excluded.delivery_estimate, gst_rate_bps = excluded.gst_rate_bps, tax_inclusive = excluded.tax_inclusive,
  cod_enabled = excluded.cod_enabled, cod_fee_paise = excluded.cod_fee_paise, cod_max_order_paise = excluded.cod_max_order_paise,
  version = public.store_settings.version + 1;
