-- Retire the legacy trigger-based checkout (it depended on Supabase's auth.uid() and a direct-client
-- insert model). Express is the ONLY checkout/stock authority from here on. Because the platform no
-- longer has any direct database clients, no compatibility window is needed.
drop trigger if exists prepare_new_order_before_insert on public.orders;
drop trigger if exists finalize_new_order_after_insert on public.orders;
drop function if exists private.prepare_new_order();
drop function if exists private.finalize_new_order();
drop function if exists public.replace_my_cart(jsonb);
drop function if exists public.replace_my_wishlist(text[]);
drop policy if exists "users create own orders" on public.orders;

-- product_variants.stock_quantity is a LEGACY column: nothing reads it any more (no PostgREST clients) and it is no longer
-- maintained. Availability is inventory_positions (on_hand - reserved); keeping a mirror would add a second hot row lock
-- to every order, so the mirror trigger is intentionally NOT installed.

alter table public.store_settings alter column checkout_authority set default 'express';
update public.store_settings set checkout_authority = 'express' where id = 1;
alter table public.store_settings drop constraint if exists store_settings_checkout_authority_check;
alter table public.store_settings add constraint store_settings_checkout_authority_check check (checkout_authority = 'express');
