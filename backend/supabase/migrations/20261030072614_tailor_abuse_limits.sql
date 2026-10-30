-- Per-network-address counters (addresses are stored only as salted hashes).
create table if not exists public.usage_ip (
  ip_hash text not null,
  day date not null,
  requests integer not null default 0,
  signups integer not null default 0,
  primary key (ip_hash, day)
);
alter table public.usage_ip enable row level security;
revoke all on public.usage_ip from anon, authenticated;

-- One atomic step: check every daily cap, then count the request only if it is allowed.
create or replace function public.tailor_take_request(
  p_user uuid, p_ip text, p_user_limit integer, p_ip_limit integer, p_global_limit integer
) returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  today date := (now() at time zone 'utc')::date;
  total integer;
  mine integer;
  from_ip integer;
begin
  perform pg_advisory_xact_lock(7311);
  select coalesce(sum(requests), 0) into total from public.usage where day = today;
  if total >= p_global_limit then return 'global'; end if;
  select coalesce(requests, 0) into mine from public.usage where user_id = p_user and day = today;
  if coalesce(mine, 0) >= p_user_limit then return 'user'; end if;
  select coalesce(requests, 0) into from_ip from public.usage_ip where ip_hash = p_ip and day = today;
  if coalesce(from_ip, 0) >= p_ip_limit then return 'ip'; end if;

  insert into public.usage (user_id, day, requests) values (p_user, today, 1)
    on conflict (user_id, day) do update set requests = public.usage.requests + 1;
  insert into public.usage_ip (ip_hash, day, requests) values (p_ip, today, 1)
    on conflict (ip_hash, day) do update set requests = public.usage_ip.requests + 1;
  return 'ok';
end;
$$;

-- Count a signup attempt from an address; returns the count including this one.
create or replace function public.tailor_take_signup(p_ip text) returns integer
language sql
security definer
set search_path to ''
as $$
  insert into public.usage_ip (ip_hash, day, signups) values (p_ip, (now() at time zone 'utc')::date, 1)
  on conflict (ip_hash, day) do update set signups = public.usage_ip.signups + 1
  returning signups;
$$;

revoke execute on function public.tailor_take_request(uuid, text, integer, integer, integer) from public, anon, authenticated;
revoke execute on function public.tailor_take_signup(text) from public, anon, authenticated;
grant execute on function public.tailor_take_request(uuid, text, integer, integer, integer) to service_role;
grant execute on function public.tailor_take_signup(text) to service_role;
