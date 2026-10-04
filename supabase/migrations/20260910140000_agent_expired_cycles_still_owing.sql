-- D2: a Rent Plan whose cycle has ended but is still owing is invisible to the
-- agent.
--
-- THE DEFECT
-- `agent_expected_collection()` reads today's pinned instalment. Once a plan's
-- term has passed there are no more days to pin, so it returns 0 - while the
-- tenant may still owe the whole balance. Measured on the live plan in the
-- SMALLS Ronald Musana test: a cycle that ended 11 days ago, 30 days billed,
-- 143,000 owed, expected today 0.
--
-- The arrears queue does not close the gap either. It is scoped by
-- rent_arrears_go_live() (2026-09-10), and an expired cycle's unpaid days are
-- almost all before that floor, so they are correctly out of scope for day
-- settlement - but that leaves the debt with nowhere to appear.
--
-- ONE DEFINITION OF "PAST TERM AND STILL OWING"
-- Agent Ops > Performance already reports this population through
-- `agent_ops_collection_target`, which is built on `v_rent_plan_schedule`.
-- That view carries eligibility rules this surface must not quietly drop:
--
--   * status funded / repaying / completed only (not `disbursed`)
--   * agent_payment_status <> 'not_paying'
--   * tenancy_status = 'active' and tenancy_ended_at IS NULL
--   * duration_days > 0
--   * NO active repayment pause
--
-- A first draft of this view read `rent_requests` directly and reported 508
-- plans / 153,796,274 against the ops card's 472 / 144,897,343. The 41 extra
-- plans carrying 10,027,682 were paused plans, ended tenancies and agents
-- marked not paying - tenants an agent must NOT be told to chase. Building on
-- `v_rent_plan_schedule` instead makes the agent card and the ops card agree by
-- construction rather than by coincidence.
--
-- SCALE, measured 2026-09-10 against production: 472 Rent Plans past their end
-- date and still owing, 144,897,343 UGX outstanding, oldest cycle ended April.
--
-- No backfill is performed and none is needed - the balance was always there,
-- it simply had no surface.
--
-- Terminology: "Rent Plan", never "loan".

-- 1. The population -------------------------------------------------------
CREATE OR REPLACE VIEW public.v_rent_plan_expired_owing AS
WITH t AS (SELECT (now() AT TIME ZONE 'Africa/Kampala')::date AS today)
SELECT s.rent_request_id,
       COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
       s.tenant_id,
       rr.status,
       rr.repayment_frequency,
       s.daily_amount   AS daily_repayment,
       s.total_amount   AS total_repayment,
       s.amount_repaid,
       -- Identical arithmetic to agent_ops_collection_target's `arrears`. For a
       -- fully elapsed term this equals total_repayment - amount_repaid; it is
       -- written the long way so the two surfaces cannot drift apart.
       GREATEST(0,
         LEAST(s.daily_amount * GREATEST(LEAST(t.today - s.term_start + 1, s.oblig_days), 0), s.total_amount)
         - s.amount_repaid) AS outstanding_ugx,
       s.term_start     AS starts_on,
       s.term_end       AS term_ends_on,
       (t.today - s.obligation_end) AS days_overdue,
       lp.last_payment_on
  FROM public.v_rent_plan_schedule s
  JOIN public.rent_requests rr ON rr.id = s.rent_request_id
  CROSS JOIN t
  LEFT JOIN LATERAL (
    SELECT max((ac.created_at AT TIME ZONE 'Africa/Kampala')::date) AS last_payment_on
      FROM public.agent_collections ac
     WHERE ac.rent_request_id = s.rent_request_id
       AND COALESCE(ac.notes, '') NOT ILIKE '%[REVERSED:%'
  ) lp ON true
 WHERE s.obligation_end < t.today
   AND GREATEST(0,
         LEAST(s.daily_amount * GREATEST(LEAST(t.today - s.term_start + 1, s.oblig_days), 0), s.total_amount)
         - s.amount_repaid) > 0;

COMMENT ON VIEW public.v_rent_plan_expired_owing IS
  'Rent Plans whose repayment cycle has ended while a balance remains. Built on v_rent_plan_schedule '
  'so it inherits the same eligibility rules as agent_ops_collection_target - paused plans, ended '
  'tenancies and non-paying agents are excluded, and the agent card and the ops card agree.';

-- 2. What the agent sees --------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_expired_cycles(p_agent_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_id, auth.uid());
  v_out jsonb;
BEGIN
  IF v_agent IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  -- Same three-party test as the rest of the arrears surfaces: ops roles see
  -- any agent, an agent sees only themselves.
  IF NOT (public.rent_arrears_read_authorized() OR auth.uid() = v_agent) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT jsonb_build_object(
           'agent_id', v_agent,
           'as_at', (now() AT TIME ZONE 'Africa/Kampala')::timestamp(0),
           'totals', jsonb_build_object(
             'plans',           COUNT(*),
             'outstanding_ugx', COALESCE(SUM(e.outstanding_ugx), 0),
             'oldest_term_end', MIN(e.term_ends_on),
             'max_days_overdue', COALESCE(MAX(e.days_overdue), 0)),
           'plans', COALESCE(jsonb_agg(jsonb_build_object(
             'rent_request_id', e.rent_request_id,
             'tenant_id',       e.tenant_id,
             'tenant_name',     p.full_name,
             'tenant_phone',    p.phone,
             'status',          e.status,
             'term_ends_on',    e.term_ends_on,
             'days_overdue',    e.days_overdue,
             'outstanding_ugx', e.outstanding_ugx,
             'total_repayment', e.total_repayment,
             'amount_repaid',   e.amount_repaid,
             'last_payment_on', e.last_payment_on)
             ORDER BY e.outstanding_ugx DESC, e.days_overdue DESC), '[]'::jsonb)
         ) INTO v_out
    FROM public.v_rent_plan_expired_owing e
    LEFT JOIN public.profiles p ON p.id = e.tenant_id
   WHERE e.agent_id = v_agent;

  RETURN COALESCE(v_out, jsonb_build_object(
    'agent_id', v_agent,
    'totals', jsonb_build_object('plans', 0, 'outstanding_ugx', 0),
    'plans', '[]'::jsonb));
END;
$function$;

COMMENT ON FUNCTION public.agent_expired_cycles(uuid) IS
  'Rent Plans past their end date that still owe, for one agent. Companion to '
  'agent_arrears_overview(), which covers plans inside their cycle.';

GRANT EXECUTE ON FUNCTION public.agent_expired_cycles(uuid) TO authenticated;

-- The view is read only through the SECURITY DEFINER function above, which
-- carries the authorization test. No direct grant.
REVOKE ALL ON public.v_rent_plan_expired_owing FROM authenticated, anon;

-- 3. Post-condition: the agent card and the ops card must report the same book.
DO $verify$
DECLARE
  v_asof date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_view_plans bigint; v_view_ugx numeric;
  v_ops_plans  bigint; v_ops_ugx  numeric;
BEGIN
  SELECT count(*), COALESCE(round(sum(outstanding_ugx)), 0)
    INTO v_view_plans, v_view_ugx
    FROM public.v_rent_plan_expired_owing;

  SELECT count(*), COALESCE(round(sum(arrears)), 0)
    INTO v_ops_plans, v_ops_ugx
    FROM (
      SELECT GREATEST(0,
               LEAST(s.daily_amount * GREATEST(LEAST(v_asof - s.term_start + 1, s.oblig_days), 0), s.total_amount)
               - s.amount_repaid) AS arrears
        FROM public.v_rent_plan_schedule s
       WHERE NOT (s.term_start <= v_asof AND s.obligation_end >= v_asof)
    ) q
   WHERE arrears > 0;

  IF v_view_plans <> v_ops_plans OR v_view_ugx <> v_ops_ugx THEN
    RAISE EXCEPTION
      'expired-owing disagrees with the ops collection target: view % plans / %, ops % plans / %',
      v_view_plans, v_view_ugx, v_ops_plans, v_ops_ugx;
  END IF;

  RAISE NOTICE 'expired and still owing: % plans / % UGX (agrees with Agent Ops > Performance)',
    v_view_plans, v_view_ugx;
END
$verify$;
