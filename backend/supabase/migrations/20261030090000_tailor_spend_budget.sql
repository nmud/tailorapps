-- Money spent on Muse, in millionths of a dollar. Scopes: 'total', 'day:<date>', 'user:<uuid>:<date>'.
create table if not exists public.spend (
  scope text primary key,
  micros bigint not null default 0
);
alter table public.spend enable row level security;
revoke all on public.spend from anon, authenticated;

-- Before calling Muse: set aside the most this request could cost, if every budget has room.
create or replace function public.tailor_reserve(
  p_user uuid, p_day date, p_micros bigint, p_total_limit bigint, p_day_limit bigint, p_user_day_limit bigint
) returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  k_total text := 'total';
  k_day text := 'day:' || p_day;
  k_user text := 'user:' || p_user || ':' || p_day;
  v bigint;
begin
  perform pg_advisory_xact_lock(7312);
  select coalesce((select micros from public.spend where scope = k_total), 0) into v;
  if v + p_micros > p_total_limit then return 'total'; end if;
  select coalesce((select micros from public.spend where scope = k_day), 0) into v;
  if v + p_micros > p_day_limit then return 'day'; end if;
  select coalesce((select micros from public.spend where scope = k_user), 0) into v;
  if v + p_micros > p_user_day_limit then return 'user'; end if;

  insert into public.spend (scope, micros) values (k_total, p_micros), (k_day, p_micros), (k_user, p_micros)
    on conflict (scope) do update set micros = public.spend.micros + excluded.micros;
  return 'ok';
end;
$$;

-- After the reply: replace the set-aside amount with what the request really cost.
create or replace function public.tailor_settle(p_user uuid, p_day date, p_delta bigint) returns void
language sql
security definer
set search_path to ''
as $$
  update public.spend set micros = greatest(0, micros + p_delta)
  where scope in ('total', 'day:' || p_day, 'user:' || p_user || ':' || p_day);
$$;

revoke execute on function public.tailor_reserve(uuid, date, bigint, bigint, bigint, bigint) from public, anon, authenticated;
revoke execute on function public.tailor_settle(uuid, date, bigint) from public, anon, authenticated;
grant execute on function public.tailor_reserve(uuid, date, bigint, bigint, bigint, bigint) to service_role;
grant execute on function public.tailor_settle(uuid, date, bigint) to service_role;
