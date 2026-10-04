-- Arrears, phase 2 (backend): one round trip for the collect screen.
--
-- WHAT THIS IS
-- Phase 1 started recording which day each collection settles. Phase 2 shows it
-- to the agent at the moment it matters: when they press pay.
--
-- The collect dialog previously called `agent_expected_collection` on its own to
-- learn today's amount. It now calls ONE function that returns today's amount
-- AND the arrears context in the same round trip, so adding arrears costs no
-- extra call.
--
-- WHAT IT DOES NOT DO
-- `expected_today` is still exactly `agent_expected_collection()` - this function
-- CALLS it rather than restating the rule, so the screen, this dialog and the
-- allocation RPC's shortfall stamping can never disagree. The screen keeps
-- showing only today's amount, as agreed. Nothing here writes anything.
--
-- BEFORE GO-LIVE THIS IS SILENT BY CONSTRUCTION
-- The arrears views are floored at `rent_arrears_go_live()`, so until that day
-- `days_behind` and `arrears_ugx` are 0 and the behind-day list is empty. The
-- dialog renders the arrears block only when there is something to show, so no
-- date gate is needed in the frontend - the empty queue is the gate.

-- ------------------------------------------------ who may see a plan's arrears

-- The collection path (`agent_allocate_tenant_payment`) lets three parties
-- collect on a plan: its owning agent, its assigned agent, and a parent agent
-- whose verified sub-agent holds it. Anyone who may collect must be able to see
-- what they are collecting against, so this mirrors that test exactly instead of
-- inventing a second, narrower rule.
CREATE OR REPLACE FUNCTION public.rent_plan_collect_authorized(p_rent_request_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.rent_arrears_read_authorized()
      OR EXISTS (
           SELECT 1
             FROM public.rent_requests rr
            WHERE rr.id = p_rent_request_id
              AND (
                auth.uid() = rr.agent_id
                OR auth.uid() = rr.assigned_agent_id
                OR EXISTS (
                     SELECT 1 FROM public.agent_subagents sa
                      WHERE sa.parent_agent_id = auth.uid()
                        AND sa.sub_agent_id IN (rr.agent_id, rr.assigned_agent_id)
                        AND sa.status IN ('verified','approved','accepted')
                   )
              )
         );
$function$;

COMMENT ON FUNCTION public.rent_plan_collect_authorized(uuid) IS
  'May the caller see this Rent Plan day ledger? Staff via rent_arrears_read_authorized(), or any party the collection path lets collect on it: owning agent, assigned agent, or a parent agent of a verified sub-agent holding it.';

GRANT EXECUTE ON FUNCTION public.rent_plan_collect_authorized(uuid) TO authenticated, service_role;

-- Phase 1 gated the per-plan ledger on owner/assigned only, which locked out a
-- parent agent who is allowed to collect for a sub-agent's tenant. Same rule
-- everywhere now.
CREATE OR REPLACE FUNCTION public.rent_plan_day_ledger(p_rent_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  IF p_rent_request_id IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  IF NOT public.rent_plan_collect_authorized(p_rent_request_id) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT jsonb_build_object(
           'rent_request_id', p_rent_request_id,
           'go_live', public.rent_arrears_go_live(),
           'summary', COALESCE(
             (SELECT to_jsonb(a) - 'rent_request_id'
                FROM public.v_rent_plan_arrears a
               WHERE a.rent_request_id = p_rent_request_id),
             jsonb_build_object('days_billed',0,'days_behind',0,'arrears_ugx',0,
                                'due_today_ugx',0,'billed_to_date_ugx',0,
                                'settled_to_date_ugx',0,'oldest_open_day',NULL)),
           'days', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'day', l.day,
                      'expected', l.expected_ugx,
                      'settled', l.settled_ugx,
                      'remaining', l.remaining_ugx,
                      'is_settled', l.is_settled
                    ) ORDER BY l.day DESC)
             FROM public.v_rent_day_ledger l
             WHERE l.rent_request_id = p_rent_request_id), '[]'::jsonb),
           'unapplied_ugx', COALESCE((
             SELECT SUM(u.unapplied_ugx) FROM public.v_rent_collection_unapplied u
              WHERE u.rent_request_id = p_rent_request_id), 0)
         )
    INTO v_out;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.rent_plan_day_ledger(uuid) IS
  'One Rent Plan day-by-day: expected, settled and remaining per day, plus the arrears summary and any unapplied money. Readable by staff or by any party allowed to collect on the plan (rent_plan_collect_authorized).';

-- ----------------------------------------------- the collect screen one call

CREATE OR REPLACE FUNCTION public.agent_collect_context(p_rent_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_out   jsonb;
  -- Display cap on the itemised day list. The arithmetic never uses it - the
  -- totals below are exact and unclipped - so a long history only shortens what
  -- is itemised, never what is owed.
  c_day_limit constant int := 30;
BEGIN
  IF p_rent_request_id IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  IF NOT public.rent_plan_collect_authorized(p_rent_request_id) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  -- One pass over this plan's days, reused for every figure below. The CTE is
  -- referenced more than once so Postgres materialises it: one index scan, not
  -- one per field.
  WITH ledger AS (
    SELECT l.day, l.expected_ugx, l.settled_ugx, l.remaining_ugx
      FROM public.v_rent_day_ledger l
     WHERE l.rent_request_id = p_rent_request_id
  ), open_days AS (
    SELECT * FROM ledger WHERE remaining_ugx > 0
  )
  SELECT jsonb_build_object(
           'rent_request_id', p_rent_request_id,
           'today', v_today,
           'go_live', public.rent_arrears_go_live(),

           -- Today's amount, from the one definition the whole system uses.
           'expected_today', COALESCE(public.agent_expected_collection(p_rent_request_id), 0),

           -- Arrears: strictly days BEFORE today. Today is not yet late.
           'days_behind',     (SELECT count(*)                       FROM open_days WHERE day < v_today),
           'arrears_ugx',     (SELECT COALESCE(SUM(remaining_ugx),0) FROM open_days WHERE day < v_today),
           'oldest_open_day', (SELECT min(day)                       FROM open_days WHERE day < v_today),

           -- What is still outstanding on today's own obligation, after any
           -- collection already recorded today. Informational: the screen still
           -- offers `expected_today`.
           'due_today_ugx',     (SELECT COALESCE(SUM(remaining_ugx),0) FROM open_days WHERE day = v_today),
           'settled_today_ugx', (SELECT COALESCE(SUM(settled_ugx),0)   FROM ledger    WHERE day = v_today),

           -- Money already collected on this plan that has not landed on a day
           -- yet. It pre-pays future days as the pin creates them.
           'unapplied_ugx', COALESCE((
             SELECT SUM(u.unapplied_ugx) FROM public.v_rent_collection_unapplied u
              WHERE u.rent_request_id = p_rent_request_id), 0),

           -- Itemised behind-days, oldest first, so the dialog can name them.
           'behind_days', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'day', d.day,
                      'expected', d.expected_ugx,
                      'settled', d.settled_ugx,
                      'remaining', d.remaining_ugx
                    ) ORDER BY d.day)
               FROM (SELECT * FROM open_days WHERE day < v_today
                      ORDER BY day LIMIT c_day_limit) d), '[]'::jsonb),
           'behind_days_truncated',
             (SELECT count(*) FROM open_days WHERE day < v_today) > c_day_limit
         )
    INTO v_out;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.agent_collect_context(uuid) IS
  'Everything the collect screen needs in one round trip: today expected amount (delegated to agent_expected_collection so there is one definition), plus days behind, arrears, what is still due today and any unapplied money. Read-only. Returns zeros before the arrears go-live floor, so the dialog needs no date gate.';

GRANT EXECUTE ON FUNCTION public.agent_collect_context(uuid) TO authenticated, service_role;

-- Postgres grants EXECUTE to PUBLIC by default, which reaches `anon`. These all
-- gate on auth.uid() so an anonymous caller would only ever get 'not_authorized',
-- but a signed-out session has no business reaching a tenant's day ledger at all.
REVOKE EXECUTE ON FUNCTION public.rent_plan_collect_authorized(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.rent_plan_day_ledger(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.agent_collect_context(uuid) FROM anon;
