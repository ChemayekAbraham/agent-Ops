-- Twice-weekly personalised tenant messaging (2026-09-06 tenant-ops meeting):
-- segment tenants by payment-behaviour band and send a template matched to
-- that band, instead of the single generic message every tenant currently
-- gets from rent-reminders. Reuses the EXISTING get_tenant_repayment_reliability
-- scoring (never re-derives it — this codebase has already been burned once by
-- two independent scoring copies drifting apart) by widening its guard so a
-- service-role/cron caller (auth.uid() is null) can call it too, while
-- interactive callers still need an ops role exactly as before.

create or replace function public.get_tenant_repayment_reliability(
  p_limit int default 500,
  p_offset int default 0,
  p_band text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_summary jsonb;
begin
  if auth.uid() is not null and not (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo') or public.has_role(auth.uid(),'cfo')
    or public.has_role(auth.uid(),'operations') or public.has_role(auth.uid(),'agent_ops')
  ) then
    raise exception 'not authorized';
  end if;

  with plans as (
    select e.rent_request_id, e.tenant_id, e.agent_id,
           greatest(coalesce(e.daily_repayment,0),0) as daily,
           coalesce(e.amount_repaid,0) as repaid,
           coalesce(e.total_repayment,0) as total,
           coalesce(e.rent_amount,0) as rent_amount,
           e.start_at, e.status
    from public.v_tenant_daily_eligibility e
  ),
  ranked as (
    select p.*, row_number() over (
      partition by p.tenant_id order by (p.total - p.repaid) desc nulls last
    ) rn
    from plans p
  ),
  base as (select * from ranked where rn = 1),
  pay as (
    select c.tenant_id,
           count(distinct (c.created_at at time zone 'Africa/Kampala')::date) as pay_days,
           max((c.created_at at time zone 'Africa/Kampala')::date) as last_pay_date,
           sum(c.amount) as collected
    from public.agent_collections c
    where c.tenant_id in (select tenant_id from base)
    group by c.tenant_id
  ),
  gaps as (
    select tenant_id, max(gap) as longest_gap
    from (
      select d.tenant_id,
             d.pd - lag(d.pd) over (partition by d.tenant_id order by d.pd) - 1 as gap
      from (
        select distinct c.tenant_id, (c.created_at at time zone 'Africa/Kampala')::date as pd
        from public.agent_collections c
        where c.tenant_id in (select tenant_id from base)
      ) d
    ) g
    group by tenant_id
  ),
  calc as (
    select b.*,
           coalesce(p.pay_days,0) as pay_days,
           p.last_pay_date,
           coalesce(g.longest_gap,0) as longest_gap,
           case when b.daily > 0 then least(
                greatest(0, ((now() at time zone 'Africa/Kampala')::date - (b.start_at at time zone 'Africa/Kampala')::date)),
                ceil(b.total / b.daily)::int)
                else 0 end as expected_days,
           case when b.daily > 0 then floor(b.repaid / b.daily)::int else 0 end as paid_days,
           case when p.last_pay_date is null then null
                else ((now() at time zone 'Africa/Kampala')::date - p.last_pay_date) end as days_since_last_pay
    from base b
    left join pay p on p.tenant_id = b.tenant_id
    left join gaps g on g.tenant_id = b.tenant_id
  ),
  scored as (
    select c.*,
           greatest(0, c.expected_days - c.paid_days) as missed_days,
           case when c.daily > 0 and c.expected_days > 0
                then least(1.0, c.repaid / (c.daily * c.expected_days)) else 1.0 end as coverage,
           case when c.total > 0 then least(1.0, c.repaid / c.total) else 0 end as progress
    from calc c
  ),
  final as (
    select s.*,
      round(
        45 * s.coverage
        + 25 * greatest(0, 1 - (s.missed_days::numeric / 10))
        + 20 * case
                 when s.days_since_last_pay is null then 0
                 when s.days_since_last_pay <= 1 then 1
                 when s.days_since_last_pay <= 3 then 0.7
                 when s.days_since_last_pay <= 7 then 0.4
                 when s.days_since_last_pay <= 14 then 0.15
                 else 0 end
        + 10 * s.progress
      )::int as score
    from scored s
  ),
  banded as (
    select f.*,
      case
        when f.score >= 85 and f.missed_days <= 1 then 'excellent'
        when f.score >= 70 and f.missed_days <= 3 then 'good'
        when f.score >= 50 or f.missed_days <= 7 then 'watch'
        else 'risk'
      end as band
    from final f
  ),
  enriched as (
    select b.*, tp.full_name as tenant_name, tp.phone as tenant_phone,
           ap.full_name as agent_name, ap.phone as agent_phone
    from banded b
    left join public.profiles tp on tp.id = b.tenant_id
    left join public.profiles ap on ap.id = b.agent_id
  )
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
  into v_rows
  from (
    select rent_request_id, tenant_id, tenant_name, tenant_phone,
           agent_id, agent_name, agent_phone,
           daily, rent_amount, repaid, total, (total - repaid) as outstanding,
           status, start_at, expected_days, paid_days, missed_days, pay_days,
           longest_gap, days_since_last_pay, last_pay_date,
           round(coverage * 100)::int as coverage_pct,
           round(progress * 100)::int as progress_pct,
           score, band,
           (missed_days <= 3) as reliable
    from enriched
    where p_band is null or band = p_band
    order by score desc, missed_days asc
    limit greatest(1, least(coalesce(p_limit,500), 2000)) offset greatest(0, coalesce(p_offset,0))
  ) x;

  with plans as (
    select e.tenant_id, greatest(coalesce(e.daily_repayment,0),0) daily,
           coalesce(e.amount_repaid,0) repaid, coalesce(e.total_repayment,0) total, e.start_at
    from public.v_tenant_daily_eligibility e
  ),
  ranked as (select p.*, row_number() over (partition by tenant_id order by (total - repaid) desc) rn from plans p),
  b as (select * from ranked where rn = 1),
  m as (
    select tenant_id,
      greatest(0,
        case when daily > 0 then least(greatest(0, ((now() at time zone 'Africa/Kampala')::date - (start_at at time zone 'Africa/Kampala')::date)), ceil(total/daily)::int) else 0 end
        - case when daily > 0 then floor(repaid/daily)::int else 0 end) as missed_days,
      (total - repaid) as outstanding
    from b
  )
  select jsonb_build_object(
    'tenants', count(*),
    'reliable', count(*) filter (where missed_days <= 3),
    'watch', count(*) filter (where missed_days between 4 and 7),
    'risk', count(*) filter (where missed_days > 7),
    'outstanding_total', coalesce(sum(outstanding),0),
    'generated_at', now()
  ) into v_summary from m;

  return jsonb_build_object('summary', v_summary, 'rows', v_rows);
end;
$$;

grant execute on function public.get_tenant_repayment_reliability(int,int,text) to service_role;

-- ---------------------------------------------------------------------------
-- Templates, keyed by reliability band. Editable in place (no deploy needed
-- to change copy) — tenant_ops can update `body` directly once a UI exists.
-- Placeholders: {{name}}, {{rent_limit}}, {{missed_days}}, {{outstanding}}.
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_message_templates (
  id uuid primary key default gen_random_uuid(),
  band text not null unique check (band in ('excellent','good','watch','risk')),
  channel text not null default 'sms',
  body text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tenant_message_templates enable row level security;

create policy "tenant_message_templates_ops_read"
  on public.tenant_message_templates for select
  using (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo') or public.has_role(auth.uid(),'cfo')
  );

create policy "tenant_message_templates_ops_write"
  on public.tenant_message_templates for update
  using (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'coo') or public.has_role(auth.uid(),'ceo')
  )
  with check (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'coo') or public.has_role(auth.uid(),'ceo')
  );

insert into public.tenant_message_templates (band, body) values
  ('excellent', 'WELILE: Great work {{name}} — your on-time payments just raised your Rent Plan limit. Keep paying daily to unlock more, or ask your agent about relocating or becoming a Welile agent yourself.'),
  ('good', 'WELILE: Hi {{name}}, you''re on track on your Rent Plan. A few more clean weeks and your rent limit goes up. Pay via MTN/Airtel to Welile anytime your agent isn''t around.'),
  ('watch', 'WELILE: Hi {{name}}, you''ve missed {{missed_days}} day(s) on your Rent Plan (balance {{outstanding}}). Pay via MTN/Airtel to Welile today to stay eligible for a higher rent limit.'),
  ('risk', 'WELILE: Hi {{name}}, your Rent Plan needs attention — {{missed_days}} day(s) missed, {{outstanding}} outstanding. Call your agent or pay via MTN/Airtel to Welile now. We''re here to help you catch up.')
on conflict (band) do nothing;

-- ---------------------------------------------------------------------------
-- Send log: audit trail + same-run/same-day idempotency guard.
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_message_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.profiles(id),
  band text not null,
  template_id uuid references public.tenant_message_templates(id),
  channel text not null default 'sms',
  phone text,
  sent boolean not null default false,
  provider text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_tenant_message_log_tenant_date
  on public.tenant_message_log (tenant_id, created_at desc);

alter table public.tenant_message_log enable row level security;

create policy "tenant_message_log_ops_read"
  on public.tenant_message_log for select
  using (
    public.has_role(auth.uid(),'tenant_ops') or public.has_role(auth.uid(),'super_admin')
    or public.has_role(auth.uid(),'manager') or public.has_role(auth.uid(),'coo')
    or public.has_role(auth.uid(),'ceo') or public.has_role(auth.uid(),'cfo')
  );

-- Only the edge function (service role) writes log rows.
revoke insert, update, delete on public.tenant_message_log from authenticated;

-- ---------------------------------------------------------------------------
-- Twice-weekly schedule: Tue & Fri 09:00 Africa/Kampala (UTC+3, no DST) = 06:00 UTC.
-- ---------------------------------------------------------------------------
DO $cron$
BEGIN
  BEGIN
    PERFORM cron.unschedule('tenant-behavior-messages-biweekly');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  PERFORM cron.schedule(
    'tenant-behavior-messages-biweekly',
    '0 6 * * 2,5',
    $$select net.http_post(
        url:='https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/tenant-behavior-messages',
        headers:='{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
        body:='{}'::jsonb
    );$$
  );
END
$cron$;
