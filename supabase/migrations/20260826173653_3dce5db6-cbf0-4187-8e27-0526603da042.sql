create or replace function public.partner_ops_can_view()
returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_partner_ops(auth.uid())
      or public.has_role(auth.uid(),'partner_ops')
      or public.has_role(auth.uid(),'cfo')
      or public.has_role(auth.uid(),'ceo')
      or public.has_role(auth.uid(),'coo')
      or public.has_role(auth.uid(),'manager')
      or public.has_role(auth.uid(),'super_admin');
$$;

create or replace function public.partner_ops_search_partners(p_search text default null, p_limit integer default 25)
returns table (
  user_id uuid, full_name text, phone text, email text, funder_reference text,
  joined_at timestamptz, portfolio_count integer, active_count integer,
  total_principal numeric, total_returns numeric, last_portfolio_at timestamptz
)
language sql stable security definer set search_path = public as $$
  with gate as (select public.partner_ops_can_view() ok),
  agg as (
    select ip.investor_id as uid,
           count(*)::int cnt,
           count(*) filter (where ip.status = 'active')::int active_cnt,
           coalesce(sum(ip.investment_amount),0) principal,
           coalesce(sum(ip.total_roi_earned),0) returns,
           max(ip.created_at) last_at
    from investor_portfolios ip
    where ip.investor_id is not null
    group by ip.investor_id
  )
  select p.id, p.full_name, p.phone, p.email, p.funder_reference, p.created_at,
         coalesce(a.cnt,0), coalesce(a.active_cnt,0),
         coalesce(a.principal,0), coalesce(a.returns,0), a.last_at
  from profiles p
  left join agg a on a.uid = p.id
  cross join gate
  where gate.ok
    and p.deleted_at is null
    and (a.uid is not null or exists (
      select 1 from user_roles ur where ur.user_id = p.id and ur.role in ('supporter','partner_ops')
    ))
    and (
      p_search is null or btrim(p_search) = ''
      or p.full_name ilike '%'||btrim(p_search)||'%'
      or p.phone ilike '%'||btrim(p_search)||'%'
      or p.email ilike '%'||btrim(p_search)||'%'
      or coalesce(p.funder_reference,'') ilike '%'||btrim(p_search)||'%'
    )
  order by coalesce(a.principal,0) desc, p.created_at desc
  limit greatest(1, least(coalesce(p_limit,25), 100));
$$;

create or replace function public.get_partner_360(p_user_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
begin
  if not public.partner_ops_can_view() then
    raise exception 'not_authorized';
  end if;

  select jsonb_build_object(
    'profile', (
      select to_jsonb(x) from (
        select p.id, p.full_name, p.phone, p.email, p.national_id, p.avatar_url,
               p.created_at, p.last_active_at, p.verified, p.funder_reference,
               p.funder_verified_at, p.is_frozen, p.frozen_reason,
               p.country, p.region, p.district, p.city, p.town, p.address,
               p.mobile_money_number, p.mobile_money_provider, p.mobile_money_name,
               p.occupation, p.signup_source, p.referrer_id,
               (select r.full_name from profiles r where r.id = p.referrer_id) as referrer_name,
               (select array_agg(ur.role::text) from user_roles ur where ur.user_id = p.id) as roles
        from profiles p where p.id = p_user_id
      ) x
    ),
    'agreement', (
      select to_jsonb(a) from (
        select pa.reference, pa.status, pa.agreement_date, pa.payout_mode,
               pa.bank_name, pa.bank_account_name, pa.bank_account_number,
               pa.momo_provider, pa.momo_number, pa.momo_name,
               pa.kin_name, pa.kin_contact, pa.partnership_amount,
               pa.countersigned_at, pa.generated_pdf_path
        from partner_agreements pa
        where pa.partner_id = p_user_id
        order by pa.created_at desc limit 1
      ) a
    ),
    'totals', (
      select jsonb_build_object(
        'portfolio_count', count(*),
        'active_count', count(*) filter (where status = 'active'),
        'pending_count', count(*) filter (where status in ('pending','pending_approval')),
        'matured_count', count(*) filter (where status = 'matured'),
        'total_principal', coalesce(sum(investment_amount),0),
        'active_principal', coalesce(sum(investment_amount) filter (where status = 'active'),0),
        'total_returns', coalesce(sum(total_roi_earned),0),
        'first_portfolio_at', min(created_at),
        'last_portfolio_at', max(created_at)
      ) from investor_portfolios where investor_id = p_user_id
    ),
    'status_breakdown', (
      select coalesce(jsonb_agg(jsonb_build_object('status', status, 'count', c, 'principal', principal) order by principal desc), '[]'::jsonb)
      from (
        select coalesce(status,'unknown') status, count(*) c, coalesce(sum(investment_amount),0) principal
        from investor_portfolios where investor_id = p_user_id group by 1
      ) s
    ),
    'portfolios', (
      select coalesce(jsonb_agg(to_jsonb(q) order by (q.created_at) desc), '[]'::jsonb) from (
        select ip.id, ip.portfolio_code, ip.account_name, ip.investment_amount, ip.roi_percentage,
               ip.roi_mode, ip.total_roi_earned, ip.status, ip.duration_months, ip.created_at,
               ip.maturity_date, ip.next_roi_date, ip.payout_day, ip.auto_reinvest,
               ip.payment_method, ip.mobile_network, ip.mobile_money_number,
               ip.bank_name, ip.bank_account_name, ip.account_number,
               ip.cfo_verified, ip.cfo_verified_at, ip.locked_at, ip.lock_reason,
               ip.agent_id, ag.full_name as agent_name
        from investor_portfolios ip
        left join profiles ag on ag.id = ip.agent_id
        where ip.investor_id = p_user_id
      ) q
    ),
    'ledger', (
      select coalesce(jsonb_agg(to_jsonb(l) order by (l.transaction_date) desc), '[]'::jsonb) from (
        select g.id, g.transaction_date, g.created_at, g.amount, g.direction, g.category,
               g.sub_category, g.description, g.reference_id, g.wallet_bucket, g.classification
        from general_ledger g
        where g.user_id = p_user_id and g.ledger_scope = 'wallet'
        order by g.transaction_date desc
        limit 300
      ) l
    ),
    'topups', (
      select coalesce(jsonb_agg(to_jsonb(t) order by (t.created_at) desc), '[]'::jsonb) from (
        select st.id, st.amount, st.status, st.created_at, st.effective_at, st.prorata_amount,
               st.lines_count, st.reviewed_at, st.review_notes, st.rejection_reason
        from partner_self_topups st where st.partner_id = p_user_id
      ) t
    ),
    'pending_portfolios', (
      select coalesce(jsonb_agg(to_jsonb(f) order by (f.created_at) desc), '[]'::jsonb) from (
        select fp.id, fp.amount, fp.status, fp.source, fp.term_months, fp.created_at,
               fp.reviewed_at, fp.review_reason
        from funder_pending_portfolios fp where fp.funder_id = p_user_id
      ) f
    ),
    'redemptions', (
      select coalesce(jsonb_agg(to_jsonb(r) order by (r.created_at) desc), '[]'::jsonb) from (
        select pr.id, pr.portfolio_code, pr.scope, pr.redeemed_amount, pr.old_principal,
               pr.remaining_principal, pr.old_status, pr.new_status, pr.note, pr.created_at
        from portfolio_redemptions pr where pr.partner_id = p_user_id
      ) r
    ),
    'renewals', (
      select coalesce(jsonb_agg(to_jsonb(n) order by (n.created_at) desc), '[]'::jsonb) from (
        select pn.id, pn.portfolio_id, ip.portfolio_code, pn.created_at, pn.reason, pn.source, pn.is_auto,
               pn.old_maturity_date, pn.new_maturity_date, pn.old_roi_percentage, pn.new_roi_percentage,
               pn.old_investment_amount, pn.top_up_amount, pn.reversed_at, pn.reversal_reason
        from portfolio_renewals pn
        join investor_portfolios ip on ip.id = pn.portfolio_id
        where ip.investor_id = p_user_id
      ) n
    ),
    'requests', (
      select coalesce(jsonb_agg(to_jsonb(rq) order by (rq.created_at) desc), '[]'::jsonb) from (
        select ar.id, ar.portfolio_code, ar.request_type, ar.status, ar.message,
               ar.redemption_scope, ar.redemption_amount, ar.remaining_principal,
               ar.portfolio_value, ar.maturity_date, ar.created_at, ar.processed_at, ar.processing_note
        from portfolio_action_requests ar where ar.partner_id = p_user_id
      ) rq
    ),
    'withdrawals', (
      select coalesce(jsonb_agg(to_jsonb(w) order by (w.created_at) desc), '[]'::jsonb) from (
        select wr.id, wr.amount, wr.status, wr.reason, wr.payout_method, wr.created_at,
               wr.processed_at, wr.rejection_reason, wr.mobile_money_number, wr.bank_name
        from withdrawal_requests wr where wr.user_id = p_user_id
        order by wr.created_at desc limit 100
      ) w
    ),
    'changes', (
      select coalesce(jsonb_agg(to_jsonb(c) order by (c.created_at) desc), '[]'::jsonb) from (
        select al.id, al.created_at, al.action_type, al.action, al.reason, al.table_name,
               al.record_id, al.old_values, al.new_values, al.metadata,
               (select pf.full_name from profiles pf where pf.id = al.user_id) as actor_name
        from audit_logs al
        where (al.table_name = 'investor_portfolios'
                and al.record_id in (select id from investor_portfolios where investor_id = p_user_id))
           or (al.table_name = 'profiles' and al.record_id = p_user_id)
        order by al.created_at desc
        limit 200
      ) c
    )
  ) into v;

  return coalesce(v, '{}'::jsonb);
end;
$$;

revoke all on function public.partner_ops_search_partners(text, integer) from public, anon;
revoke all on function public.get_partner_360(uuid) from public, anon;
revoke all on function public.partner_ops_can_view() from public, anon;
grant execute on function public.partner_ops_can_view() to authenticated, service_role;
grant execute on function public.partner_ops_search_partners(text, integer) to authenticated, service_role;
grant execute on function public.get_partner_360(uuid) to authenticated, service_role;