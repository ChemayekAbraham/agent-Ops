DROP FUNCTION IF EXISTS public.get_cfo_money_paid_out();

CREATE OR REPLACE FUNCTION public.get_cfo_money_paid_out()
 RETURNS TABLE(total_paid numeric, total_count bigint, today_paid numeric, today_count bigint, month_paid numeric, month_count bigint, pending_amount numeric, pending_count bigint, yesterday_paid numeric, yesterday_count bigint, last7_paid numeric, last7_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d0 timestamptz := date_trunc('day', now() at time zone 'Africa/Kampala') at time zone 'Africa/Kampala';
  m0 timestamptz := date_trunc('month', now() at time zone 'Africa/Kampala') at time zone 'Africa/Kampala';
  d1 timestamptz := d0 - interval '1 day';
  w0 timestamptz := d0 - interval '6 days';
begin
  if not (has_role(auth.uid(),'cfo') or has_role(auth.uid(),'ceo') or has_role(auth.uid(),'super_admin')) then
    raise exception 'not authorized';
  end if;
  return query
  select coalesce(sum(amount) filter (where status in ('completed','paid')),0),
         count(*) filter (where status in ('completed','paid')),
         coalesce(sum(amount) filter (where status in ('completed','paid') and processed_at >= d0),0),
         count(*) filter (where status in ('completed','paid') and processed_at >= d0),
         coalesce(sum(amount) filter (where status in ('completed','paid') and processed_at >= m0),0),
         count(*) filter (where status in ('completed','paid') and processed_at >= m0),
         coalesce(sum(amount) filter (where status = 'pending'),0),
         count(*) filter (where status = 'pending'),
         coalesce(sum(amount) filter (where status in ('completed','paid') and processed_at >= d1 and processed_at < d0),0),
         count(*) filter (where status in ('completed','paid') and processed_at >= d1 and processed_at < d0),
         coalesce(sum(amount) filter (where status in ('completed','paid') and processed_at >= w0),0),
         count(*) filter (where status in ('completed','paid') and processed_at >= w0)
  from withdrawal_requests;
end $function$;

REVOKE ALL ON FUNCTION public.get_cfo_money_paid_out() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_money_paid_out() TO authenticated, service_role;