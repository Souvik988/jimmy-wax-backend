-- Phone one-time-code sign-in (own identity) + the owner's first serviceable PIN code.
create unique index if not exists users_phone_uidx on auth.users (phone) where phone is not null;
alter table auth.users add column if not exists is_demo boolean not null default false;

create table auth.phone_otps (
  phone text primary key check (phone ~ '^\+91[6-9][0-9]{9}$'),
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  last_sent_at timestamptz not null default now(),
  window_started_at timestamptz not null default now(),
  sent_in_window integer not null default 1
);
grant select, insert, update, delete on auth.phone_otps to jw_commerce_api;
grant delete on auth.phone_otps to jw_worker;

-- Owner-confirmed first delivery area (2026-10-03): exactly PIN 743287. More are added in the console.
insert into public.serviceable_pin_prefixes (prefix, note) values ('743287', 'initial service area (owner)')
on conflict (prefix) do nothing;
