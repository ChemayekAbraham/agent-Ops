-- Rent Plan renewal at any new rent and any allowed number of days, with server-computed ADVICE and a mandatory explanation.
--
-- Nothing here writes ledger or wallet state. Nothing edits a previous Rent Plan. Verified against the LIVE database first:
--   * days: rent_requests_duration_days_check = 30, 60, 90, 120, or any multiple of 7 from 7 to 364 (56 values). That rule is mirrored
--     exactly by _rent_days_allowed(); the test pins it to the live constraint text.
--   * pricing: the BEFORE INSERT trigger enforce_rent_request_formula calls compute_rent_repayment(rent, days) for every new request,
--     so renewals are priced by that one function; the preview and the advice use it too (no new maths).
--   * the existing per-tenant capacity guard (enforce_agent_rent_request_capacity: starter 500,000, building 1,500,000, reliable 3,000,000,
--     premium 6,000,000, small-agent floor 2,000,000) is a separate, older hard limit. It is NOT the advice and is untouched.
--
-- 1  _renewal_advice_params(): admin-tunable bands, step-up %, affordability multiplier, minimum explanation length (system_config).
-- 2  _rent_days_allowed(), rent_allowed_days(): the day counts a request may have.
-- 3  _rent_access_limit_calc / _rent_access_limit_params / _rent_access_limit_core / rent_access_limit_server(): the Rent Access Limit on the
--    server, reproducing src/lib/rentAccessLimit.ts (UTC days, same overrides). Parity test: supabase/tests/rent_access_limit_server.sql.
-- 4  _renewal_plan_stats, _renewal_band, _renewal_max_rent, _renewal_advice_core, get_renewal_advice, preview_renewal_amount: advice and preview.
-- 5  rent_requests: renewal_* columns (all nullable) and a guard that stops them being rewritten.
-- 6  renew_rent_request(): same behaviour for same rent and same days; any positive rent and any allowed days with an explanation.
-- 7  rent_request_review_notes + add_rent_request_review_note(): append-only reviewer notes.
-- 8  Reviewer read access: RLS on rent_requests for agent_ops, landlord_ops and super_admin; the Service Center queue RPC carries the renewal fields.
-- 9  Tenant OTP: rent_renewal_otps bound to the new rent AND days; rent_renewal_otp_context returns the new figures; the insert trigger enforces the binding.

-- 1. Config -------------------------------------------------------------------------------------------------------------------
INSERT INTO public.system_config (key, value)
SELECT 'rent_renewal_advice_params',
       '{
          "bands": [
            {"name": "A", "min_on_time_pct": 90, "require_fully_repaid": true,  "step_up_pct": 50},
            {"name": "B", "min_on_time_pct": 75, "require_fully_repaid": false, "step_up_pct": 25},
            {"name": "C", "min_on_time_pct": 60, "require_fully_repaid": false, "step_up_pct": 10},
            {"name": "D", "min_on_time_pct": 0,  "require_fully_repaid": false, "step_up_pct": 0}
          ],
          "affordability_multiplier": 1.3,
          "min_explanation_length": 10,
          "rounding_ugx": 10000
        }'::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM public.system_config WHERE key = 'rent_renewal_advice_params');

DROP POLICY IF EXISTS "Authenticated read rent_renewal_advice_params" ON public.system_config;
CREATE POLICY "Authenticated read rent_renewal_advice_params" ON public.system_config
  FOR SELECT TO authenticated USING (key = 'rent_renewal_advice_params');
DROP POLICY IF EXISTS "Executives update rent_renewal_advice_params" ON public.system_config;
CREATE POLICY "Executives update rent_renewal_advice_params" ON public.system_config
  FOR UPDATE TO authenticated
  USING (key = 'rent_renewal_advice_params' AND (has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)
                                                 OR has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role)))
  WITH CHECK (key = 'rent_renewal_advice_params' AND (has_role(auth.uid(), 'manager'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)
                                                      OR has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'ceo'::app_role)));

CREATE OR REPLACE FUNCTION public._renewal_advice_params()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  -- Stored values win, but only well-formed ones: a missing, empty, non-numeric or non-positive value (or a bands list that is not a
  -- non-empty array) is ignored and the shipped default applies, so a bad admin edit can never break a renewal.
  SELECT '{
            "bands": [
              {"name": "A", "min_on_time_pct": 90, "require_fully_repaid": true,  "step_up_pct": 50},
              {"name": "B", "min_on_time_pct": 75, "require_fully_repaid": false, "step_up_pct": 25},
              {"name": "C", "min_on_time_pct": 60, "require_fully_repaid": false, "step_up_pct": 10},
              {"name": "D", "min_on_time_pct": 0,  "require_fully_repaid": false, "step_up_pct": 0}
            ],
            "affordability_multiplier": 1.3,
            "min_explanation_length": 10,
            "rounding_ugx": 10000
          }'::jsonb
         || COALESCE((
              SELECT jsonb_object_agg(e.key, e.value)
                FROM public.system_config c, jsonb_each(CASE WHEN jsonb_typeof(c.value) = 'object' THEN c.value ELSE '{}'::jsonb END) e
               WHERE c.key = 'rent_renewal_advice_params'
                 AND CASE e.key
                       WHEN 'bands' THEN CASE WHEN jsonb_typeof(e.value) = 'array' THEN jsonb_array_length(e.value) > 0 ELSE false END
                       WHEN 'affordability_multiplier' THEN jsonb_typeof(e.value) IN ('number', 'string') AND (e.value #>> '{}') ~ '^[0-9]+(\.[0-9]+)?$' AND (e.value #>> '{}')::numeric > 0
                       WHEN 'min_explanation_length' THEN jsonb_typeof(e.value) IN ('number', 'string') AND (e.value #>> '{}') ~ '^[0-9]+$'
                       WHEN 'rounding_ugx' THEN jsonb_typeof(e.value) IN ('number', 'string') AND (e.value #>> '{}') ~ '^[0-9]+(\.[0-9]+)?$' AND (e.value #>> '{}')::numeric > 0
                       ELSE false END
            ), '{}'::jsonb);
$function$;

-- 2. Allowed day counts ---------------------------------------------------------------------------------------------------------
-- Mirrors rent_requests_duration_days_check exactly (without its NULL branch: a request always has days).
CREATE OR REPLACE FUNCTION public._rent_days_allowed(p_days integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $function$
  SELECT p_days IS NOT NULL
     AND (p_days = ANY (ARRAY[30, 60, 90, 120]) OR (p_days >= 7 AND p_days <= 364 AND (p_days % 7) = 0));
$function$;

CREATE OR REPLACE FUNCTION public.rent_allowed_days()
RETURNS integer[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $function$
  SELECT array_agg(d ORDER BY d) FROM generate_series(1, 400) AS d WHERE public._rent_days_allowed(d);
$function$;

-- 3. Rent Access Limit on the server ---------------------------------------------------------------------------------------------
-- The same formula as src/lib/rentAccessLimit.ts: limit = clamp(0, paid_days * increment - missed_days * decrement, max), where a paid day
-- is a distinct UTC calendar day with a payment above zero, and tracked days run from the first paid day to today, inclusive (at least 1
-- once there is a payment). Days are UTC, as in the TypeScript, so the two agree to the shilling.
CREATE OR REPLACE FUNCTION public._rent_access_limit_calc(
  p_payment_times timestamptz[],
  p_now timestamptz,
  p_inc numeric,
  p_dec numeric,
  p_max numeric
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $function$
DECLARE
  v_inc numeric := GREATEST(0, COALESCE(p_inc, 0));
  v_dec numeric := GREATEST(0, COALESCE(p_dec, 0));
  v_max numeric := GREATEST(0, COALESCE(p_max, 0));
  v_today date := (p_now AT TIME ZONE 'UTC')::date;
  v_paid integer;
  v_first date;
  v_tracked integer := 0;
  v_missed integer;
  v_limit numeric;
BEGIN
  SELECT count(DISTINCT (t AT TIME ZONE 'UTC')::date), min((t AT TIME ZONE 'UTC')::date)
    INTO v_paid, v_first
    FROM unnest(COALESCE(p_payment_times, ARRAY[]::timestamptz[])) AS t
   WHERE t IS NOT NULL;
  IF v_paid > 0 THEN
    v_tracked := GREATEST(1, (v_today - v_first) + 1);
  END IF;
  v_missed := GREATEST(0, v_tracked - v_paid);
  v_limit := GREATEST(0, LEAST(v_max, v_paid * v_inc - v_missed * v_dec));
  RETURN jsonb_build_object(
    'limit', v_limit, 'paid_days', v_paid, 'missed_days', v_missed, 'tracked_days', v_tracked,
    'paid_increment', v_inc, 'missed_decrement', v_dec, 'max_limit', v_max,
    'at_max', v_max > 0 AND v_limit >= v_max);
END;
$function$;

-- The admin-tunable parameters, resolved the way the client does: a missing, zero or non-numeric value falls back to the default, and a
-- negative value is clamped to 0 (src/hooks/useRentAccessLimitParams.ts then calculateRentAccessLimit).
CREATE OR REPLACE FUNCTION public._rent_access_limit_params()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH c AS (SELECT value AS v FROM public.system_config WHERE key = 'rent_access_limit_params'),
  p AS (
    SELECT
      CASE WHEN (v->>'paid_increment_ugx')   ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (v->>'paid_increment_ugx')::numeric   END AS inc,
      CASE WHEN (v->>'missed_decrement_ugx') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (v->>'missed_decrement_ugx')::numeric END AS dec,
      CASE WHEN (v->>'max_limit_ugx')        ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (v->>'max_limit_ugx')::numeric        END AS mx
      FROM c)
  SELECT jsonb_build_object(
    'paid_increment_ugx',   GREATEST(0, COALESCE(NULLIF((SELECT inc FROM p), 0), 10000)),
    'missed_decrement_ugx', GREATEST(0, COALESCE(NULLIF((SELECT dec FROM p), 0), 7000)),
    'max_limit_ugx',        GREATEST(0, COALESCE(NULLIF((SELECT mx  FROM p), 0), 30000000)));
$function$;

-- Ungated core: one tenant, one moment. Payments are the tenant's non-reversed collections plus any repayments row with no matching
-- collection (same amount on the same plan within 5 minutes), the same "paid" notion the shared payout clock uses.
CREATE OR REPLACE FUNCTION public._rent_access_limit_core(p_tenant uuid, p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_params jsonb := public._rent_access_limit_params();
  v_times timestamptz[];
BEGIN
  SELECT COALESCE(array_agg(x.t), ARRAY[]::timestamptz[]) INTO v_times
    FROM (
      SELECT ac.created_at AS t
        FROM public.agent_collections ac
       WHERE ac.tenant_id = p_tenant AND ac.reversed_at IS NULL AND COALESCE(ac.amount, 0) > 0
      UNION ALL
      SELECT rp.created_at
        FROM public.repayments rp
       WHERE rp.tenant_id = p_tenant AND COALESCE(rp.amount, 0) > 0
         AND NOT EXISTS (SELECT 1 FROM public.agent_collections ac
                          WHERE ac.rent_request_id = rp.rent_request_id AND ac.reversed_at IS NULL
                            AND COALESCE(ac.amount, 0) = COALESCE(rp.amount, 0)
                            AND abs(extract(epoch FROM (ac.created_at - rp.created_at))) < 300)
    ) x;
  RETURN public._rent_access_limit_calc(v_times, p_now,
           (v_params->>'paid_increment_ugx')::numeric, (v_params->>'missed_decrement_ugx')::numeric, (v_params->>'max_limit_ugx')::numeric)
         || jsonb_build_object('tenant_id', p_tenant, 'computed_at', p_now);
END;
$function$;

-- Gated: the tenant, an agent or reviewer who may renew one of the tenant's plans, or ops/manager/super_admin (_can_renew_rent_request).
CREATE OR REPLACE FUNCTION public.rent_access_limit_server(p_tenant uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501'; END IF;
  IF p_tenant IS NULL THEN RAISE EXCEPTION 'TENANT_REQUIRED' USING ERRCODE = '22023'; END IF;
  IF v_actor <> p_tenant
     AND NOT EXISTS (SELECT 1 FROM public.rent_requests r WHERE r.tenant_id = p_tenant AND public._can_renew_rent_request(r, v_actor)) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  RETURN public._rent_access_limit_core(p_tenant, now());
END;
$function$;

-- 4. Advice and preview -----------------------------------------------------------------------------------------------------------
-- What the previous Rent Plan says about the tenant, in Kampala days. A due period is a day (daily plans) or a week (weekly plans) from the
-- plan's payout clock; it is on time when everything due up to its due date had been paid by that date (the payment score's strict rule),
-- and missed when nothing at all was paid in it. Only periods that have ended count as missed.
CREATE OR REPLACE FUNCTION public._renewal_plan_stats(p_rid uuid, p_as_at date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  rr public.rent_requests%ROWTYPE;
  a record;
  v_cs date;
  v_step integer := 1;
  v_period numeric := 0;
  v_total numeric := 0;
  v_n integer := 0;
  v_due integer := 0;
  v_ok integer := 0;
  v_streak integer := 0;
  v_paid_total numeric := 0;
  v_first_pay date;
  v_last_pay date;
  v_end date;
  v_days integer;
  v_fully boolean;
  v_pdays date[];
  v_pamts numeric[];
BEGIN
  SELECT * INTO rr FROM public.rent_requests WHERE id = p_rid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO a FROM public._am_plan_arrears_core(ARRAY[p_rid], p_as_at);
  v_cs := a.clock_start;
  v_step := CASE WHEN a.cadence = 'weekly' THEN 7 ELSE 1 END;
  v_total := COALESCE(rr.total_repayment, 0);
  v_period := COALESCE(rr.daily_repayment, 0) * v_step;

  SELECT COALESCE(array_agg(g.day ORDER BY g.day), ARRAY[]::date[]), COALESCE(array_agg(g.amt ORDER BY g.day), ARRAY[]::numeric[])
    INTO v_pdays, v_pamts
    FROM (
      SELECT x.day, sum(x.amount) AS amt
        FROM (
          SELECT (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day, ac.amount
            FROM public.agent_collections ac
           WHERE ac.rent_request_id = p_rid AND ac.reversed_at IS NULL AND COALESCE(ac.amount, 0) > 0
          UNION ALL
          SELECT (rp.created_at AT TIME ZONE 'Africa/Kampala')::date, rp.amount
            FROM public.repayments rp
           WHERE rp.rent_request_id = p_rid AND COALESCE(rp.amount, 0) > 0
             AND NOT EXISTS (SELECT 1 FROM public.agent_collections ac
                              WHERE ac.rent_request_id = rp.rent_request_id AND ac.reversed_at IS NULL
                                AND COALESCE(ac.amount, 0) = COALESCE(rp.amount, 0)
                                AND abs(extract(epoch FROM (ac.created_at - rp.created_at))) < 300)
        ) x
       WHERE x.day <= p_as_at
       GROUP BY x.day
    ) g;

  SELECT COALESCE(sum(t.amt), 0), min(t.day), max(t.day) INTO v_paid_total, v_first_pay, v_last_pay FROM unnest(v_pdays, v_pamts) AS t(day, amt);

  IF v_cs IS NOT NULL AND v_period > 0 AND p_as_at > v_cs THEN
    v_n := LEAST(ceil(v_total / v_period)::int, ((p_as_at - v_cs - 1) / v_step) + 1);
  END IF;

  IF v_n > 0 THEN
    WITH due AS (
      SELECT k, v_cs + (k - 1) * v_step AS d, LEAST(v_total, v_period * k) AS cum_due
        FROM generate_series(1, v_n) AS k
    ), per AS (
      SELECT due.k, due.d, due.cum_due,
             COALESCE((SELECT sum(p.amt) FROM unnest(v_pdays, v_pamts) AS p(day, amt) WHERE p.day <= due.d), 0) AS cum_paid,
             COALESCE((SELECT sum(p.amt) FROM unnest(v_pdays, v_pamts) AS p(day, amt) WHERE p.day >= due.d AND p.day < due.d + v_step), 0) AS in_period
        FROM due
    ), isl AS (
      SELECT k, k - row_number() OVER (ORDER BY k) AS g
        FROM per
       WHERE in_period = 0 AND d + (v_step - 1) < p_as_at
    )
    SELECT (SELECT count(*) FROM per),
           (SELECT count(*) FROM per WHERE cum_paid >= cum_due),
           COALESCE((SELECT max(c) FROM (SELECT count(*) AS c FROM isl GROUP BY g) q), 0)
      INTO v_due, v_ok, v_streak;
  END IF;

  v_fully := rr.status IN ('completed', 'fully_repaid')
          OR (v_total > 0 AND COALESCE(rr.amount_repaid, 0) >= v_total)
          OR (v_total > 0 AND v_paid_total >= v_total);
  v_end := CASE WHEN v_fully THEN COALESCE(v_last_pay, p_as_at) ELSE p_as_at END;
  v_days := GREATEST(1, v_end - COALESCE(v_cs, v_first_pay, v_end) + 1);

  RETURN jsonb_build_object(
    'clock_start', v_cs,
    'unit', CASE WHEN v_step = 7 THEN 'weeks' ELSE 'days' END,
    'due_periods', v_due,
    'on_time_periods', v_ok,
    'on_time_pct', CASE WHEN v_due > 0 THEN round(100.0 * v_ok / v_due, 1) END,
    'longest_missed_streak', v_streak,
    'total_paid', v_paid_total,
    'tracked_days', v_days,
    'avg_daily_paid', CASE WHEN v_paid_total > 0 THEN round(v_paid_total / v_days, 2) ELSE 0 END,
    'fully_repaid', v_fully);
END;
$function$;

-- The band a tenant falls in, from the configured bands: the first band (highest threshold first) whose on-time threshold is met and, where
-- it asks for it, the plan was fully repaid. With the shipped bands, 90% or more but not fully repaid lands in the 75% band.
CREATE OR REPLACE FUNCTION public._renewal_band(p_on_time_pct numeric, p_fully_repaid boolean, p_params jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $function$
DECLARE
  v_default jsonb := '[
    {"name": "A", "min_on_time_pct": 90, "require_fully_repaid": true,  "step_up_pct": 50},
    {"name": "B", "min_on_time_pct": 75, "require_fully_repaid": false, "step_up_pct": 25},
    {"name": "C", "min_on_time_pct": 60, "require_fully_repaid": false, "step_up_pct": 10},
    {"name": "D", "min_on_time_pct": 0,  "require_fully_repaid": false, "step_up_pct": 0}]'::jsonb;
  v_bands jsonb := p_params->'bands';
  v_pct numeric := COALESCE(p_on_time_pct, 0);
  b jsonb;
  v_valid boolean := false;
  v_pass integer;
BEGIN
  -- two passes: the configured bands (well-formed ones only), then the shipped defaults if none of them is usable
  FOR v_pass IN 1..2 LOOP
    IF v_pass = 2 OR jsonb_typeof(v_bands) IS DISTINCT FROM 'array' THEN v_bands := v_default; END IF;
    FOR b IN
      SELECT x FROM jsonb_array_elements(v_bands) x
       WHERE jsonb_typeof(x) = 'object'
         AND (x->>'min_on_time_pct') ~ '^-?[0-9]+(\.[0-9]+)?$' AND (x->>'step_up_pct') ~ '^-?[0-9]+(\.[0-9]+)?$'
       ORDER BY (x->>'min_on_time_pct')::numeric DESC, COALESCE((x->>'require_fully_repaid') = 'true', false) DESC
    LOOP
      v_valid := true;
      IF v_pct >= (b->>'min_on_time_pct')::numeric
         AND (NOT COALESCE((b->>'require_fully_repaid') = 'true', false) OR COALESCE(p_fully_repaid, false)) THEN
        RETURN jsonb_build_object('name', COALESCE(b->>'name', '?'), 'step_pct', GREATEST(0, (b->>'step_up_pct')::numeric));
      END IF;
    END LOOP;
    EXIT WHEN v_valid;
  END LOOP;
  RETURN jsonb_build_object('name', 'none', 'step_pct', 0);
END;
$function$;

-- The largest whole-shilling rent whose total repayment (and, when given, daily payment) for these days stays within the caps, using the
-- existing pricing function. Both are non-decreasing in rent, so a binary search is exact. Rounded down to the configured step.
CREATE OR REPLACE FUNCTION public._renewal_max_rent(p_days integer, p_cap_total numeric, p_cap_daily numeric, p_round numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $function$
DECLARE
  lo bigint := 0;
  hi bigint := 1000000000;
  mid bigint;
  c record;
  v_round numeric := GREATEST(1, COALESCE(p_round, 1));
BEGIN
  WHILE lo < hi LOOP
    mid := (lo + hi + 1) / 2;
    SELECT * INTO c FROM public.compute_rent_repayment(mid::numeric, p_days);
    IF (p_cap_total IS NULL OR c.total_repayment <= p_cap_total) AND (p_cap_daily IS NULL OR c.daily_repayment <= p_cap_daily) THEN
      lo := mid;
    ELSE
      hi := mid - 1;
    END IF;
  END LOOP;
  RETURN floor(lo / v_round) * v_round;
END;
$function$;

-- The advice itself, for a previous plan and a chosen number of days. Ungated: the callers gate.
CREATE OR REPLACE FUNCTION public._renewal_advice_core(p_prev public.rent_requests, p_new_days integer, p_as_at date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_params jsonb := public._renewal_advice_params();
  v_days integer := COALESCE(p_new_days, p_prev.duration_days);
  v_round numeric := COALESCE((v_params->>'rounding_ugx')::numeric, 10000);
  v_mult numeric := COALESCE((v_params->>'affordability_multiplier')::numeric, 1.3);
  v_stats jsonb := public._renewal_plan_stats(p_prev.id, p_as_at);
  v_pct numeric := (v_stats->>'on_time_pct')::numeric;
  v_fully boolean := COALESCE((v_stats->>'fully_repaid')::boolean, false);
  v_avg numeric := COALESCE((v_stats->>'avg_daily_paid')::numeric, 0);
  v_unit text := COALESCE(v_stats->>'unit', 'days');
  v_band jsonb := public._renewal_band(v_pct, v_fully, v_params);
  v_step numeric := (v_band->>'step_pct')::numeric;
  v_limit numeric := COALESCE((public._rent_access_limit_core(p_prev.tenant_id, now())->>'limit')::numeric, 0);
  v_cur numeric := COALESCE(p_prev.rent_amount, 0);
  v_step_rent numeric;
  v_afford numeric;
  v_limit_rent numeric;
  v_suggested numeric;
  v_fmt text := 'FM999,999,999,999';
  v_reasons text[] := ARRAY[]::text[];
BEGIN
  v_step_rent := floor(v_cur * (1 + v_step / 100.0) / v_round) * v_round;
  v_afford := CASE WHEN v_avg > 0 THEN public._renewal_max_rent(v_days, NULL, ceil(v_avg * v_mult), v_round) ELSE 0 END;
  v_limit_rent := CASE WHEN v_limit > 0 THEN public._renewal_max_rent(v_days, v_limit, NULL, v_round) ELSE 0 END;
  v_suggested := GREATEST(v_cur, LEAST(v_step_rent, v_afford, v_limit_rent));

  IF v_pct IS NULL THEN
    v_reasons := v_reasons || 'No due ' || v_unit || ' have passed on the previous Rent Plan yet, so there is no on-time record to judge.';
  ELSE
    v_reasons := v_reasons || format('%s%% of due %s were paid on time, and the previous Rent Plan %s.',
      round(v_pct)::int, v_unit, CASE WHEN v_fully THEN 'was fully repaid' ELSE 'is not fully repaid' END);
  END IF;
  v_reasons := v_reasons || format('That is band %s: a step-up of %s%% on the current rent of UGX %s.',
    v_band->>'name', v_step::text, to_char(v_cur, v_fmt));
  IF COALESCE((v_stats->>'longest_missed_streak')::int, 0) > 0 THEN
    v_reasons := v_reasons || format('The longest run of missed %s was %s.', v_unit, v_stats->>'longest_missed_streak');
  END IF;
  IF v_avg > 0 THEN
    v_reasons := v_reasons || format('Payments averaged UGX %s a day. With a %sx allowance, UGX %s a day is affordable, which supports rent up to UGX %s over %s days.',
      to_char(round(v_avg), v_fmt), v_mult::text, to_char(ceil(v_avg * v_mult), v_fmt), to_char(v_afford, v_fmt), v_days);
  ELSE
    v_reasons := v_reasons || 'No payments are recorded on the previous Rent Plan, so affordability cannot be shown and the suggestion stays at the current rent.'::text;
  END IF;
  v_reasons := v_reasons || format('The Rent Access Limit is UGX %s, which fits rent up to UGX %s over %s days.',
    to_char(v_limit, v_fmt), to_char(v_limit_rent, v_fmt), v_days);
  v_reasons := v_reasons || format('Suggested maximum rent for %s days: UGX %s. This is advice only: any amount can be requested with an explanation.',
    v_days, to_char(v_suggested, v_fmt));

  RETURN jsonb_build_object(
    'prev_request_id', p_prev.id,
    'tenant_id', p_prev.tenant_id,
    'current_days', p_prev.duration_days,
    'chosen_days', v_days,
    'allowed_days', to_jsonb(public.rent_allowed_days()),
    'current_rent', v_cur,
    'on_time_pct', v_pct,
    'fully_repaid', v_fully,
    'longest_missed_streak', COALESCE((v_stats->>'longest_missed_streak')::int, 0),
    'missed_streak_unit', v_unit,
    'band', v_band->>'name',
    'suggested_step_pct', v_step,
    'avg_daily_paid', v_avg,
    'affordability_multiplier', v_mult,
    'affordability_rent', v_afford,
    'access_limit', v_limit,
    'access_limit_rent', v_limit_rent,
    'step_up_rent', v_step_rent,
    'suggested_max_rent', v_suggested,
    'reasons', to_jsonb(v_reasons),
    'computed_at', now());
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_renewal_advice(p_prev_request_id uuid, p_new_days integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_prev public.rent_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT * INTO v_prev FROM public.rent_requests WHERE id = p_prev_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PREVIOUS_REQUEST_NOT_FOUND'; END IF;
  IF NOT public._can_renew_rent_request(v_prev, v_actor) THEN RAISE EXCEPTION 'NOT_YOUR_REQUEST'; END IF;
  IF p_new_days IS NOT NULL AND NOT public._rent_days_allowed(p_new_days) THEN
    RAISE EXCEPTION 'RENEWAL_DAYS_NOT_ALLOWED: % days is not an allowed plan length (30, 60, 90, 120, or a multiple of 7 from 7 to 364)', p_new_days
      USING ERRCODE = '22023';
  END IF;
  RETURN public._renewal_advice_core(v_prev, p_new_days, (now() AT TIME ZONE 'Africa/Kampala')::date);
END;
$function$;

-- Read-only: the fees, total and daily payment the server will apply for a rent and a number of days.
CREATE OR REPLACE FUNCTION public.preview_renewal_amount(p_prev_request_id uuid, p_new_rent numeric, p_new_days integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_prev public.rent_requests%ROWTYPE;
  v_days integer;
  c record;
  p record;
  v_min integer := COALESCE((public._renewal_advice_params()->>'min_explanation_length')::int, 10);
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT * INTO v_prev FROM public.rent_requests WHERE id = p_prev_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PREVIOUS_REQUEST_NOT_FOUND'; END IF;
  IF NOT public._can_renew_rent_request(v_prev, v_actor) THEN RAISE EXCEPTION 'NOT_YOUR_REQUEST'; END IF;
  v_days := COALESCE(p_new_days, v_prev.duration_days);
  IF NOT public._rent_days_allowed(v_days) THEN
    RAISE EXCEPTION 'RENEWAL_DAYS_NOT_ALLOWED: % days is not an allowed plan length (30, 60, 90, 120, or a multiple of 7 from 7 to 364)', v_days
      USING ERRCODE = '22023';
  END IF;
  IF p_new_rent IS NULL OR p_new_rent <= 0 THEN
    RAISE EXCEPTION 'RENEWAL_AMOUNT_INVALID: the new rent must be more than UGX 0' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM public.compute_rent_repayment(p_new_rent, v_days);
  SELECT * INTO p FROM public.compute_rent_repayment(v_prev.rent_amount, v_prev.duration_days);
  RETURN jsonb_build_object(
    'prev_request_id', v_prev.id,
    'current_rent', v_prev.rent_amount, 'current_days', v_prev.duration_days,
    'new_rent', p_new_rent, 'new_days', v_days,
    'access_fee', c.access_fee, 'request_fee', c.request_fee,
    'total_repayment', c.total_repayment, 'daily_repayment', c.daily_repayment,
    'repayment_frequency', CASE WHEN public.rent_request_is_weekly_shape(v_days, 'renewal') THEN 'weekly' ELSE 'daily' END,
    'previous', jsonb_build_object('access_fee', p.access_fee, 'request_fee', p.request_fee,
                                   'total_repayment', p.total_repayment, 'daily_repayment', p.daily_repayment),
    'changed', (p_new_rent IS DISTINCT FROM v_prev.rent_amount) OR (v_days IS DISTINCT FROM v_prev.duration_days),
    'explanation_required', (p_new_rent IS DISTINCT FROM v_prev.rent_amount) OR (v_days IS DISTINCT FROM v_prev.duration_days),
    'min_explanation_length', v_min,
    'reason_codes', jsonb_build_array('landlord_raised', 'moved_house', 'tenant_requested_lower', 'other'));
END;
$function$;

-- 5. Renewal columns on the NEW request ------------------------------------------------------------------------------------------------
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS renewal_previous_rent numeric,
  ADD COLUMN IF NOT EXISTS renewal_previous_days integer,
  ADD COLUMN IF NOT EXISTS renewal_advice_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS renewal_above_suggestion boolean,
  ADD COLUMN IF NOT EXISTS renewal_above_by numeric,
  ADD COLUMN IF NOT EXISTS renewal_change_reason_code text,
  ADD COLUMN IF NOT EXISTS renewal_change_explanation text,
  ADD COLUMN IF NOT EXISTS renewal_evidence_url text;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.rent_requests'::regclass AND conname = 'rent_requests_renewal_reason_check') THEN
    ALTER TABLE public.rent_requests ADD CONSTRAINT rent_requests_renewal_reason_check
      CHECK (renewal_change_reason_code IS NULL
             OR renewal_change_reason_code IN ('landlord_raised', 'moved_house', 'tenant_requested_lower', 'other'));
  END IF;
END
$c$;

COMMENT ON COLUMN public.rent_requests.renewal_advice_snapshot IS
  'ADVICE only, computed by the server when the renewal was made (get_renewal_advice). Never a limit. Set once, never rewritten.';

-- The advice and the explanation are a record of what was known and said at renewal time: they are written once.
CREATE OR REPLACE FUNCTION public._guard_renewal_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  RAISE EXCEPTION 'The renewal advice, reason and explanation on a Rent Plan are written once and cannot be changed' USING ERRCODE = '42501';
END;
$function$;
DROP TRIGGER IF EXISTS trg_guard_renewal_columns ON public.rent_requests;
CREATE TRIGGER trg_guard_renewal_columns
  BEFORE UPDATE ON public.rent_requests
  FOR EACH ROW
  WHEN (OLD.renewal_previous_rent IS DISTINCT FROM NEW.renewal_previous_rent
     OR OLD.renewal_previous_days IS DISTINCT FROM NEW.renewal_previous_days
     OR OLD.renewal_advice_snapshot IS DISTINCT FROM NEW.renewal_advice_snapshot
     OR OLD.renewal_above_suggestion IS DISTINCT FROM NEW.renewal_above_suggestion
     OR OLD.renewal_above_by IS DISTINCT FROM NEW.renewal_above_by
     OR OLD.renewal_change_reason_code IS DISTINCT FROM NEW.renewal_change_reason_code
     OR OLD.renewal_change_explanation IS DISTINCT FROM NEW.renewal_change_explanation
     OR OLD.renewal_evidence_url IS DISTINCT FROM NEW.renewal_evidence_url)
  EXECUTE FUNCTION public._guard_renewal_columns();

-- 6. renew_rent_request ----------------------------------------------------------------------------------------------------------------
-- The old three-argument signature is replaced by one with five optional extras (a second overload would make every existing call
-- ambiguous). Calls with the old arguments behave exactly as before: same rent, same days, no renewal_* columns set.
DROP FUNCTION IF EXISTS public.renew_rent_request(uuid, numeric, numeric);

CREATE OR REPLACE FUNCTION public.renew_rent_request(
  p_prev_request_id uuid,
  p_latitude numeric DEFAULT NULL,
  p_longitude numeric DEFAULT NULL,
  p_new_rent_amount numeric DEFAULT NULL,
  p_new_days integer DEFAULT NULL,
  p_change_reason_code text DEFAULT NULL,
  p_change_explanation text DEFAULT NULL,
  p_evidence_url text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_agent uuid := auth.uid();
  v_prev  public.rent_requests%ROWTYPE;
  v_new_id uuid;
  v_photo text;
  v_lat numeric;
  v_lng numeric;
  v_allowed boolean := false;
  v_fresh_gps boolean := false;
  v_rent numeric;
  v_days integer;
  v_changed boolean;
  v_params jsonb;
  v_min integer;
  v_explanation text := NULLIF(btrim(COALESCE(p_change_explanation, '')), '');
  v_advice jsonb;
  v_suggested numeric;
  v_above boolean;
  v_above_by numeric;
  v_new public.rent_requests%ROWTYPE;
  v_fields text[] := ARRAY[]::text[];
  v_trust text := 'not_applicable';
BEGIN
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;
  SELECT * INTO v_prev FROM public.rent_requests WHERE id = p_prev_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PREVIOUS_REQUEST_NOT_FOUND'; END IF;

  -- Who may renew: the agent who currently manages the tenant (assigned agent wins
  -- after a transfer), the agent who filed it, the manager of any of the tenant's
  -- plans, either side of a verified parent/sub-agent link, or ops/admin staff.
  v_allowed := (COALESCE(v_prev.assigned_agent_id, v_prev.agent_id) = v_agent)
            OR (v_prev.agent_id = v_agent);

  IF NOT v_allowed THEN
    SELECT true INTO v_allowed
    FROM public.rent_requests r
    WHERE r.tenant_id = v_prev.tenant_id
      AND (r.agent_id = v_agent OR r.assigned_agent_id = v_agent)
    LIMIT 1;
  END IF;

  IF NOT v_allowed THEN
    SELECT true INTO v_allowed
    FROM public.agent_subagents s
    WHERE s.status = 'verified'
      AND (
        (s.parent_agent_id = v_agent AND s.sub_agent_id IN (v_prev.agent_id, v_prev.assigned_agent_id))
        OR (s.sub_agent_id = v_agent AND s.parent_agent_id IN (v_prev.agent_id, v_prev.assigned_agent_id))
      )
    LIMIT 1;
  END IF;

  IF NOT v_allowed THEN
    v_allowed := public.has_role(v_agent, 'agent_ops')
      OR public.has_role(v_agent, 'tenant_ops')
      OR public.has_role(v_agent, 'operations')
      OR public.has_role(v_agent, 'manager')
      OR public.has_role(v_agent, 'super_admin');
  END IF;

  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'NOT_YOUR_REQUEST: this tenant is handled by another agent — ask Agent Ops to transfer the tenant to you before renewing';
  END IF;

  IF v_prev.landlord_id IS NULL THEN RAISE EXCEPTION 'LANDLORD_MISSING'; END IF;

  -- The new rent and days. NULL means "as before". Any positive rent is allowed; the days must be one the system already allows.
  v_rent := COALESCE(p_new_rent_amount, v_prev.rent_amount);
  v_days := COALESCE(p_new_days, v_prev.duration_days);
  IF v_rent IS NULL OR v_rent <= 0 THEN
    RAISE EXCEPTION 'RENEWAL_AMOUNT_INVALID: the new rent must be more than UGX 0' USING ERRCODE = '22023';
  END IF;
  IF p_new_days IS NOT NULL AND NOT public._rent_days_allowed(v_days) THEN
    RAISE EXCEPTION 'RENEWAL_DAYS_NOT_ALLOWED: % days is not an allowed plan length (30, 60, 90, 120, or a multiple of 7 from 7 to 364)', v_days
      USING ERRCODE = '22023';
  END IF;
  v_changed := (v_rent IS DISTINCT FROM v_prev.rent_amount) OR (v_days IS DISTINCT FROM v_prev.duration_days);

  IF v_changed THEN
    v_params := public._renewal_advice_params();
    v_min := COALESCE((v_params->>'min_explanation_length')::int, 10);
    IF p_change_reason_code IS NULL
       OR p_change_reason_code NOT IN ('landlord_raised', 'moved_house', 'tenant_requested_lower', 'other')
       OR v_explanation IS NULL OR char_length(v_explanation) < v_min THEN
      RAISE EXCEPTION 'RENEWAL_EXPLANATION_REQUIRED: changing the rent or the number of days needs a reason (landlord_raised, moved_house, tenant_requested_lower or other) and an explanation of at least % characters', v_min
        USING ERRCODE = '23514';
    END IF;
    -- recomputed here, never taken from the client
    v_advice := public._renewal_advice_core(v_prev, v_days, (now() AT TIME ZONE 'Africa/Kampala')::date);
    v_suggested := (v_advice->>'suggested_max_rent')::numeric;
    v_above := v_rent > v_suggested;
    v_above_by := GREATEST(0, v_rent - v_suggested);
  END IF;

  IF p_latitude IS NOT NULL AND p_longitude IS NOT NULL THEN
    IF p_latitude < -1.6 OR p_latitude > 4.3 OR p_longitude < 29.4 OR p_longitude > 35.1 THEN
      RAISE EXCEPTION 'RENT_REQUEST_GPS_OUT_OF_RANGE: the captured GPS (%, %) is not inside Uganda — recapture it at the house',
        p_latitude, p_longitude USING ERRCODE = '23514';
    END IF;
    v_lat := p_latitude;
    v_lng := p_longitude;
    v_fresh_gps := true;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    v_lat := v_prev.request_latitude;
    v_lng := v_prev.request_longitude;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    SELECT r.request_latitude, r.request_longitude
      INTO v_lat, v_lng
    FROM public.rent_requests r
    WHERE r.tenant_id = v_prev.tenant_id
      AND r.request_latitude IS NOT NULL
      AND r.request_longitude IS NOT NULL
    ORDER BY r.created_at DESC
    LIMIT 1;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    SELECT h.latitude, h.longitude
      INTO v_lat, v_lng
    FROM public.house_listings h
    WHERE (h.tenant_id = v_prev.tenant_id OR h.suspended_tenant_id = v_prev.tenant_id)
      AND h.latitude IS NOT NULL
      AND h.longitude IS NOT NULL
    ORDER BY h.created_at DESC
    LIMIT 1;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    SELECT h.latitude, h.longitude
      INTO v_lat, v_lng
    FROM public.house_listings h
    WHERE h.landlord_id = v_prev.landlord_id
      AND h.latitude IS NOT NULL
      AND h.longitude IS NOT NULL
    ORDER BY h.created_at DESC
    LIMIT 1;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    SELECT l.latitude, l.longitude
      INTO v_lat, v_lng
    FROM public.landlords l
    WHERE l.id = v_prev.landlord_id;
  END IF;

  IF v_lat IS NULL OR v_lng IS NULL THEN
    RAISE EXCEPTION 'GPS_REQUIRED: no property GPS on record for this tenant — capture the GPS at the house to renew';
  END IF;

  SELECT tenant_photo_url INTO v_photo
  FROM public.rent_requests
  WHERE tenant_id = v_prev.tenant_id
    AND tenant_photo_url IS NOT NULL
    AND btrim(tenant_photo_url) <> ''
  ORDER BY created_at DESC
  LIMIT 1;

  PERFORM set_config('app.bypass_daily_eligibility', 'true', true);

  -- Fees, total and daily payment are recomputed from the new rent and days by the existing pricing trigger
  -- (enforce_rent_request_formula -> compute_rent_repayment), exactly as for every new request.
  INSERT INTO public.rent_requests (
    tenant_id, agent_id, landlord_id, lc1_id,
    rent_amount, duration_days,
    access_fee, request_fee, total_repayment, daily_repayment,
    status, house_category, tenant_no_smartphone,
    request_latitude, request_longitude,
    tenant_photo_url, registration_type,
    agent_guarantor_consent, agent_guarantor_consent_at, agent_guarantor_consent_version,
    renewal_previous_rent, renewal_previous_days, renewal_advice_snapshot,
    renewal_above_suggestion, renewal_above_by,
    renewal_change_reason_code, renewal_change_explanation, renewal_evidence_url
  ) VALUES (
    v_prev.tenant_id, v_agent, v_prev.landlord_id, v_prev.lc1_id,
    v_rent, v_days,
    0, 0, 0, 0,
    'pending', v_prev.house_category, COALESCE(v_prev.tenant_no_smartphone, false),
    v_lat, v_lng,
    v_photo, 'renewal',
    true, now(), 'v1',
    CASE WHEN v_changed THEN v_prev.rent_amount END,
    CASE WHEN v_changed THEN v_prev.duration_days END,
    CASE WHEN v_changed THEN v_advice END,
    CASE WHEN v_changed THEN v_above END,
    CASE WHEN v_changed THEN v_above_by END,
    CASE WHEN v_changed THEN p_change_reason_code END,
    CASE WHEN v_changed THEN v_explanation END,
    CASE WHEN v_changed THEN NULLIF(btrim(COALESCE(p_evidence_url, '')), '') END
  )
  RETURNING id INTO v_new_id;

  IF v_changed THEN
    SELECT * INTO v_new FROM public.rent_requests WHERE id = v_new_id;

    IF v_new.rent_amount IS DISTINCT FROM v_prev.rent_amount THEN v_fields := v_fields || 'rent_amount'::text; END IF;
    IF v_new.duration_days IS DISTINCT FROM v_prev.duration_days THEN v_fields := v_fields || 'duration_days'::text; END IF;
    IF v_new.access_fee IS DISTINCT FROM v_prev.access_fee THEN v_fields := v_fields || 'access_fee'::text; END IF;
    IF v_new.request_fee IS DISTINCT FROM v_prev.request_fee THEN v_fields := v_fields || 'request_fee'::text; END IF;
    IF v_new.total_repayment IS DISTINCT FROM v_prev.total_repayment THEN v_fields := v_fields || 'total_repayment'::text; END IF;
    IF v_new.daily_repayment IS DISTINCT FROM v_prev.daily_repayment THEN v_fields := v_fields || 'daily_repayment'::text; END IF;

    -- the log row belongs to the NEW request; the previous plan's figures are its "old" side
    INSERT INTO public.rent_amount_change_log (
      rent_request_id, tenant_id, agent_id,
      old_rent_amount, new_rent_amount, old_total_repayment, new_total_repayment,
      old_amount_repaid, new_amount_repaid, old_duration_days, new_duration_days,
      old_access_fee, new_access_fee, old_request_fee, new_request_fee,
      old_daily_repayment, new_daily_repayment, changed_fields, status, changed_by, source
    ) VALUES (
      v_new_id, v_prev.tenant_id, v_agent,
      v_prev.rent_amount, v_new.rent_amount, v_prev.total_repayment, v_new.total_repayment,
      v_prev.amount_repaid, v_new.amount_repaid, v_prev.duration_days, v_new.duration_days,
      v_prev.access_fee, v_new.access_fee, v_prev.request_fee, v_new.request_fee,
      v_prev.daily_repayment, v_new.daily_repayment, v_fields, v_new.status, v_agent, 'agent_renewal_edit'
    );

    -- A trust signal is a visit at the house: only recorded when the agent captured fresh GPS for this renewal.
    IF v_fresh_gps THEN
      BEGIN
        PERFORM public.capture_trust_signal(v_prev.tenant_id, 'rent_renewal_amount_change', 'residence', 'Rent Plan renewal',
                                            v_lat::double precision, v_lng::double precision, NULL,
                                            'Renewal with a changed rent or number of days');
        v_trust := 'captured';
      EXCEPTION WHEN OTHERS THEN
        v_trust := 'failed';
      END;
    ELSE
      v_trust := 'skipped_no_fresh_gps';
    END IF;

    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, actor_id, metadata)
    VALUES (
      'rent_request.renewed_with_new_amount', v_prev.tenant_id, 'rent_request', v_new_id, v_agent,
      jsonb_build_object(
        'rent_request_id', v_new_id,
        'previous_request_id', v_prev.id,
        'previous_rent', v_prev.rent_amount, 'new_rent', v_new.rent_amount,
        'previous_days', v_prev.duration_days, 'new_days', v_new.duration_days,
        'rent_changed', v_new.rent_amount IS DISTINCT FROM v_prev.rent_amount,
        'days_changed', v_new.duration_days IS DISTINCT FROM v_prev.duration_days,
        'above_suggestion', v_above, 'above_by', v_above_by,
        'suggested_max_rent', v_suggested, 'band', v_advice->>'band',
        'reason_code', p_change_reason_code,
        'trust_signal', v_trust));
  END IF;

  RETURN v_new_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.renew_rent_request(uuid, numeric, numeric, numeric, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renew_rent_request(uuid, numeric, numeric, numeric, integer, text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_renewal_advice(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_renewal_advice(uuid, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.preview_renewal_amount(uuid, numeric, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_renewal_amount(uuid, numeric, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rent_access_limit_server(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rent_access_limit_server(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.rent_allowed_days() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rent_allowed_days() TO authenticated, service_role;
-- internal helpers: not callable from the API
REVOKE ALL ON FUNCTION public._renewal_advice_params() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rent_days_allowed(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rent_access_limit_calc(timestamptz[], timestamptz, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rent_access_limit_params() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rent_access_limit_core(uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._renewal_plan_stats(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._renewal_band(numeric, boolean, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._renewal_max_rent(integer, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._renewal_advice_core(public.rent_requests, integer, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._guard_renewal_columns() FROM PUBLIC, anon, authenticated, service_role;

-- 7. Reviewer notes -----------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rent_request_review_notes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid        NOT NULL REFERENCES public.rent_requests(id) ON DELETE CASCADE,
  author      uuid        NOT NULL,
  author_role text        NOT NULL CHECK (author_role IN ('agent_ops', 'tenant_ops', 'landlord_ops', 'coo', 'cfo', 'super_admin')),
  stage       text        NOT NULL,
  note        text        NOT NULL CHECK (char_length(btrim(note)) >= 10),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rent_request_review_notes_request_idx ON public.rent_request_review_notes (request_id, created_at);
COMMENT ON TABLE public.rent_request_review_notes IS
  'Append-only reviewer notes on a rent request, written only by add_rent_request_review_note(). Read by the pipeline reviewer roles and the request''s own agent.';

ALTER TABLE public.rent_request_review_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rent_request_review_notes_read ON public.rent_request_review_notes;
CREATE POLICY rent_request_review_notes_read ON public.rent_request_review_notes
  FOR SELECT TO authenticated
  USING (
    has_role(auth.uid(), 'agent_ops'::app_role) OR has_role(auth.uid(), 'tenant_ops'::app_role)
    OR has_role(auth.uid(), 'landlord_ops'::app_role) OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)
    OR EXISTS (SELECT 1 FROM public.rent_requests r
                WHERE r.id = rent_request_review_notes.request_id
                  AND (r.agent_id = auth.uid() OR r.assigned_agent_id = auth.uid()))
  );

REVOKE ALL ON public.rent_request_review_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.rent_request_review_notes TO authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON public.rent_request_review_notes FROM service_role;

-- Append-only, even for the table owner. A request that is deleted takes its notes with it (the cascade runs one trigger level deeper).
CREATE OR REPLACE FUNCTION public._rent_request_review_notes_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'rent_request_review_notes is append-only' USING ERRCODE = '42501';
END;
$function$;
DROP TRIGGER IF EXISTS rent_request_review_notes_append_only ON public.rent_request_review_notes;
CREATE TRIGGER rent_request_review_notes_append_only
  BEFORE UPDATE OR DELETE ON public.rent_request_review_notes
  FOR EACH ROW EXECUTE FUNCTION public._rent_request_review_notes_append_only();
DROP TRIGGER IF EXISTS rent_request_review_notes_no_truncate ON public.rent_request_review_notes;
CREATE TRIGGER rent_request_review_notes_no_truncate
  BEFORE TRUNCATE ON public.rent_request_review_notes
  FOR EACH STATEMENT EXECUTE FUNCTION public._rent_request_review_notes_append_only();

CREATE OR REPLACE FUNCTION public.add_rent_request_review_note(
  p_request_id uuid,
  p_note text,
  p_stage text DEFAULT NULL,
  p_role text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_status text;
  v_note text := btrim(COALESCE(p_note, ''));
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '42501'; END IF;
  IF p_role IS NOT NULL THEN
    IF p_role NOT IN ('agent_ops', 'tenant_ops', 'landlord_ops', 'coo', 'cfo', 'super_admin') OR NOT public.has_role(v_actor, p_role::public.app_role) THEN
      RAISE EXCEPTION 'NOT_A_REVIEWER: you do not hold the % role', p_role USING ERRCODE = '42501';
    END IF;
    v_role := p_role;
  ELSE
    SELECT r INTO v_role FROM unnest(ARRAY['agent_ops', 'tenant_ops', 'landlord_ops', 'coo', 'cfo', 'super_admin']) AS r
     WHERE public.has_role(v_actor, r::public.app_role) LIMIT 1;
  END IF;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'NOT_A_REVIEWER: only agent_ops, tenant_ops, landlord_ops, coo, cfo and super_admin can add a review note' USING ERRCODE = '42501';
  END IF;
  SELECT status INTO v_status FROM public.rent_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REQUEST_NOT_FOUND' USING ERRCODE = '22023'; END IF;
  IF char_length(v_note) < 10 THEN
    RAISE EXCEPTION 'NOTE_TOO_SHORT: a review note needs at least 10 characters' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.rent_request_review_notes (request_id, author, author_role, stage, note)
  VALUES (p_request_id, v_actor, v_role, COALESCE(NULLIF(btrim(COALESCE(p_stage, '')), ''), v_status), v_note)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.add_rent_request_review_note(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_rent_request_review_note(uuid, text, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public._rent_request_review_notes_append_only() FROM PUBLIC, anon, authenticated, service_role;

-- 8. Reviewer read access ---------------------------------------------------------------------------------------------------------------
-- The pipeline screens read rent_requests directly, so the renewal columns are readable wherever the row is. Until now only holders of
-- tenant_ops, manager, cfo, coo or ceo (and an agent their own rows) could read it: an agent_ops, landlord_ops or super_admin who held none
-- of those saw only their own requests. This adds the role-based read the pipeline already assumes.
DROP POLICY IF EXISTS "Pipeline reviewers can view rent requests" ON public.rent_requests;
CREATE POLICY "Pipeline reviewers can view rent requests" ON public.rent_requests
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'agent_ops'::app_role) OR has_role(auth.uid(), 'landlord_ops'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role));

-- The Service Center reviewer reads the queue through this RPC: same function, same rows, plus the renewal fields.
CREATE OR REPLACE FUNCTION public.get_service_center_rent_queue(p_manager_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_manager uuid := COALESCE(p_manager_id, auth.uid());
  v_rows jsonb;
  v_reviewed jsonb;
BEGIN
  IF v_manager IS NULL THEN RAISE EXCEPTION 'manager required'; END IF;
  IF v_manager <> auth.uid() AND NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at'), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'id', rr.id,
      'status', rr.status,
      'created_at', rr.created_at,
      'rent_amount', rr.rent_amount,
      'duration_days', rr.duration_days,
      'daily_repayment', rr.daily_repayment,
      'total_repayment', rr.total_repayment,
      'house_category', rr.house_category,
      'request_city', rr.request_city,
      'house_image_urls', rr.house_image_urls,
      'tenant_photo_url', rr.tenant_photo_url,
      'tenant_id', rr.tenant_id,
      'tenant_name', tp.full_name,
      'tenant_phone', tp.phone,
      'agent_id', rr.agent_id,
      'agent_name', ap.full_name,
      'agent_phone', ap.phone,
      'agent_avatar_url', ap.avatar_url,
      'landlord_name', lp.name,
      'landlord_phone', lp.phone,
      'registration_type', rr.registration_type,
      'renewal_previous_rent', rr.renewal_previous_rent,
      'renewal_previous_days', rr.renewal_previous_days,
      'renewal_advice_snapshot', rr.renewal_advice_snapshot,
      'renewal_above_suggestion', rr.renewal_above_suggestion,
      'renewal_above_by', rr.renewal_above_by,
      'renewal_change_reason_code', rr.renewal_change_reason_code,
      'renewal_change_explanation', rr.renewal_change_explanation,
      'renewal_evidence_url', rr.renewal_evidence_url
    ) AS x
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
    LEFT JOIN public.landlords lp ON lp.id = rr.landlord_id
    WHERE rr.service_center_manager_id = v_manager
      AND rr.status = 'service_center_review'
  ) s;

  SELECT COALESCE(jsonb_agg(y ORDER BY y->>'service_center_reviewed_at' DESC), '[]'::jsonb) INTO v_reviewed
  FROM (
    SELECT jsonb_build_object(
      'id', rr.id,
      'status', rr.status,
      'rent_amount', rr.rent_amount,
      'tenant_name', tp.full_name,
      'agent_name', ap.full_name,
      'service_center_reviewed_at', rr.service_center_reviewed_at,
      'service_center_comment', rr.service_center_comment
    ) AS y
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = rr.agent_id
    WHERE rr.service_center_manager_id = v_manager
      AND rr.service_center_reviewed_at IS NOT NULL
    ORDER BY rr.service_center_reviewed_at DESC
    LIMIT 25
  ) r;

  RETURN jsonb_build_object(
    'manager_id', v_manager,
    'is_service_center_manager', public.is_service_center_manager(v_manager),
    'pending_count', jsonb_array_length(v_rows),
    'pending', v_rows,
    'recent_reviewed', v_reviewed
  );
END; $function$;

-- 9. Tenant OTP bound to the new rent AND days ---------------------------------------------------------------------------------------------
ALTER TABLE public.rent_renewal_otps
  ADD COLUMN IF NOT EXISTS new_rent_amount numeric,
  ADD COLUMN IF NOT EXISTS new_duration_days integer,
  ADD COLUMN IF NOT EXISTS new_daily_repayment numeric,
  ADD COLUMN IF NOT EXISTS new_total_repayment numeric;

-- The old one-argument function is replaced (a second overload would make calls ambiguous). With no new rent or days it returns what it
-- returned before, plus the figures for the current rent and days.
DROP FUNCTION IF EXISTS public.rent_renewal_otp_context(uuid);

CREATE OR REPLACE FUNCTION public.rent_renewal_otp_context(p_prev_request_id uuid, p_new_rent numeric DEFAULT NULL, p_new_days integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_prev rent_requests%ROWTYPE; v_phone text; v_tname text; v_aname text;
  v_rent numeric; v_days integer; c record;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT * INTO v_prev FROM rent_requests WHERE id = p_prev_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PREVIOUS_REQUEST_NOT_FOUND'; END IF;
  IF v_prev.status <> 'completed' THEN RAISE EXCEPTION 'PLAN_NOT_COMPLETED: only a completed Rent Plan can be renewed'; END IF;
  IF NOT _can_renew_rent_request(v_prev, v_actor) THEN RAISE EXCEPTION 'NOT_YOUR_REQUEST'; END IF;
  v_rent := COALESCE(p_new_rent, v_prev.rent_amount);
  v_days := COALESCE(p_new_days, v_prev.duration_days);
  IF v_rent IS NULL OR v_rent <= 0 THEN
    RAISE EXCEPTION 'RENEWAL_AMOUNT_INVALID: the new rent must be more than UGX 0' USING ERRCODE = '22023';
  END IF;
  IF NOT public._rent_days_allowed(v_days) THEN
    RAISE EXCEPTION 'RENEWAL_DAYS_NOT_ALLOWED: % days is not an allowed plan length (30, 60, 90, 120, or a multiple of 7 from 7 to 364)', v_days
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM public.compute_rent_repayment(v_rent, v_days);
  SELECT phone, full_name INTO v_phone, v_tname FROM profiles WHERE id = v_prev.tenant_id;
  SELECT full_name INTO v_aname FROM profiles WHERE id = v_actor;
  RETURN jsonb_build_object('tenant_id', v_prev.tenant_id, 'tenant_phone', v_phone, 'tenant_name', v_tname,
    'agent_id', v_actor, 'agent_name', v_aname,
    'new_rent_amount', v_rent, 'new_days', v_days,
    'new_daily_repayment', c.daily_repayment, 'new_total_repayment', c.total_repayment,
    'changed', (v_rent IS DISTINCT FROM v_prev.rent_amount) OR (v_days IS DISTINCT FROM v_prev.duration_days));
END $function$;
REVOKE ALL ON FUNCTION public.rent_renewal_otp_context(uuid, numeric, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rent_renewal_otp_context(uuid, numeric, integer) TO authenticated, service_role;

-- A verified code confirms exactly the rent and the days it was issued for. A code issued before this change has no binding and still
-- confirms only a renewal at the previous plan's own rent and days (what it always did).
CREATE OR REPLACE FUNCTION public.enforce_rent_renewal_otp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_otp uuid; v_actor uuid := COALESCE(auth.uid(), NEW.agent_id); v_other boolean;
BEGIN
  IF NEW.registration_type IS DISTINCT FROM 'renewal' THEN RETURN NEW; END IF;
  SELECT o.id INTO v_otp FROM rent_renewal_otps o
   WHERE o.tenant_id = NEW.tenant_id AND o.agent_id = v_actor
     AND o.verified_at IS NOT NULL AND o.consumed_at IS NULL
     AND o.verified_at > now() - interval '30 minutes'
     AND (
          (o.new_rent_amount IS NOT NULL AND o.new_duration_days IS NOT NULL
             AND o.new_rent_amount = NEW.rent_amount AND o.new_duration_days = NEW.duration_days)
       OR (o.new_rent_amount IS NULL AND o.new_duration_days IS NULL
             AND EXISTS (SELECT 1 FROM rent_requests p WHERE p.id = o.prev_request_id
                           AND p.rent_amount = NEW.rent_amount AND p.duration_days = NEW.duration_days))
     )
   ORDER BY o.verified_at DESC LIMIT 1 FOR UPDATE OF o;
  IF v_otp IS NULL THEN
    SELECT EXISTS (SELECT 1 FROM rent_renewal_otps o
                    WHERE o.tenant_id = NEW.tenant_id AND o.agent_id = v_actor
                      AND o.verified_at IS NOT NULL AND o.consumed_at IS NULL
                      AND o.verified_at > now() - interval '30 minutes') INTO v_other;
    IF v_other THEN
      RAISE EXCEPTION 'RENEWAL_OTP_MISMATCH: the code the tenant confirmed was for a different rent or number of days. Ask the tenant to confirm this renewal with a new code' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'RENEWAL_OTP_REQUIRED: the tenant must confirm this renewal with the code sent to their phone' USING ERRCODE = '42501';
  END IF;
  UPDATE rent_renewal_otps SET consumed_at = now(), consumed_request_id = NEW.id WHERE id = v_otp;
  RETURN NEW;
END $function$;
