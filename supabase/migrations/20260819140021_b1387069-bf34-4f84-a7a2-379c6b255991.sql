-- Weekly Landlord Ops report aggregator.
create or replace function public.ops_landlord_ops_weekly_bundle(
  p_from timestamptz,
  p_to   timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with days as (
    select generate_series(
      (p_from at time zone 'Africa/Kampala')::date,
      (p_to   at time zone 'Africa/Kampala')::date,
      interval '1 day')::date as day
  ),
  per_day as (
    select d.day,
      (select count(*) from landlords l where (l.created_at at time zone 'Africa/Kampala')::date = d.day) as landlords_new,
      (select count(*) from landlords l where (l.verified_at at time zone 'Africa/Kampala')::date = d.day) as landlords_verified,
      (select count(*) from house_listings h where (h.created_at at time zone 'Africa/Kampala')::date = d.day) as houses_new,
      (select count(*) from house_listings h where (h.verified_at at time zone 'Africa/Kampala')::date = d.day) as houses_verified,
      (select count(*) from lc1_chairpersons c where (c.created_at at time zone 'Africa/Kampala')::date = d.day) as lc1_new,
      (select count(*) from lc1_chairpersons c where (c.verified_at at time zone 'Africa/Kampala')::date = d.day) as lc1_verified,
      (select count(*) from rent_requests r where (r.funded_at at time zone 'Africa/Kampala')::date = d.day) as requests_funded,
      (select count(distinct r.landlord_id) from rent_requests r where (r.funded_at at time zone 'Africa/Kampala')::date = d.day) as landlords_funded,
      (select coalesce(sum(r.rent_amount),0) from rent_requests r where (r.funded_at at time zone 'Africa/Kampala')::date = d.day) as funded_amount,
      (select count(*) from landlord_payouts p where (p.created_at at time zone 'Africa/Kampala')::date = d.day) as payouts_queued,
      (select coalesce(sum(p.amount),0) from landlord_payouts p where (p.created_at at time zone 'Africa/Kampala')::date = d.day) as payouts_queued_amount,
      (select count(*) from landlord_payouts p where (p.disbursed_at at time zone 'Africa/Kampala')::date = d.day) as payouts_disbursed,
      (select coalesce(sum(p.amount),0) from landlord_payouts p where (p.disbursed_at at time zone 'Africa/Kampala')::date = d.day) as payouts_disbursed_amount,
      (select count(*) from landlord_payouts p where (p.receipt_uploaded_at at time zone 'Africa/Kampala')::date = d.day) as payout_receipts,
      (select count(*) from landlord_verification_requests x where (x.created_at at time zone 'Africa/Kampala')::date = d.day) as lvr_raised,
      (select count(*) from landlord_verification_requests x where (x.resolved_at at time zone 'Africa/Kampala')::date = d.day and x.status = 'verified') as lvr_verified,
      (select count(*) from landlord_verification_requests x where (x.resolved_at at time zone 'Africa/Kampala')::date = d.day and x.status = 'rejected') as lvr_rejected,
      (select count(*) from lc1_verification_requests x where (x.created_at at time zone 'Africa/Kampala')::date = d.day) as lc1r_raised,
      (select count(*) from lc1_verification_requests x where (x.resolved_at at time zone 'Africa/Kampala')::date = d.day and x.status = 'verified') as lc1r_verified,
      (select count(*) from lc1_verification_requests x where (x.resolved_at at time zone 'Africa/Kampala')::date = d.day and x.status = 'rejected') as lc1r_rejected,
      (select count(*) from landlords l
         where l.created_at < ((d.day + 1)::timestamp at time zone 'Africa/Kampala')
           and (l.verified_at is null or l.verified_at >= ((d.day + 1)::timestamp at time zone 'Africa/Kampala'))
           and coalesce(l.verification_status,'pending') <> 'rejected') as landlords_pending,
      (select count(*) from house_listings h
         where h.created_at < ((d.day + 1)::timestamp at time zone 'Africa/Kampala')
           and (h.verified_at is null or h.verified_at >= ((d.day + 1)::timestamp at time zone 'Africa/Kampala'))
           and coalesce(h.status,'pending') <> 'rejected') as houses_pending,
      (select count(*) from lc1_chairpersons c
         where c.created_at < ((d.day + 1)::timestamp at time zone 'Africa/Kampala')
           and (c.verified_at is null or c.verified_at >= ((d.day + 1)::timestamp at time zone 'Africa/Kampala'))
           and coalesce(c.verification_status,'pending') <> 'rejected') as lc1_pending
    from days d
  ),
  funded_window as (
    select count(*) reqs, count(distinct landlord_id) landlords,
           coalesce(sum(rent_amount),0) rent, coalesce(sum(total_repayment),0) repay
    from rent_requests where funded_at >= p_from and funded_at <= p_to
  ),
  funded_prev as (
    select count(*) reqs, count(distinct landlord_id) landlords,
           coalesce(sum(rent_amount),0) rent, coalesce(sum(total_repayment),0) repay
    from rent_requests
    where funded_at >= p_from - (p_to - p_from) and funded_at < p_from
  ),
  districts as (
    select coalesce(nullif(btrim(coalesce(l.district, pr.district, hl.district, '')),''),'Unspecified') as district,
           count(*) reqs, count(distinct r.landlord_id) landlords, coalesce(sum(r.rent_amount),0) rent
    from rent_requests r
    left join landlords l on l.id = r.landlord_id
    left join profiles pr on pr.id = r.tenant_id
    left join house_listings hl on hl.tenant_id = r.tenant_id
    where r.funded_at >= p_from and r.funded_at <= p_to
    group by 1 order by 4 desc limit 15
  ),
  snapshot as (
    select
      (select count(*) from landlords) l_total,
      (select count(*) from landlords where verified) l_verified,
      (select count(*) from landlords where not verified and coalesce(verification_status,'pending') <> 'rejected') l_pending,
      (select count(*) from landlords where verification_status = 'rejected') l_rejected,
      (select count(*) from house_listings) h_total,
      (select count(*) from house_listings where verified) h_verified,
      (select count(*) from house_listings where not verified and coalesce(status,'pending') <> 'rejected') h_pending,
      (select count(*) from house_listings where status = 'rejected') h_rejected,
      (select count(*) from lc1_chairpersons) c_total,
      (select count(*) from lc1_chairpersons where verified) c_verified,
      (select count(*) from lc1_chairpersons where not verified and coalesce(verification_status,'pending') <> 'rejected') c_pending,
      (select count(*) from lc1_chairpersons where verification_status = 'rejected') c_rejected
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'daily', (select coalesce(jsonb_agg(to_jsonb(per_day) order by per_day.day), '[]'::jsonb) from per_day),
    'funded', (select to_jsonb(funded_window) from funded_window),
    'funded_previous', (select to_jsonb(funded_prev) from funded_prev),
    'by_district', (select coalesce(jsonb_agg(to_jsonb(districts)), '[]'::jsonb) from districts),
    'snapshot', (select to_jsonb(snapshot) from snapshot)
  );
$$;

revoke all on function public.ops_landlord_ops_weekly_bundle(timestamptz, timestamptz) from public;
grant execute on function public.ops_landlord_ops_weekly_bundle(timestamptz, timestamptz) to service_role;

select cron.unschedule('weekly-landlord-ops-report-1300-eat')
where exists (select 1 from cron.job where jobname = 'weekly-landlord-ops-report-1300-eat');

select cron.schedule(
  'weekly-landlord-ops-report-1300-eat',
  '0 10 * * 3',
  $$
  select net.http_post(
    url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/weekly-landlord-ops-report',
    headers:='{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body:=concat('{"time": "', now(), '"}')::jsonb
  ) as request_id;
  $$
);