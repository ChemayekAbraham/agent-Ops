-- Partner Returns per person (Phase 4b): a person's own rate, and the Returns figures that reveal it,
-- are shown only to that person, partner staff, or an approved active proxy agent of that supporter (D2).
-- CREATE OR REPLACE with the production signatures, so grants are kept.
--
-- PENDING: do not apply until the published browser bundle tolerates NULL Returns figures (design v2 §8.2
-- step 4: §6.1, Gemini §6.2 items 4, 5, 11). Applied via the CLI; then moved into supabase/migrations/
-- (sorted after any Lovable copy). Requires 4a (partner_rate_visible_to_caller).
--
-- Each reader is rebuilt from its PRODUCTION text (md5 in prod_function_manifest.json, captured 2026-11-07)
-- with only the listed changes. The block below refuses to run if a reader changed in production since
-- (rebuild 4b from the live text then); a reader already carrying this file's marker is a re-apply.
--   * get_portfolio_by_activation_token (anon): rate and Returns earned only for an invite portfolio with
--     no person yet, the person, or partner staff.
--   * agent_onboarded_portfolios: rate and Returns earned only for the caller's own portfolio, partner
--     staff, or an approved active proxy of that supporter; creator-only rows get NULL.
--   * get_user_trust_profile: for a person who has Returns (any portfolio, or Returns paid), every figure that
--     contains their Returns or their portfolio principal is NULL (keys kept) unless self, partner staff or an
--     approved active proxy (D9). Anyone else's profile (no Returns) is the impl's answer unchanged.
--   * get_public_trust_profile: shows get_user_trust_profile's (masked) answer; adds
--     supporter_activity.earning_returns (boolean).
--   * get_partner_wallet_hub: Returns earned (and the total that contains it) NULL and Returns ledger rows
--     left out unless self, partner staff or approved active proxy. Deposits and other rows unchanged.
-- All four masking readers ask one helper, partner_returns_visible_to_caller (self, partner staff, approved
-- active supporter proxy); get_public_trust_profile masks nothing itself.
-- Rollback: supabase/rollbacks/20261108163000_partner_return_policy_phase4_masks.rollback.sql
SET LOCAL lock_timeout = '1s';   -- not 5s: everything queues behind a waiting lock; on a timeout retry the apply

DO $pre$
DECLARE
  r     record;
  v_oid regprocedure;
  v_bad text := '';
BEGIN
  IF to_regprocedure('public.partner_rate_visible_to_caller(uuid)') IS NULL THEN
    RAISE EXCEPTION '4b needs 4a (partner_rate_visible_to_caller is missing)' USING ERRCODE = '55000';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public.get_portfolio_by_activation_token(uuid)',              'b82ca1f33296ea9c8c6cf0e2d1a17081'),
      ('public.agent_onboarded_portfolios()',                         'e45547745d5b3953eff339d3bec4eb38'),
      ('public.get_user_trust_profile(text)',                         '5670d97d253010a946d1788f43b540aa'),
      ('public.get_public_trust_profile(text)',                       '65fb57275ea0b6913c49fbfb7c0955b6'),
      ('public.get_partner_wallet_hub(uuid,integer,integer)',         'e3641e44af94609b60ab4c2016bde3f7')) f(fn, prod_md5)
  LOOP
    v_oid := to_regprocedure(r.fn);
    IF v_oid IS NULL THEN
      v_bad := v_bad || ' ' || r.fn || ' (missing);';
    ELSIF md5(pg_get_functiondef(v_oid)) IS DISTINCT FROM r.prod_md5
          AND position('Partner Returns Phase 4b' IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = v_oid)) = 0 THEN
      v_bad := v_bad || format(' %s (md5 %s, expected %s);', r.fn, md5(pg_get_functiondef(v_oid)), r.prod_md5);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION '4b refuses: these readers differ from the production text it was built on:% rebuild 4b from the live text', v_bad
      USING ERRCODE = '55000';
  END IF;
END $pre$;

-- ===========================================================================
-- 0. The one rule for "may the caller see this person's Returns" (D2): the person, partner staff
--    (partner_rate_visible_to_caller: the staff list with staff MFA, or a backend context), or an approved,
--    active proxy agent of that person as a supporter (the set get_agent_proxy_roi_payouts already reports
--    that supporter's payouts to). Never NULL. Owner-run readers only.
--    Cost: one proxy_agent_assignments probe and, when that misses, one user_roles probe per person.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.partner_returns_visible_to_caller(p_person uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_person IS NOT NULL AND (
           COALESCE((SELECT auth.uid()) = p_person, false)
        OR EXISTS (SELECT 1 FROM public.proxy_agent_assignments m
                    WHERE m.agent_id = (SELECT auth.uid()) AND m.beneficiary_id = p_person
                      AND m.is_active = true AND m.approval_status = 'approved'
                      AND m.beneficiary_role = 'supporter')
        OR COALESCE(public.partner_rate_visible_to_caller(p_person), false));
$function$;
REVOKE ALL ON FUNCTION public.partner_returns_visible_to_caller(uuid) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.partner_returns_visible_to_caller(uuid) IS
  'True when the caller may see this person''s Returns figures and rate: the person, partner staff (or a backend context), or an approved active supporter proxy agent. Never NULL. Owner-run 4b readers only.';

-- ===========================================================================
-- 1. get_portfolio_by_activation_token (anon, authenticated, service_role kept). Single-row reader.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.get_portfolio_by_activation_token(p_token uuid)
 RETURNS TABLE(portfolio_code text, investment_amount numeric, duration_months integer, roi_percentage numeric,
               roi_mode text, status text, created_at timestamp with time zone, next_roi_date date,
               maturity_date date, total_roi_earned numeric, agent_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Partner Returns Phase 4b: the rate and the Returns earned so far (which reveals the rate) only for an
  -- invite portfolio with no person yet (it carries the public or the typed rate), the person, partner
  -- staff or their approved proxy. Anyone else holding the link (anon) gets NULLs.
  SELECT p.portfolio_code::text,
         p.investment_amount::numeric,
         p.duration_months::integer,
         CASE WHEN v.ok THEN p.roi_percentage::numeric END,
         p.roi_mode::text,
         p.status::text,
         p.created_at,
         p.next_roi_date::date,
         p.maturity_date::date,
         CASE WHEN v.ok THEN COALESCE(p.total_roi_earned, 0)::numeric END,
         COALESCE(ag.full_name, 'Agent')::text
    FROM public.investor_portfolios p
    LEFT JOIN public.profiles ag ON ag.id = p.agent_id
    CROSS JOIN LATERAL (SELECT p.investor_id IS NULL
                               OR public.partner_returns_visible_to_caller(p.investor_id) AS ok) v
   WHERE p.activation_token = p_token
   LIMIT 1
$function$;

-- ===========================================================================
-- 2. agent_onboarded_portfolios (authenticated, service_role kept). Request-level parts computed once in
--    the me CTE. Approved active proxies of a supporter (managed or not) see the figures: the same set
--    get_agent_proxy_roi_payouts already reports that supporter's payouts to (D2).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.agent_onboarded_portfolios()
 RETURNS TABLE(portfolio_id uuid, investor_id uuid, partner_name text, portfolio_code_masked text,
               investment_amount numeric, total_roi_earned numeric, roi_percentage numeric,
               duration_months integer, status text, created_at timestamp with time zone,
               next_roi_date date, maturity_date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Partner Returns Phase 4b: total_roi_earned and roi_percentage only for the caller's own portfolio,
  -- partner staff, or an approved active proxy of that supporter. Rows visible only because the caller
  -- created the portfolio (agent_id) get NULL.
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
      case when v.ok then coalesce(p.total_roi_earned, 0) end as total_roi_earned,
      case when v.ok then p.roi_percentage end as roi_percentage,
      p.duration_months as duration_months,
      p.status::text as status,
      p.created_at as created_at,
      p.next_roi_date::date as next_roi_date,
      p.maturity_date::date as maturity_date
    from public.investor_portfolios p
    join me on me.uid is not null
    left join public.profiles pr on pr.id = p.investor_id
    cross join lateral (select public.partner_returns_visible_to_caller(p.investor_id) as ok) v
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
$function$;

-- ===========================================================================
-- 3. get_user_trust_profile (authenticated, service_role kept). Production is a thin wrapper around
--    _get_user_trust_profile_impl(uuid) (service_role only, fingerprinted in the manifest); the masking is
--    applied here, on the impl's answer, so the impl and its backend callers are unchanged. PII masking
--    (permissions.can_see_pii) is unchanged.
--    Every figure of the production impl (text of 2026-11-07, md5 08b63c3f...) that contains a supporter's
--    Returns or portfolio principal, directly or inside a sum:
--      Returns:   supporter_activity total_roi_earned, roi_paid_30d, roi_paid_180d, roi_monthly_avg;
--                 cash_flow_capacity roi_monthly, and monthly_avg / weekly_avg / daily_avg (wallet_monthly +
--                 roi_monthly_avg, then *7/30 and /30);
--      principal: supporter_activity portfolio_value, network portfolio_value,
--                 trust.vouch_breakdown.portfolio_component_ugx;
--      both:      trust.vouch_breakdown.booster_breakdown.payment_history (total_repaid * 0.3 +
--                 (wallet_monthly + roi_monthly_avg) * 0.25), trust.vouch_breakdown.boosters_ugx (the sum of
--                 the boosters), trust.vouch_breakdown.total_ugx and trust.borrowing_limit_ugx (portfolio +
--                 shares + boosters), trust.breakdown.supporter (principal band + log10 of the Returns paid in
--                 180 days + active portfolios), and trust.score (the sum of the breakdown parts, so the
--                 supporter part is the score minus the other, visible, parts).
--    Each is set to JSON null (key kept) unless the viewer is the person, partner staff or an approved active
--    proxy agent of that supporter - and only when the person has Returns (any portfolio as investor, or any
--    Returns paid). Someone without Returns (a tenant, an agent) gets the impl's answer unchanged, so their
--    cash-flow capacity and vouch limit stay visible exactly as today.
--    Left visible: trust.tier (a band of the score) and trust.data_points (+3 / +2 when principal / Returns
--    exist: whether, not how much, which earning_returns says anyway); the wallet figures (wallet_activity.*,
--    cash_flow_capacity wallet_monthly, inflow_30d, outflow_30d: wallet flows, which can include Returns
--    credited to the wallet, the same residual as the wallet hub's withdrawable); angel shares.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.get_user_trust_profile(p_ai_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_full    jsonb;
  v_path    text;
BEGIN
  SELECT id INTO v_user_id FROM profiles WHERE 'WEL-' || UPPER(SUBSTRING(REPLACE(id::text,'-',''), 1, 6)) = UPPER(p_ai_id) LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'AI ID not found');
  END IF;

  v_full := public._get_user_trust_profile_impl(v_user_id);

  -- Partner Returns Phase 4b (D9): a person's Returns and principal (and every vouch figure built from them)
  -- only for the person, partner staff or an approved active proxy agent of that supporter; masked only when
  -- the person has Returns.
  IF jsonb_typeof(v_full) = 'object' AND NOT (v_full ? 'error')
     AND NOT public.partner_returns_visible_to_caller(v_user_id) THEN
    IF EXISTS (SELECT 1 FROM public.investor_portfolios ip WHERE ip.investor_id = v_user_id)
       OR EXISTS (SELECT 1 FROM public.supporter_roi_payments r
                   WHERE r.supporter_id = v_user_id AND r.status = 'paid') THEN
      FOREACH v_path IN ARRAY ARRAY[
          'supporter_activity.portfolio_value', 'supporter_activity.total_roi_earned',
          'supporter_activity.roi_paid_30d', 'supporter_activity.roi_paid_180d', 'supporter_activity.roi_monthly_avg',
          'cash_flow_capacity.roi_monthly', 'cash_flow_capacity.monthly_avg', 'cash_flow_capacity.weekly_avg',
          'cash_flow_capacity.daily_avg', 'network.portfolio_value',
          'trust.score', 'trust.borrowing_limit_ugx', 'trust.breakdown.supporter',
          'trust.vouch_breakdown.total_ugx', 'trust.vouch_breakdown.portfolio_component_ugx',
          'trust.vouch_breakdown.boosters_ugx', 'trust.vouch_breakdown.booster_breakdown.payment_history']
      LOOP
        v_full := jsonb_set(v_full, string_to_array(v_path, '.'), 'null'::jsonb, false);   -- existing keys only
      END LOOP;
    END IF;
  END IF;

  RETURN v_full;
END;
$function$;

-- ===========================================================================
-- 4. get_public_trust_profile (PUBLIC, anon, authenticated, service_role kept). The production text with one
--    addition: supporter_activity.earning_returns (boolean: a live or pending portfolio, or Returns paid in the
--    last 180 days). Its figures come from get_user_trust_profile, which already masks a person's Returns and
--    principal for anyone but the person, partner staff or their approved proxy (an anonymous caller is none
--    of these), so this reader masks nothing itself and a person without Returns looks exactly as today.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.get_public_trust_profile(p_ai_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_full jsonb;
  v_uid  uuid;
  v_earning boolean;
BEGIN
  v_full := get_user_trust_profile(p_ai_id);
  IF v_full ? 'error' THEN RETURN v_full; END IF;

  -- Partner Returns Phase 4b (D9): the figures below are get_user_trust_profile's, masked there; everyone
  -- learns whether the person is earning Returns.
  v_uid := NULLIF(v_full ->> 'user_id', '')::uuid;
  v_earning := v_uid IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.investor_portfolios ip
                WHERE ip.investor_id = v_uid
                  AND ip.status IN ('active', 'pending', 'pending_approval', 'matured')
                  AND COALESCE(ip.investment_amount, 0) > 0)
    OR EXISTS (SELECT 1 FROM public.supporter_roi_payments r
                WHERE r.supporter_id = v_uid AND r.status = 'paid'
                  AND r.paid_at > now() - interval '180 days' AND COALESCE(r.roi_amount, 0) > 0));

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
      'roi_monthly_avg', v_full->'supporter_activity'->'roi_monthly_avg',
      'earning_returns', v_earning
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
$function$;

-- ===========================================================================
-- 5. get_partner_wallet_hub (authenticated, service_role kept). For anyone but the person, partner staff
--    or an approved active proxy (e.g. another agent in the wallet network): roi_amount NULL, total_available
--    NULL (it is withdrawable + float + Returns earned, so it would give it back), and rows with a Returns
--    category left out (their descriptions carry "X% monthly reward"). The production text lists
--    roi_wallet_credit, roi_payout, roi_accrual (and managed_proxy_payout, held back to be safe); the
--    production ledger also carries roi_reinvestment, roi_expense, interest_expense, supporter_platform_rewards
--    and partner_returns_allocated (checked 2026-11-07).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.get_partner_wallet_hub(p_user_id uuid, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS TABLE(withdrawable_amount numeric, float_amount numeric, advance_amount numeric, roi_amount numeric, deposits_amount numeric, total_available numeric, pending_holds numeric, restricted_held numeric, recent_transactions jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Partner Returns Phase 4b (D9): Returns figures only for the person, partner staff or an approved
  -- active proxy agent of that supporter.
  v_rate_ok boolean;
begin /* advisor_guard */ if public._direct_client_call() then if not (public.can_view_staff_reports(auth.uid()) or coalesce(p_user_id = auth.uid(), false) or coalesce(p_user_id in (select public.agent_wallet_network_ids(auth.uid())), false)) then raise exception 'not authorized' using errcode = '42501'; end if; end if;
  v_rate_ok := public.partner_returns_visible_to_caller(p_user_id);
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
      CASE WHEN v_rate_ok THEN COALESCE(SUM(ip.total_roi_earned), 0) END AS roi,
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
      AND (v_rate_ok OR gl.category <> ALL (ARRAY[
            'roi_wallet_credit', 'roi_payout', 'roi_accrual', 'roi_reinvestment', 'roi_expense',
            'interest_expense', 'supporter_platform_rewards', 'partner_returns_allocated',
            'managed_proxy_payout']))
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
    (ws.withdrawable + ws.float_balance + ps.roi),   -- NULL while ps.roi is masked
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
$function$;

-- ===========================================================================
-- 6. welile_trust_score_cache.borrowing_limit_ugx (owner decision 2026-11-08, "hide it"): the browser reads
--    the computed field borrowing_limit_shown (20261108164500) instead. Remove the browser's SELECT on the raw
--    column: the table-level SELECT goes, and authenticated gets SELECT on every other column (built from the
--    live column list, so a column added later is not silently opened or closed by this file). anon had no
--    row policy, so it gets nothing back. Writes are unchanged (only the service-role policy allows them).
-- ===========================================================================
DO $cache$
DECLARE
  v_cols text;
BEGIN
  IF to_regprocedure('public.borrowing_limit_shown(public.welile_trust_score_cache)') IS NULL THEN
    RAISE EXCEPTION '4b needs 20261108164500 (borrowing_limit_shown is missing)' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
              WHERE d.refobjid = 'public.welile_trust_score_cache'::regclass AND d.classid = 'pg_rewrite'::regclass
                AND r.ev_class <> 'public.welile_trust_score_cache'::regclass) THEN
    RAISE EXCEPTION '4b: a view reads welile_trust_score_cache; check it before closing borrowing_limit_ugx' USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.welile_trust_score_cache'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname <> 'borrowing_limit_ugx';
  REVOKE SELECT ON public.welile_trust_score_cache FROM anon, authenticated;
  EXECUTE format('GRANT SELECT (%s) ON public.welile_trust_score_cache TO authenticated', v_cols);
END $cache$;
NOTIFY pgrst, 'reload schema';
