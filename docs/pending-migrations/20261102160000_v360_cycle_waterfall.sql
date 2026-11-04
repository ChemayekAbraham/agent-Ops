-- NOT APPLIED. Benjamin must approve this file before it is run.
-- Do not apply it to project byrzshwlentqvktcksem from this pull request.
--
-- 360-day Rent Plan cycle economics (pricing_version = 'v360' only).
-- Legacy and every non-v360 plan are not read or rewritten.
-- This file does not set v360_settings.new_plans_enabled and refuses to run
-- while that switch is on, so applying it cannot start stamping new plans.
--
-- Approved cycle, exact shillings (src/lib/contractEngine360.ts v360CycleWaterfall):
--   Rail   = max(3500, ceil(P / 40))          -- 2.5% of P, rounded up
--   Gross  = ceil((115*P + 100*Rail) / 83)    -- CEIL((P*1.15 + Rail) / 0.83)
--   Daily  = ceil(Gross / 30)
--   Collected = Daily * 30
--   Sub-agent floor(6% of Gross), general agent floor(2%), Cover Pool floor(2%)
--   plus the rounding residual and the Collected-Gross surplus.
--   Welile floor(7%). Tithe floor(10% of that 7%), only from Welile's share.
--   Proxy Agent round-half-even(2% of P), once, from cycle 1 of the Cover Pool.
--   Partner margin round-half-even(15% of P): a target, not a guarantee.
--
-- Worked example P = 100,000: Gross 142,772, Daily 4,760, collected 142,800,
-- sub 8,566, general 2,855, rail 3,500, landlord 100,000, partner 15,000,
-- Cover Pool 2,885 (cycle 1: proxy 2,000 and pool 885), Welile 9,994
-- (tithe 999, Welile keeps 8,995).
--
-- Records only. Nothing here calls create_ledger_transaction. Ledger categories
-- are the next file. Day-30 draws on a plan that already has a cycle settlement
-- cannot exceed that plan's retained Cover Pool. Plans with no settlement keep
-- the previous draw behaviour.

SET lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('public.v360_settings') IS NULL
     OR to_regprocedure('public.compute_rent_repayment_v360(numeric,integer)') IS NULL THEN
    RAISE EXCEPTION 'v360 pricing is not installed; nothing was changed';
  END IF;
  IF coalesce((SELECT new_plans_enabled FROM public.v360_settings), false) THEN
    RAISE EXCEPTION 'v360_settings.new_plans_enabled is ON. Turn it off before applying. This file does not change the switch.';
  END IF;
END
$guard$;

-- Who onboarded a partner (Platform Sales Officer / Proxy Agent).
-- One row per partner, written once. There is no existing column that proves
-- who onboarded a partner for a funding: proxy_partner_invites records an
-- invite, not this fee. Until a row exists the cycle-1 fee stays in the Cover Pool.
CREATE TABLE IF NOT EXISTS public.v360_partner_onboarding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_user_id uuid NOT NULL,
  onboarded_by uuid NOT NULL,
  note text,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT v360_partner_onboarding_distinct CHECK (partner_user_id <> onboarded_by),
  CONSTRAINT v360_partner_onboarding_partner_uq UNIQUE (partner_user_id)
);

GRANT SELECT ON public.v360_partner_onboarding TO authenticated;
GRANT ALL ON public.v360_partner_onboarding TO service_role;
ALTER TABLE public.v360_partner_onboarding ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS v360_partner_onboarding_read ON public.v360_partner_onboarding;
CREATE POLICY v360_partner_onboarding_read ON public.v360_partner_onboarding
  FOR SELECT TO authenticated
  USING (
    (SELECT public._am_staff_ok())
    OR partner_user_id = (SELECT auth.uid())
    OR onboarded_by = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS mfa_required_for_staff ON public.v360_partner_onboarding;
CREATE POLICY mfa_required_for_staff ON public.v360_partner_onboarding
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

CREATE INDEX IF NOT EXISTS v360_partner_onboarding_onboarded_by_idx
  ON public.v360_partner_onboarding (onboarded_by);

CREATE OR REPLACE FUNCTION public.v360_record_partner_onboarding(
  p_partner_user_id uuid,
  p_onboarded_by uuid,
  p_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    (SELECT has_role((SELECT auth.uid()), 'partner_ops'::app_role))
    OR (SELECT has_role((SELECT auth.uid()), 'cfo'::app_role))
    OR (SELECT has_role((SELECT auth.uid()), 'coo'::app_role))
    OR (SELECT has_role((SELECT auth.uid()), 'ceo'::app_role))
    OR (SELECT has_role((SELECT auth.uid()), 'super_admin'::app_role))
  ) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_partner_user_id IS NULL OR p_onboarded_by IS NULL OR p_partner_user_id = p_onboarded_by THEN
    RAISE EXCEPTION 'Partner and a different onboarding agent are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.v360_partner_onboarding (partner_user_id, onboarded_by, note, recorded_by)
  VALUES (p_partner_user_id, p_onboarded_by, NULLIF(btrim(coalesce(p_note, '')), ''), (SELECT auth.uid()));
  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'This partner already has an onboarding record. It is not overwritten.' USING ERRCODE = '23505';
END;
$$;

REVOKE ALL ON FUNCTION public.v360_record_partner_onboarding(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v360_record_partner_onboarding(uuid, uuid, text) TO authenticated, service_role;

-- Canonical cycle. Integer shillings. Does not read or write a plan.
CREATE OR REPLACE FUNCTION public.v360_cycle_waterfall(p_principal numeric, p_cycle int DEFAULT 1)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  p bigint;
  v_cycle int;
  v_rail bigint;
  v_gross bigint;
  v_daily bigint;
  v_collected bigint;
  v_sub bigint;
  v_gen bigint;
  v_cp_pct bigint;
  v_wel bigint;
  v_tithe bigint;
  v_margin bigint;
  v_proxy bigint;
  v_resid bigint;
  v_surplus bigint;
  v_cp bigint;
  v_retained bigint;
  q bigint;
  rem bigint;
BEGIN
  IF p_principal IS NULL OR p_principal <= 0 THEN
    RAISE EXCEPTION 'Rent amount must be above zero' USING ERRCODE = '22023';
  END IF;
  IF p_cycle IS NULL OR p_cycle < 1 OR p_cycle > 12 THEN
    RAISE EXCEPTION 'Cycle must be between 1 and 12' USING ERRCODE = '22023';
  END IF;
  p := round(p_principal)::bigint;
  v_cycle := p_cycle;
  v_rail := greatest(3500, (p + 39) / 40);
  v_gross := (115 * p + 100 * v_rail + 82) / 83;
  v_daily := (v_gross + 29) / 30;
  v_collected := v_daily * 30;
  v_sub := (v_gross * 6) / 100;
  v_gen := (v_gross * 2) / 100;
  v_cp_pct := (v_gross * 2) / 100;
  v_wel := (v_gross * 7) / 100;
  v_tithe := v_wel / 10;
  q := (p * 15) / 100;
  rem := (p * 15) % 100;
  IF rem < 50 THEN v_margin := q;
  ELSIF rem > 50 THEN v_margin := q + 1;
  ELSIF q % 2 = 0 THEN v_margin := q;
  ELSE v_margin := q + 1;
  END IF;
  q := (p * 2) / 100;
  rem := (p * 2) % 100;
  IF rem < 50 THEN v_proxy := q;
  ELSIF rem > 50 THEN v_proxy := q + 1;
  ELSIF q % 2 = 0 THEN v_proxy := q;
  ELSE v_proxy := q + 1;
  END IF;
  IF v_cycle <> 1 THEN v_proxy := 0; END IF;
  v_resid := v_gross - (v_sub + v_gen + v_cp_pct + v_wel + v_rail + p + v_margin);
  v_surplus := v_collected - v_gross;
  v_cp := v_cp_pct + v_resid + v_surplus;
  IF v_proxy > v_cp THEN
    RAISE EXCEPTION 'Proxy Agent fee exceeds the cycle 1 Cover Pool' USING ERRCODE = '22023';
  END IF;
  v_retained := v_cp - v_proxy;
  RETURN jsonb_build_object(
    'pricing_version', 'v360',
    'principal', p,
    'cycle', v_cycle,
    'rail', v_rail,
    'gross', v_gross,
    'daily', v_daily,
    'collected', v_collected,
    'surplus', v_surplus,
    'residual', v_resid,
    'agent_sub', v_sub,
    'agent_general', v_gen,
    'agent', v_sub + v_gen,
    'cover_pool_percent', v_cp_pct,
    'cover_pool', v_cp,
    'proxy', v_proxy,
    'cover_pool_retained', v_retained,
    'welile', v_wel,
    'tithe', v_tithe,
    'welile_net', v_wel - v_tithe,
    'landlord', p,
    'partner_margin', v_margin,
    'partner_monthly', v_margin,
    'partner_12_months', v_margin * 12,
    'receivable_360', 360 * v_daily
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v360_cycle_waterfall(numeric, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v360_cycle_waterfall(numeric, int) TO authenticated, service_role;

-- Months = 1 uses the approved cycle. Any other month count keeps the previous
-- compound quote, which nothing in the app calls. Legacy plans never call this.
CREATE OR REPLACE FUNCTION public.compute_rent_repayment_v360(p_principal numeric, p_months int DEFAULT 1)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_rail numeric;
  v_gross numeric;
  v_daily numeric;
BEGIN
  IF p_months = 1 THEN
    RETURN public.v360_cycle_waterfall(p_principal, 1);
  END IF;
  IF p_principal IS NULL OR p_principal <= 0 THEN RAISE EXCEPTION 'Rent amount must be above zero'; END IF;
  IF p_months < 1 OR p_months > 12 THEN RAISE EXCEPTION 'Months must be between 1 and 12'; END IF;
  v_rail := greatest(3500 * p_months, 0.025 * p_months * p_principal);
  v_gross := ceil((p_principal * power(1.15::numeric, p_months) + v_rail) / (0.90 - 0.07 * p_months));
  v_daily := ceil(v_gross / (30 * p_months));
  RETURN jsonb_build_object(
    'pricing_version', 'v360', 'principal', p_principal, 'gross', v_gross, 'daily', v_daily,
    'partner_monthly', round(p_principal * 0.15), 'partner_12_months', round(p_principal * 0.15) * 12,
    'agent', round(v_gross * 0.10), 'rail', v_rail, 'welile', round(v_gross * 0.07),
    'receivable_360', 360 * v_daily,
    'note', 'multi-month compound quote, not the approved 30-day cycle'
  );
END;
$$;

-- CREATE OR REPLACE keeps the existing grants.

ALTER TABLE public.v360_daily_allocations
  ADD COLUMN IF NOT EXISTS cycle_no int,
  ADD COLUMN IF NOT EXISTS agent_sub numeric,
  ADD COLUMN IF NOT EXISTS agent_general numeric,
  ADD COLUMN IF NOT EXISTS cover_pool numeric,
  ADD COLUMN IF NOT EXISTS proxy_agent numeric,
  ADD COLUMN IF NOT EXISTS tithe numeric,
  ADD COLUMN IF NOT EXISTS welile_net numeric,
  ADD COLUMN IF NOT EXISTS economics_version text,
  ADD COLUMN IF NOT EXISTS split_quality text;

COMMENT ON COLUMN public.v360_daily_allocations.economics_version IS
  'v360-2026-11-02 for rows split under the approved cycle. Older rows stay null.';

CREATE TABLE IF NOT EXISTS public.v360_cycle_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL REFERENCES public.rent_requests(id),
  cycle_no int NOT NULL CHECK (cycle_no BETWEEN 1 AND 12),
  principal numeric NOT NULL,
  gross numeric NOT NULL,
  daily numeric NOT NULL,
  collected numeric NOT NULL,
  agent_sub numeric NOT NULL,
  agent_general numeric NOT NULL,
  rail numeric NOT NULL,
  landlord numeric NOT NULL,
  partner_margin numeric NOT NULL,
  cover_pool numeric NOT NULL,
  proxy_calculated numeric NOT NULL,
  proxy_agent numeric NOT NULL,
  cover_pool_retained numeric NOT NULL,
  welile numeric NOT NULL,
  tithe numeric NOT NULL,
  welile_net numeric NOT NULL,
  proxy_onboarded_by uuid,
  proxy_status text NOT NULL CHECK (proxy_status IN ('attributed', 'unattributed', 'not_due')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT v360_cycle_settlements_plan_cycle_uq UNIQUE (rent_request_id, cycle_no),
  CONSTRAINT v360_cycle_settlements_balance CHECK (
    agent_sub + agent_general + rail + landlord + partner_margin + cover_pool_retained + proxy_agent + welile = collected
    AND cover_pool_retained + proxy_agent = cover_pool
    AND tithe + welile_net = welile
    AND (proxy_status <> 'attributed' OR (proxy_agent = proxy_calculated AND proxy_onboarded_by IS NOT NULL))
    AND (proxy_status <> 'unattributed' OR (proxy_agent = 0 AND proxy_calculated >= 0))
    AND (proxy_status <> 'not_due' OR (proxy_agent = 0 AND proxy_calculated = 0))
  )
);

GRANT SELECT ON public.v360_cycle_settlements TO authenticated;
GRANT ALL ON public.v360_cycle_settlements TO service_role;
ALTER TABLE public.v360_cycle_settlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS v360_cycle_settlements_staff_read ON public.v360_cycle_settlements;
CREATE POLICY v360_cycle_settlements_staff_read ON public.v360_cycle_settlements
  FOR SELECT TO authenticated
  USING ((SELECT public._am_staff_ok()));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.v360_cycle_settlements;
CREATE POLICY mfa_required_for_staff ON public.v360_cycle_settlements
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

CREATE INDEX IF NOT EXISTS v360_cycle_settlements_proxy_idx
  ON public.v360_cycle_settlements (proxy_onboarded_by)
  WHERE proxy_onboarded_by IS NOT NULL;

-- Owner-only. Spreads p_cash across the canonical weights so a full cycle is exact.
CREATE OR REPLACE FUNCTION public._v360_largest_remainder(p_weights bigint[], p_cash bigint, p_total bigint)
RETURNS bigint[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  n int;
  i int;
  best int;
  floors bigint[];
  fracs bigint[];
  left_n bigint;
BEGIN
  n := coalesce(array_length(p_weights, 1), 0);
  IF n = 0 OR p_total IS NULL OR p_total <= 0 OR p_cash IS NULL OR p_cash < 0 THEN
    RAISE EXCEPTION 'Bad collection split' USING ERRCODE = '22023';
  END IF;
  floors := array_fill(0::bigint, ARRAY[n]);
  fracs := array_fill(0::bigint, ARRAY[n]);
  left_n := p_cash;
  FOR i IN 1..n LOOP
    floors[i] := (p_weights[i] * p_cash) / p_total;
    fracs[i] := (p_weights[i] * p_cash) % p_total;
    left_n := left_n - floors[i];
  END LOOP;
  WHILE left_n > 0 LOOP
    best := 1;
    FOR i IN 2..n LOOP
      IF fracs[i] > fracs[best] OR (fracs[i] = fracs[best] AND i < best) THEN
        best := i;
      END IF;
    END LOOP;
    floors[best] := floors[best] + 1;
    fracs[best] := -1;
    left_n := left_n - 1;
  END LOOP;
  RETURN floors;
END;
$$;

REVOKE ALL ON FUNCTION public._v360_largest_remainder(bigint[], bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._v360_largest_remainder(bigint[], bigint, bigint) TO service_role;

CREATE OR REPLACE FUNCTION public._v360_waterfall_core(
  p_rent_request_id uuid,
  p_cash numeric,
  p_paid_on date,
  p_by uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.rent_requests;
  q jsonb;
  v_cycle int;
  v_collected bigint;
  v_cash bigint;
  v_proxy_done boolean;
  v_who uuid;
  v_pay_proxy boolean;
  weights bigint[];
  parts bigint[];
  v_sub bigint;
  v_gen bigint;
  v_rail bigint;
  v_land bigint;
  v_margin bigint;
  v_retained bigint;
  v_proxy bigint;
  v_wel bigint;
  v_tithe bigint;
  v_cycle_cash numeric;
BEGIN
  IF p_cash IS NULL OR p_cash <= 0 THEN
    RAISE EXCEPTION 'Amount must be above zero' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF r.id IS NULL OR r.pricing_version <> 'v360' OR r.v360_started_on IS NULL THEN
    RAISE EXCEPTION 'Not an active 360-day Rent Plan' USING ERRCODE = '22023';
  END IF;
  v_cycle := least(12, 1 + (r.v360_paid_days / 30));
  q := public.v360_cycle_waterfall(r.rent_amount, v_cycle);
  v_collected := (q->>'collected')::bigint;
  v_cash := round(p_cash)::bigint;
  SELECT EXISTS (
    SELECT 1 FROM public.v360_daily_allocations a
    WHERE a.rent_request_id = r.id AND a.cycle_no = 1 AND coalesce(a.proxy_agent, 0) > 0
  ) INTO v_proxy_done;
  IF v_cycle = 1 AND r.supporter_id IS NOT NULL THEN
    SELECT onboarded_by INTO v_who
    FROM public.v360_partner_onboarding
    WHERE partner_user_id = r.supporter_id;
  END IF;
  -- No onboarding row: the calculated fee stays in the Cover Pool. It is not paid.
  v_pay_proxy := v_cycle = 1 AND NOT v_proxy_done AND v_who IS NOT NULL;
  weights := ARRAY[
    (q->>'agent_sub')::bigint,
    (q->>'agent_general')::bigint,
    (q->>'rail')::bigint,
    (q->>'landlord')::bigint,
    (q->>'partner_margin')::bigint,
    CASE WHEN v_pay_proxy THEN (q->>'cover_pool_retained')::bigint ELSE (q->>'cover_pool')::bigint END,
    CASE WHEN v_pay_proxy THEN (q->>'proxy')::bigint ELSE 0 END,
    (q->>'welile')::bigint
  ];
  IF weights[1] + weights[2] + weights[3] + weights[4] + weights[5] + weights[6] + weights[7] + weights[8] <> v_collected THEN
    RAISE EXCEPTION 'Cycle weights do not add up to collections' USING ERRCODE = '22023';
  END IF;
  parts := public._v360_largest_remainder(weights, v_cash, v_collected);
  v_sub := parts[1];
  v_gen := parts[2];
  v_rail := parts[3];
  v_land := parts[4];
  v_margin := parts[5];
  v_retained := parts[6];
  v_proxy := parts[7];
  v_wel := parts[8];
  v_tithe := CASE WHEN v_cash = v_collected THEN (q->>'tithe')::bigint ELSE v_wel / 10 END;
  INSERT INTO public.v360_daily_allocations (
    rent_request_id, paid_on, cash, partner_escrow, landlord_principal, rail, agent, welile,
    cycle_no, agent_sub, agent_general, cover_pool, proxy_agent, tithe, welile_net,
    economics_version, split_quality, created_by
  ) VALUES (
    r.id, p_paid_on, v_cash, v_margin, v_land, v_rail, v_sub + v_gen, v_wel,
    v_cycle, v_sub, v_gen, v_retained + v_proxy, v_proxy, v_tithe, v_wel - v_tithe,
    'v360-2026-11-02',
    CASE WHEN v_cash = v_collected THEN 'canonical' ELSE 'provisional' END,
    p_by
  );
  UPDATE public.rent_requests
     SET v360_paid_days = v360_paid_days + floor(v_cash / v360_daily_rate)::int
   WHERE id = r.id;

  SELECT coalesce(sum(a.cash), 0) INTO v_cycle_cash
  FROM public.v360_daily_allocations a
  WHERE a.rent_request_id = r.id AND a.cycle_no = v_cycle AND a.economics_version = 'v360-2026-11-02';
  IF v_cycle_cash >= v_collected THEN
    INSERT INTO public.v360_cycle_settlements (
      rent_request_id, cycle_no, principal, gross, daily, collected,
      agent_sub, agent_general, rail, landlord, partner_margin, cover_pool,
      proxy_calculated, proxy_agent, cover_pool_retained, welile, tithe, welile_net,
      proxy_onboarded_by, proxy_status
    )
    SELECT r.id, v_cycle,
      (q->>'principal')::numeric, (q->>'gross')::numeric, (q->>'daily')::numeric, (q->>'collected')::numeric,
      (q->>'agent_sub')::numeric, (q->>'agent_general')::numeric, (q->>'rail')::numeric,
      (q->>'landlord')::numeric, (q->>'partner_margin')::numeric, (q->>'cover_pool')::numeric,
      (q->>'proxy')::numeric,
      CASE WHEN v_cycle = 1 AND v_who IS NOT NULL THEN (q->>'proxy')::numeric ELSE 0 END,
      CASE WHEN v_cycle = 1 AND v_who IS NOT NULL THEN (q->>'cover_pool_retained')::numeric ELSE (q->>'cover_pool')::numeric END,
      (q->>'welile')::numeric, (q->>'tithe')::numeric, (q->>'welile_net')::numeric,
      CASE WHEN v_cycle = 1 THEN v_who ELSE NULL END,
      CASE
        WHEN v_cycle <> 1 THEN 'not_due'
        WHEN v_who IS NOT NULL THEN 'attributed'
        ELSE 'unattributed'
      END
    ON CONFLICT (rent_request_id, cycle_no) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'cycle', v_cycle, 'partner', v_margin, 'landlord', v_land, 'rail', v_rail,
    'agent', v_sub + v_gen, 'agent_sub', v_sub, 'agent_general', v_gen,
    'cover_pool', v_retained + v_proxy, 'proxy', v_proxy, 'welile', v_wel, 'tithe', v_tithe,
    'economics_version', 'v360-2026-11-02'
  );
END;
$$;

REVOKE ALL ON FUNCTION public._v360_waterfall_core(uuid, numeric, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._v360_waterfall_core(uuid, numeric, date, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.v360_plan_summary(p_rent_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.rent_requests;
  q jsonb;
BEGIN
  SELECT * INTO r FROM public.rent_requests WHERE id = p_rent_request_id;
  IF r.id IS NULL THEN RETURN NULL; END IF;
  IF NOT (
    (SELECT public._am_staff_ok())
    OR (SELECT auth.uid()) IN (r.tenant_id, r.agent_id, r.assigned_agent_id, r.landlord_id, r.supporter_id)
  ) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF r.pricing_version = 'v360' AND r.rent_amount > 0 THEN
    q := public.v360_cycle_waterfall(r.rent_amount, 1);
  END IF;
  RETURN jsonb_build_object(
    'pricing_version', r.pricing_version,
    'daily_rate', r.v360_daily_rate,
    'gross', r.v360_gross,
    'partner_monthly', CASE WHEN q IS NULL THEN round(r.rent_amount * 0.15) ELSE (q->>'partner_margin')::numeric END,
    'partner_12_months', CASE WHEN q IS NULL THEN round(r.rent_amount * 0.15) * 12 ELSE (q->>'partner_margin')::numeric * 12 END,
    'paid_days', r.v360_paid_days,
    'missed_days', r.v360_missed_days,
    'vacant_days', r.v360_vacant_days,
    'remaining_receivable', greatest(0, 360 - r.v360_paid_days) * coalesce(r.v360_daily_rate, 0),
    'maturity_on', public._v360_maturity(r),
    'buffer_drawn', (SELECT coalesce(sum(amount), 0) FROM public.v360_buffer_pool WHERE rent_request_id = r.id AND movement = 'draw'),
    'agent_sub', (q->>'agent_sub')::numeric,
    'agent_general', (q->>'agent_general')::numeric,
    'cover_pool', (q->>'cover_pool')::numeric,
    'proxy_agent', (q->>'proxy')::numeric,
    'welile', (q->>'welile')::numeric,
    'tithe', (q->>'tithe')::numeric,
    'welile_net', (q->>'welile_net')::numeric,
    'partner_returns_wording', 'target 15%, not guaranteed'
  );
END;
$$;

-- Day-30. Plans with a cycle settlement can draw only the retained Cover Pool.
-- Plans with no settlement keep the previous unlimited draw.
CREATE OR REPLACE FUNCTION public.v360_day30_settle(p_as_of date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
  v_as date := coalesce(p_as_of, (now() AT TIME ZONE 'Africa/Kampala')::date);
  v_cash numeric;
  v_used numeric;
  v_short numeric;
  v_draw numeric;
  v_room numeric;
  v_pool numeric;
  v_drawn numeric;
  v_economics boolean;
  v_n int := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (SELECT public._am_staff_ok()) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  FOR s IN
    SELECT sc.* FROM public.v360_schedules sc
    WHERE sc.status = 'scheduled' AND sc.due_on <= v_as
    ORDER BY sc.due_on, sc.kind DESC
    FOR UPDATE
  LOOP
    SELECT coalesce(sum(CASE WHEN s.kind = 'partner_returns' THEN partner_escrow ELSE landlord_principal END), 0)
      INTO v_cash
    FROM public.v360_daily_allocations WHERE rent_request_id = s.rent_request_id;
    SELECT coalesce(sum(amount - buffer_amount), 0) INTO v_used
    FROM public.v360_schedules
    WHERE rent_request_id = s.rent_request_id AND kind = s.kind AND status <> 'scheduled';
    v_short := greatest(0, s.amount - coalesce(s.buffer_amount, 0) - greatest(0, v_cash - v_used));
    SELECT EXISTS (
      SELECT 1 FROM public.v360_cycle_settlements cs WHERE cs.rent_request_id = s.rent_request_id
    ) INTO v_economics;
    IF v_economics THEN
      SELECT coalesce(sum(cover_pool_retained), 0) INTO v_pool
      FROM public.v360_cycle_settlements WHERE rent_request_id = s.rent_request_id;
      SELECT coalesce(sum(amount), 0) INTO v_drawn
      FROM public.v360_buffer_pool WHERE rent_request_id = s.rent_request_id AND movement = 'draw';
      v_room := greatest(0, v_pool - v_drawn);
      v_draw := least(v_short, v_room);
    ELSE
      v_draw := v_short;
    END IF;
    IF v_draw > 0 THEN
      INSERT INTO public.v360_buffer_pool (movement, amount, rent_request_id, schedule_id, note)
      VALUES (
        'draw', v_draw, s.rent_request_id, s.id,
        CASE WHEN v_economics THEN 'Cover Pool draw for ' ELSE 'Day-30 cover for ' END
          || s.kind || ' month ' || s.month_no
      );
    END IF;
    IF v_draw >= v_short THEN
      UPDATE public.v360_schedules
         SET status = CASE WHEN coalesce(s.buffer_amount, 0) + v_draw > 0 THEN 'covered_by_buffer' ELSE 'covered' END,
             buffer_amount = coalesce(s.buffer_amount, 0) + v_draw,
             updated_at = now()
       WHERE id = s.id;
    ELSIF v_draw > 0 THEN
      UPDATE public.v360_schedules
         SET buffer_amount = coalesce(s.buffer_amount, 0) + v_draw,
             updated_at = now()
       WHERE id = s.id;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'settled', v_n);
END;
$$;

-- Confirm the switch was not touched.
DO $after$
BEGIN
  IF coalesce((SELECT new_plans_enabled FROM public.v360_settings), false) THEN
    RAISE EXCEPTION 'new_plans_enabled flipped during this migration; aborting';
  END IF;
  IF (public.v360_cycle_waterfall(100000, 1)->>'gross')::numeric IS DISTINCT FROM 142772
     OR (public.v360_cycle_waterfall(100000, 1)->>'daily')::numeric IS DISTINCT FROM 4760
     OR (public.v360_cycle_waterfall(100000, 1)->>'agent_sub')::numeric IS DISTINCT FROM 8566
     OR (public.v360_cycle_waterfall(100000, 1)->>'agent_general')::numeric IS DISTINCT FROM 2855
     OR (public.v360_cycle_waterfall(100000, 1)->>'cover_pool')::numeric IS DISTINCT FROM 2885
     OR (public.v360_cycle_waterfall(100000, 1)->>'proxy')::numeric IS DISTINCT FROM 2000
     OR (public.v360_cycle_waterfall(100000, 1)->>'cover_pool_retained')::numeric IS DISTINCT FROM 885
     OR (public.v360_cycle_waterfall(100000, 1)->>'welile')::numeric IS DISTINCT FROM 9994
     OR (public.v360_cycle_waterfall(100000, 1)->>'tithe')::numeric IS DISTINCT FROM 999
     OR (public.v360_cycle_waterfall(100000, 1)->>'welile_net')::numeric IS DISTINCT FROM 8995
  THEN
    RAISE EXCEPTION 'P = 100,000 waterfall does not match the approved shillings';
  END IF;
END
$after$;
