-- Rollback of 20261107101000_partner_return_policy_phase4_masks.sql (Partner Returns Phase 4b).
-- Puts the five readers back to their PRODUCTION text byte for byte (captured with pg_get_functiondef from
-- byrzshwlentqvktcksem on 2026-11-07), then checks md5(pg_get_functiondef(oid)) against
-- supabase/tests/partner_return_policy/prod_function_manifest.json and raises on any mismatch (keep this
-- file LF-only: a CR inside a body changes the md5). CREATE OR REPLACE keeps every grant.
-- The readers' helper partner_returns_visible_to_caller is dropped. The assert is not touched (4a owns its hook). Roll back 4b BEFORE 4a (4a's rollback drops
-- partner_rate_visible_to_caller, which the 4b readers call).
-- Refused while Partner Returns is on or release-ready: unmasking would show people's own rates and Returns to
-- agents and anonymous viewers at once (turn the switch off and clear release_ready first).
DO $pre$
BEGIN
  IF to_regclass('public.partner_return_policy') IS NOT NULL THEN   -- nested: the table may not exist yet
    IF EXISTS (SELECT 1 FROM public.partner_return_policy p WHERE p.id AND (p.enabled OR p.release_ready)) THEN
      RAISE EXCEPTION '4b rollback refused: Partner Returns is on or release-ready; unmasking shows people''s own rates'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END $pre$;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.get_portfolio_by_activation_token(p_token uuid)
 RETURNS TABLE(portfolio_code text, investment_amount numeric, duration_months integer, roi_percentage numeric, roi_mode text, status text, created_at timestamp with time zone, next_roi_date date, maturity_date date, total_roi_earned numeric, agent_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.portfolio_code::text,
    p.investment_amount::numeric,
    p.duration_months::integer,
    p.roi_percentage::numeric,
    p.roi_mode::text,
    p.status::text,
    p.created_at,
    p.next_roi_date::date,
    p.maturity_date::date,
    coalesce(p.total_roi_earned, 0)::numeric,
    coalesce(ag.full_name, 'Agent')::text
  from public.investor_portfolios p
  left join public.profiles ag on ag.id = p.agent_id
  where p.activation_token = p_token
  limit 1
$function$
;

CREATE OR REPLACE FUNCTION public.agent_onboarded_portfolios()
 RETURNS TABLE(portfolio_id uuid, investor_id uuid, partner_name text, portfolio_code_masked text, investment_amount numeric, total_roi_earned numeric, roi_percentage numeric, duration_months integer, status text, created_at timestamp with time zone, next_roi_date date, maturity_date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (select (select auth.uid()) as uid),
  open_ports as (
    select distinct r.source_id
    from me, public.get_agent_proxy_roi_payouts(me.uid) r
    where me.uid is not null and r.source_id is not null
  ),
  recent_partners as (
    select distinct coalesce(w.proxy_partner_id, w.linked_party, w.user_id) as pid
    from (
      select x.proxy_partner_id, x.linked_party, x.user_id
      from public.withdrawal_requests x, me
      where me.uid is not null
        and (x.agent_id = me.uid or x.initiated_by = me.uid)
        and (x.proxy_partner_id is not null or x.linked_party is not null)
      order by x.created_at desc
      limit 500
    ) w
  )
  select t.portfolio_id, t.investor_id, t.partner_name, t.portfolio_code_masked, t.investment_amount, t.total_roi_earned,
    t.roi_percentage, t.duration_months, t.status, t.created_at, t.next_roi_date, t.maturity_date
  from (
    select case
        when p.id in (select source_id from open_ports) then 0
        when p.investor_id in (select pid from recent_partners) then 1
        else 2
      end as prio,
      p.id as portfolio_id,
      p.investor_id as investor_id,
      coalesce(pr.full_name, 'Partner') as partner_name,
      case
        when p.portfolio_code is null or length(p.portfolio_code) <= 4 then '****'
        else substr(p.portfolio_code, 1, 3) || repeat('*', greatest(length(p.portfolio_code) - 5, 2)) || right(p.portfolio_code, 2)
      end as portfolio_code_masked,
      p.investment_amount as investment_amount,
      coalesce(p.total_roi_earned, 0) as total_roi_earned,
      p.roi_percentage as roi_percentage,
      p.duration_months as duration_months,
      p.status::text as status,
      p.created_at as created_at,
      p.next_roi_date::date as next_roi_date,
      p.maturity_date::date as maturity_date
    from public.investor_portfolios p
    join me on me.uid is not null
    left join public.profiles pr on pr.id = p.investor_id
    where p.agent_id = me.uid
       or exists (
         select 1 from public.proxy_agent_assignments a
         where a.agent_id = me.uid
           and a.beneficiary_id = p.investor_id
           and a.is_active = true
           and a.approval_status = 'approved'
       )
    union all
    select 3,
      null::uuid,
      a.beneficiary_id,
      coalesce(pr.full_name, 'Partner'),
      null::text,
      0::numeric,
      0::numeric,
      null::numeric,
      null::integer,
      coalesce(a.approval_status, 'pending'),
      a.created_at,
      null::date,
      null::date
    from public.proxy_agent_assignments a
    join me on a.agent_id = me.uid
    left join public.profiles pr on pr.id = a.beneficiary_id
    where me.uid is not null
      and a.is_active = true
      and not exists (
        select 1 from public.investor_portfolios p
        where p.agent_id = a.agent_id and p.investor_id = a.beneficiary_id
      )
      and not exists (
        select 1 from public.investor_portfolios p
        where p.investor_id = a.beneficiary_id
          and a.approval_status = 'approved'
      )
  ) t
  order by t.prio, t.created_at desc
  limit 5000
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_trust_profile(p_ai_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM profiles WHERE 'WEL-' || UPPER(SUBSTRING(REPLACE(id::text,'-',''), 1, 6)) = UPPER(p_ai_id) LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'AI ID not found');
  END IF;

  RETURN public._get_user_trust_profile_impl(v_user_id);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_public_trust_profile(p_ai_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_full jsonb;
BEGIN
  v_full := get_user_trust_profile(p_ai_id);
  IF v_full ? 'error' THEN RETURN v_full; END IF;

  RETURN jsonb_build_object(
    'ai_id', v_full->'ai_id',
    'identity', jsonb_build_object(
      'full_name', v_full->'identity'->'full_name',
      'avatar_url', v_full->'identity'->'avatar_url',
      'verified', v_full->'identity'->'verified',
      'member_since', v_full->'identity'->'member_since',
      'primary_role', v_full->'identity'->'primary_role',
      'national_id_present', v_full->'identity'->'national_id_present',
      'roles', v_full->'identity'->'roles',
      'is_supporter', v_full->'identity'->'is_supporter'
    ),
    'trust', v_full->'trust',
    'payment_history', jsonb_build_object(
      'total_rent_plans', v_full->'payment_history'->'total_rent_plans',
      'on_time_rate', v_full->'payment_history'->'on_time_rate'
    ),
    'cash_flow_capacity', v_full->'cash_flow_capacity',
    'supporter_activity', jsonb_build_object(
      'is_supporter', v_full->'supporter_activity'->'is_supporter',
      'active_portfolios', v_full->'supporter_activity'->'active_portfolios',
      'roi_monthly_avg', v_full->'supporter_activity'->'roi_monthly_avg'
    ),
    'network', jsonb_build_object(
      'referrals', v_full->'network'->'referrals',
      'sub_agents', v_full->'network'->'sub_agents',
      'tenants_onboarded', v_full->'network'->'tenants_onboarded'
    ),
    'agent_performance', jsonb_build_object(
      'qualifying_tenants', v_full->'agent_performance'->'qualifying_tenants',
      'healthy_tenants', v_full->'agent_performance'->'healthy_tenants',
      'healthy_ratio', v_full->'agent_performance'->'healthy_ratio',
      'top_performing', v_full->'agent_performance'->'top_performing'
    ),
    'behavior', jsonb_build_object(
      'visits_total_60d', v_full->'behavior'->'visits_total_60d',
      'always_share_location', v_full->'behavior'->'always_share_location'
    ),
    'landlord_activity', v_full->'landlord_activity',
    'welile_vouches', true,
    'generated_at', NOW()
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_partner_wallet_hub(p_user_id uuid, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS TABLE(withdrawable_amount numeric, float_amount numeric, advance_amount numeric, roi_amount numeric, deposits_amount numeric, total_available numeric, pending_holds numeric, restricted_held numeric, recent_transactions jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin /* advisor_guard */ if public._direct_client_call() then if not (public.can_view_staff_reports(auth.uid()) or coalesce(p_user_id = auth.uid(), false) or coalesce(p_user_id in (select public.agent_wallet_network_ids(auth.uid())), false)) then raise exception 'not authorized' using errcode = '42501'; end if; end if; 
  RETURN QUERY
  WITH wallet_summary AS (
    SELECT
      COALESCE((gwv ->> 'withdrawable')::numeric, 0) AS withdrawable,
      COALESCE((gwv ->> 'float_balance')::numeric, 0) AS float_balance,
      COALESCE((gwv ->> 'advance_balance')::numeric, 0) AS advance_balance,
      COALESCE((gwv ->> 'pending_holds')::numeric, 0) AS pending_holds,
      COALESCE((gwv ->> 'restricted_held')::numeric, 0) AS restricted_held
    FROM public.get_user_wallet_view(p_user_id) AS gwv
  ),
  portfolio_summary AS (
    SELECT
      COALESCE(SUM(ip.total_roi_earned), 0) AS roi,
      COALESCE(SUM(ip.investment_amount), 0) AS deposits
    FROM public.investor_portfolios ip
    WHERE ip.investor_id = p_user_id
      AND ip.status IN ('active', 'funded', 'repaying', 'paused', 'locked', 'pending_activation')
  ),
  recent_tx AS (
    SELECT
      gl.id,
      gl.transaction_date,
      gl.amount,
      gl.direction,
      gl.category,
      gl.description,
      gl.reference_id,
      gl.linked_party,
      gl.source_table,
      gl.source_id,
      gl.classification,
      gl.created_at
    FROM public.general_ledger gl
    WHERE gl.user_id = p_user_id
      AND (
        gl.ledger_scope IN ('wallet', 'bridge')
        OR (
          gl.ledger_scope = 'platform'
          AND gl.category IN (
            'supporter_rent_fund',
            'partner_funding',
            'roi_wallet_credit',
            'roi_payout',
            'roi_accrual',
            'angel_pool_contribution',
            'angel_pool_refund',
            'portfolio_topup',
            'portfolio_redemption',
            'portfolio_principal_lock',
            'managed_proxy_payout',
            'proxy_partner_withdrawal'
          )
        )
      )
      AND public.is_customer_wallet_history_visible(
        p_user_id,
        gl.classification,
        gl.category,
        gl.source_table,
        gl.description,
        gl.reference_id,
        gl.source_id
      )
    ORDER BY gl.transaction_date DESC, gl.created_at DESC
    LIMIT p_limit
    OFFSET p_offset
  )
  SELECT
    ws.withdrawable,
    ws.float_balance,
    ws.advance_balance,
    ps.roi,
    ps.deposits,
    (ws.withdrawable + ws.float_balance + ps.roi),
    ws.pending_holds,
    ws.restricted_held,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', rt.id,
          'transaction_date', rt.transaction_date,
          'amount', rt.amount,
          'direction', rt.direction,
          'category', rt.category,
          'description', rt.description,
          'reference_id', rt.reference_id,
          'linked_party', rt.linked_party,
          'source_table', rt.source_table,
          'source_id', rt.source_id,
          'classification', rt.classification
        )
        ORDER BY rt.transaction_date DESC, rt.created_at DESC
      ) FILTER (WHERE rt.id IS NOT NULL),
      '[]'::jsonb
    ) AS recent_transactions
  FROM wallet_summary ws
  CROSS JOIN portfolio_summary ps
  LEFT JOIN recent_tx rt ON true
  GROUP BY ws.withdrawable, ws.float_balance, ws.advance_balance, ws.pending_holds,
           ws.restricted_held, ps.roi, ps.deposits;
END;
$function$
;

-- Byte-for-byte check against the production fingerprints (prod_function_manifest.json, 2026-11-07).
-- 4b's visibility helper: nothing calls it once the five readers are production's text again.
DROP FUNCTION IF EXISTS public.partner_returns_visible_to_caller(uuid);

DO $chk$
DECLARE
  r     record;
  v_md5 text;
  v_bad text := '';
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.get_portfolio_by_activation_token(uuid)',              'b82ca1f33296ea9c8c6cf0e2d1a17081'),
      ('public.agent_onboarded_portfolios()',                         'e45547745d5b3953eff339d3bec4eb38'),
      ('public.get_user_trust_profile(text)',                         '5670d97d253010a946d1788f43b540aa'),
      ('public.get_public_trust_profile(text)',                       '65fb57275ea0b6913c49fbfb7c0955b6'),
      ('public.get_partner_wallet_hub(uuid,integer,integer)',         'e3641e44af94609b60ab4c2016bde3f7')) f(fn, prod_md5)
  LOOP
    v_md5 := md5(pg_get_functiondef(r.fn::regprocedure));
    IF v_md5 IS DISTINCT FROM r.prod_md5 THEN
      v_bad := v_bad || format(' %s (md5 %s, expected %s);', r.fn, v_md5, r.prod_md5);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION '4b rollback: restored text differs from production:%', v_bad USING ERRCODE = '55000';
  END IF;
END $chk$;
