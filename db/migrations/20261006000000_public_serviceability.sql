-- Public "do you deliver to this PIN?" answer for the storefronts (app and website).
-- Returns null when the merchant has not configured any delivery area (the client then makes no claim).
create function public.pin_serviceable(p_pin text) returns boolean
  language sql stable security definer set search_path = public as $$
  select case
    when not exists (select 1 from public.serviceable_pin_prefixes) then null
    when not exists (select 1 from public.serviceable_pin_prefixes where p_pin like prefix || '%') then false
    when private.pin_provider_blocked(p_pin) then false
    else true
  end
$$;
revoke all on function public.pin_serviceable(text) from public, anon, authenticated;
grant execute on function public.pin_serviceable(text) to jw_experience, jw_commerce_api;
