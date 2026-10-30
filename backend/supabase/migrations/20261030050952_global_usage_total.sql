-- Total Muse requests across everyone today, for the global safety cap.
create or replace function public.tailor_usage_today()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(requests), 0)::integer
  from public.usage
  where day = (now() at time zone 'utc')::date;
$$;

revoke all on function public.tailor_usage_today() from public, anon, authenticated;
grant execute on function public.tailor_usage_today() to service_role;
