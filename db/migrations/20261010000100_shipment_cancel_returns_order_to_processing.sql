-- Cancelling a manual shipment before pickup hands the order back to processing (contract 1.4.0, DASH-BR-011).

-- Cancelling a manual shipment before pickup hands the order back to processing (DASH-BR-011) -----------------------
-- Only cancelShipment performs this move; the console's own status endpoint keeps its separate allow-list, so no new operator path opens.
insert into private.order_transitions values ('shipped', 'processing') on conflict do nothing;
