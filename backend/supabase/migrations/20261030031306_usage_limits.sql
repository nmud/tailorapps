-- Daily Muse request counter per user. Only the backend (service role) reads or writes it.
create table public.usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default (now() at time zone 'utc')::date,
  requests integer not null default 0,
  primary key (user_id, day)
);

alter table public.usage enable row level security;
-- No policies: anon and authenticated roles get no access. The service role bypasses RLS.

-- Atomically count one request and report the new total for today.
create or replace function public.tailor_bump_usage(p_user uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.usage (user_id, day, requests)
  values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set requests = public.usage.requests + 1
  returning requests;
$$;

revoke all on function public.tailor_bump_usage(uuid) from public, anon, authenticated;
grant execute on function public.tailor_bump_usage(uuid) to service_role;
