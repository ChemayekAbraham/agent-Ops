-- Landlord float recall — go-live moved, an ops queue, and the route-2 fee gap
--
-- Three asks, one migration:
--
--   1. The recall rule starts NEXT WEEK, not tomorrow. Monday 28 September
--      2026, 00:00 Kampala. Today is Friday; agents have never been told a
--      deadline exists, and a weekend is not the moment to start cancelling
--      tenants. Nothing else about the rule changes.
--
--   2. Landlord Operations and the CFO need to SEE these cases and act on
--      them. `landlord_float_idle_alerts` is REVOKEd from authenticated (it
--      must stay that way — it is money), so the surface is two SECURITY
--      DEFINER RPCs: a read and an action.
--
--   3. Close the second fee hole. `cancel_tenant_and_return_landlord_float`
--      reverses the fee recognition since 20260925140000; the agent-requested
--      route, `cfo_decide_allocation_return`, takes a different path and does
--      not. Same defect, different wall.
--
-- And a rule on top of all of it: only the CFO, Landlord Ops, the CTO and a
-- Super Admin may REVERSE landlord float. Agents request; they never decide.
--
-- NOTHING IS BACKFILLED. See the note above `reverse_funding_treasury` below
-- for exactly which historical rows are affected and why almost none of them
-- should be touched.

-- ---------------------------------------------------------------------------
-- 1. Who may reverse landlord float
--
-- One predicate, used by BOTH reversal routes, so the answer cannot drift
-- between them. Today the two disagree:
--
--   cancel_tenant_and_return_landlord_float  cfo, manager, super_admin, coo,
--                                            operations, financial_ops
--   cfo_decide_allocation_return             is_cfo_approver() — which is
--                                            cfo AND a row in
--                                            cfo_approval_approvers, a table
--                                            with exactly ONE member
--
-- The second is why 2 return requests are sitting pending: one person on the
-- whole platform can clear them. The first is the opposite problem — 74 people
-- can cancel a tenant and pull back their landlord's rent.
--
-- Both become this. `agent` is absent by construction: request_allocation_return
-- is the agent's route and it only ever creates a pending row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_reverse_landlord_float(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT _user_id IS NOT NULL AND (
       public.has_role(_user_id, 'cfo'::app_role)
    OR public.has_role(_user_id, 'landlord_ops'::app_role)
    OR public.has_role(_user_id, 'cto'::app_role)
    OR public.has_role(_user_id, 'super_admin'::app_role)
  )
$function$;

COMMENT ON FUNCTION public.can_reverse_landlord_float(uuid) IS
  'May this user pull landlord float back out of an agent wallet and unwind the '
  'Rent Plan? CFO, Landlord Ops, CTO, Super Admin only. Agents request via '
  'request_allocation_return and never decide.';

-- Reading the queue is deliberately wider than acting on it: a COO or an
-- Operations lead should be able to see 13.4m of idle landlord money without
-- being able to cancel a tenant over it.
CREATE OR REPLACE FUNCTION public.can_view_landlord_float_queue(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT _user_id IS NOT NULL AND (
       public.can_reverse_landlord_float(_user_id)
    OR public.has_role(_user_id, 'ceo'::app_role)
    OR public.has_role(_user_id, 'coo'::app_role)
    OR public.has_role(_user_id, 'manager'::app_role)
    OR public.has_role(_user_id, 'operations'::app_role)
    OR public.has_role(_user_id, 'financial_ops'::app_role)
    OR public.has_role(_user_id, 'agent_ops'::app_role)
  )
$function$;

GRANT EXECUTE ON FUNCTION public.can_reverse_landlord_float(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_view_landlord_float_queue(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. The go-live floor moves to Monday 28 September 2026, 00:00 Kampala.
--
-- IMMUTABLE, so it is safe in the index-free predicates that use it. Changing
-- the body of an IMMUTABLE function is fine here — nothing indexes on it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landlord_float_recall_go_live()
RETURNS timestamptz LANGUAGE sql IMMUTABLE
AS $function$ SELECT timestamptz '2026-09-28 00:00:00+03' $function$;

COMMENT ON FUNCTION public.landlord_float_recall_go_live() IS
  'Float funded before this moment is never auto-recalled: the rule did not '
  'exist when it was disbursed. Tracked and alerted only, for a human to work. '
  'Moved from 26 Sep to Monday 28 Sep 2026 so agents get a working-week start '
  'rather than a weekend one.';

-- ---------------------------------------------------------------------------
-- 3. Re-funding after a reversal must re-recognise the fee
--
-- This has to land BEFORE the fee reversal is wired into route 2, because
-- route 2 does not cancel the plan — it sends it back to `agent_ops_approved`,
-- where it can be funded again. Two things would then bite:
--
--   (a) recognise_funding_treasury's guard tests for ANY treasury_fee_recognised
--       leg without filtering direction, so a reversal leg would make it
--       report 'already_recognised' for ever and the re-funded plan would
--       carry no fee receivable at all.
--
--   (b) its idempotency key is 'treasury-funding:<plan>', so even past the
--       guard, create_ledger_transaction would hand back the first cycle's
--       group and post nothing.
--
-- This is not hypothetical: plan 4b30340b went funded -> returned -> funded
-- again on 17 Sep, and a7fe92c5 went returned -> funded -> repaying. Both are
-- live today.
--
-- The guard becomes net-aware and the key gains a cycle suffix. Cycle 0 keeps
-- the bare key, so every existing group is untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recognise_funding_treasury(p_rent_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_af numeric; v_rf numeric; v_fees numeric; v_grp uuid;
  v_out numeric; v_in numeric; v_cycle int;
BEGIN
  IF NOT public.is_treasury_waterfall_scope(p_rent_request_id) THEN
    RETURN jsonb_build_object('status','out_of_scope_legacy');
  END IF;

  SELECT COALESCE(access_fee,0), COALESCE(request_fee,0) INTO v_af, v_rf
  FROM rent_requests WHERE id = p_rent_request_id;
  v_fees := v_af + v_rf;

  IF v_fees <= 0 THEN
    RETURN jsonb_build_object('status','no_fees');
  END IF;

  SELECT COUNT(*) FILTER (WHERE gl.direction='cash_out'),
         COALESCE(SUM(gl.amount) FILTER (WHERE gl.direction='cash_out'),0),
         COALESCE(SUM(gl.amount) FILTER (WHERE gl.direction='cash_in'),0)
    INTO v_cycle, v_out, v_in
  FROM general_ledger gl
  WHERE gl.category='treasury_fee_recognised' AND gl.ledger_scope='platform'
    AND gl.source_table='rent_requests' AND gl.source_id=p_rent_request_id;

  -- Net-aware: recognised and not since reversed.
  IF v_out - v_in > 0 THEN
    RETURN jsonb_build_object('status','already_recognised',
      'recognised', v_out, 'reversed', v_in);
  END IF;

  SELECT public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object('direction','cash_in','amount',v_fees,'category','fee_receivable_created',
        'ledger_scope','bridge','source_table','rent_requests','source_id',p_rent_request_id::text,
        'currency','UGX','transaction_date',now(),
        'description','Fee receivable recognised (access + registration) at funding'),
      jsonb_build_object('direction','cash_out','amount',v_fees,'category','treasury_fee_recognised',
        'ledger_scope','platform','source_table','rent_requests','source_id',p_rent_request_id::text,
        'currency','UGX','transaction_date',now(),
        'description','Landlord Flow Treasury recognised at funding')),
    idempotency_key := 'treasury-funding:'||p_rent_request_id::text
                       || CASE WHEN v_cycle = 0 THEN '' ELSE ':'||v_cycle::text END) INTO v_grp;

  RETURN jsonb_build_object('status','recognised','transaction_group_id',v_grp,
                            'access_fee',v_af,'registration_fee',v_rf,'total',v_fees,
                            'cycle', v_cycle);
END;
$function$;

-- Same cycle treatment on the reversal side, for the same reason.
CREATE OR REPLACE FUNCTION public.reverse_funding_treasury(p_rent_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_recognised numeric := 0;
  v_drawn      numeric := 0;
  v_reversed   numeric := 0;
  v_net        numeric := 0;
  v_cycle      int := 0;
  v_grp        uuid;
BEGIN
  IF p_rent_request_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_plan');
  END IF;

  SELECT COALESCE(SUM(gl.amount),0) INTO v_recognised
  FROM public.general_ledger gl
  WHERE gl.category='treasury_fee_recognised' AND gl.ledger_scope='platform'
    AND gl.source_table='rent_requests' AND gl.source_id = p_rent_request_id
    AND gl.direction='cash_out';

  IF v_recognised <= 0 THEN
    RETURN jsonb_build_object('status','nothing_recognised');
  END IF;

  SELECT COALESCE(SUM(gl.amount),0) INTO v_drawn
  FROM public.general_ledger gl
  JOIN public.agent_collections c ON c.id = gl.source_id
  WHERE gl.category='treasury_fee_drawdown' AND gl.ledger_scope='platform'
    AND gl.source_table='agent_collections'
    AND c.rent_request_id = p_rent_request_id;

  SELECT COUNT(*), COALESCE(SUM(gl.amount),0) INTO v_cycle, v_reversed
  FROM public.general_ledger gl
  WHERE gl.category='treasury_fee_recognised' AND gl.ledger_scope='platform'
    AND gl.source_table='rent_requests' AND gl.source_id = p_rent_request_id
    AND gl.direction='cash_in';

  v_net := v_recognised - v_drawn - v_reversed;

  IF v_net <= 0 THEN
    RETURN jsonb_build_object('status','nothing_to_reverse',
      'recognised', v_recognised, 'drawn_down', v_drawn, 'already_reversed', v_reversed);
  END IF;

  SELECT public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object('direction','cash_out','amount',v_net,'category','fee_receivable_created',
        'ledger_scope','bridge','source_table','rent_requests','source_id',p_rent_request_id::text,
        'currency','UGX','transaction_date',now(),
        'description','Fee receivable reversed — Rent Plan unwound before the landlord was paid'),
      jsonb_build_object('direction','cash_in','amount',v_net,'category','treasury_fee_recognised',
        'ledger_scope','platform','source_table','rent_requests','source_id',p_rent_request_id::text,
        'currency','UGX','transaction_date',now(),
        'description','Landlord Flow Treasury recognition reversed — Rent Plan unwound')),
    idempotency_key := 'treasury-funding-reversal:'||p_rent_request_id::text
                       || CASE WHEN v_cycle = 0 THEN '' ELSE ':'||v_cycle::text END) INTO v_grp;

  RETURN jsonb_build_object('status','reversed','amount',v_net,
    'recognised',v_recognised,'drawn_down',v_drawn,'transaction_group_id',v_grp,
    'cycle', v_cycle);
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_funding_treasury(uuid) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Route 2 — cfo_decide_allocation_return
--
-- Anchored patches against the live definition, not a retyped copy. Each
-- replace() is asserted first, so drift fails loudly instead of silently
-- producing a function that is missing a change.
--
-- (a) Authorisation -> can_reverse_landlord_float.
-- (b) Reverse the fee recognition on approve. This is the gap being closed.
-- (c) An idempotency key on the reversal post. Without one, two clicks on
--     Approve race past the `status <> 'pending'` check under different
--     snapshots and post the principal reversal twice.
-- (d) Surface the fee reversal in the return payload and the audit log, so the
--     operator sees what moved.
--
-- WHAT IS *NOT* DONE HERE: nothing historical is reversed. Of the 37 approved
-- returns, 4 carry a recognised fee, and only ONE is genuinely stranded —
-- plan 5530b7ce, UGX 119,000, plan now `rejected`. The other three are live:
-- 4b30340b (76,000) and a7fe92c5 (59,500) were both re-funded after the return
-- and their fee receivable is real today. Reversing those would delete a
-- receivable the platform genuinely holds. The earlier "3 cases / UGX 254,500"
-- read counted those live plans; the honest stranded figure is 1 / 119,000.
-- It is listed for a human, not corrected by this migration.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE src text; before text;
BEGIN
  SELECT p.prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='cfo_decide_allocation_return';

  IF src IS NULL THEN RAISE EXCEPTION 'cfo_decide_allocation_return not found'; END IF;

  IF position('can_reverse_landlord_float' in src) > 0 THEN
    RAISE NOTICE 'cfo_decide_allocation_return already patched, skipping';
    RETURN;
  END IF;

  -- (a) authorisation
  before := src;
  src := replace(src,
'  IF auth.uid() IS NOT NULL AND NOT public.is_cfo_approver(auth.uid()) THEN
    RAISE EXCEPTION ''This request could not be completed'';
  END IF;
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object(''success'', false, ''error'', ''Not authenticated.'');
  END IF;
  IF NOT (has_role(v_caller,''cfo''::app_role)
          OR has_role(v_caller,''manager''::app_role)
          OR has_role(v_caller,''super_admin''::app_role)) THEN
    RETURN jsonb_build_object(''success'', false, ''error'', ''Only CFO can decide allocation returns.'');
  END IF;',
'  IF v_caller IS NULL THEN
    RETURN jsonb_build_object(''success'', false, ''error'', ''Not authenticated.'');
  END IF;
  IF NOT public.can_reverse_landlord_float(v_caller) THEN
    RETURN jsonb_build_object(''success'', false, ''error'',
      ''Only the CFO, Landlord Operations, the CTO or a Super Admin may return landlord float.'');
  END IF;');
  IF src = before THEN RAISE EXCEPTION 'anchor (a) authorisation block missing'; END IF;

  -- (b) declare the reversal result
  before := src;
  src := replace(src, '  v_new_group uuid;',
                      '  v_new_group uuid;'||chr(10)||'  v_fee_rev   jsonb;');
  IF src = before THEN RAISE EXCEPTION 'anchor (b) v_new_group declaration missing'; END IF;

  -- (c) reverse the fee recognition, first thing on approve
  before := src;
  src := replace(src,
'  -- APPROVE
  SELECT public.create_ledger_transaction(entries := jsonb_build_array(',
'  -- APPROVE
  -- The plan stops being funded here, so the access + registration fee
  -- receivable raised at funding stops being real. Never allowed to abort the
  -- return itself: a fee that failed to reverse is a reporting problem, an
  -- allocation stuck in return_pending is an operational one.
  BEGIN
    v_fee_rev := public.reverse_funding_treasury(v_req.rent_request_id);
  EXCEPTION WHEN OTHERS THEN
    v_fee_rev := jsonb_build_object(''status'',''error'',''message'',SQLERRM);
    RAISE WARNING ''reverse_funding_treasury failed for %: %'', v_req.rent_request_id, SQLERRM;
  END;

  SELECT public.create_ledger_transaction(entries := jsonb_build_array(');
  IF src = before THEN RAISE EXCEPTION 'anchor (c) APPROVE block missing'; END IF;

  -- (d) idempotency key on the principal reversal
  before := src;
  src := replace(src,
'      ''transaction_date'', now()
    )
  )) INTO v_new_group;',
'      ''transaction_date'', now()
    )
  ), idempotency_key := ''allocation-return:''||p_request_id::text) INTO v_new_group;');
  IF src = before THEN RAISE EXCEPTION 'anchor (d) create_ledger_transaction close missing'; END IF;

  -- (e) report what happened
  before := src;
  src := replace(src,
'          jsonb_build_object(''cfo_note'', p_cfo_note, ''amount'', v_req.amount,
                             ''reversal_transaction_group'', v_new_group));',
'          jsonb_build_object(''cfo_note'', p_cfo_note, ''amount'', v_req.amount,
                             ''reversal_transaction_group'', v_new_group,
                             ''fee_recognition_reversal'', v_fee_rev));');
  IF src = before THEN RAISE EXCEPTION 'anchor (e) audit metadata missing'; END IF;

  before := src;
  src := replace(src,
'  RETURN jsonb_build_object(''success'', true, ''status'', ''approved'',
                            ''amount_returned'', v_req.amount, ''landlord_name'', v_req.landlord_name);',
'  RETURN jsonb_build_object(''success'', true, ''status'', ''approved'',
                            ''amount_returned'', v_req.amount, ''landlord_name'', v_req.landlord_name,
                            ''fee_recognition_reversal'', v_fee_rev);');
  IF src = before THEN RAISE EXCEPTION 'anchor (f) approved return payload missing'; END IF;

  EXECUTE format(
    -- The DEFAULT is load-bearing: CREATE OR REPLACE cannot drop an existing
    -- parameter default, and the live signature carries one on p_cfo_note.
    'CREATE OR REPLACE FUNCTION public.cfo_decide_allocation_return(p_request_id uuid, p_decision text, p_cfo_note text DEFAULT NULL::text)
     RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS %L', src);
END
$do$;

-- ---------------------------------------------------------------------------
-- 5. Route 1 — cancel_tenant_and_return_landlord_float, same rule
--
-- Today six roles can cancel a tenant and pull their landlord's rent back:
-- cfo, manager, super_admin, coo, operations, financial_ops. That is 74 people.
-- It becomes the four. The v_is_system bypass for the cron is untouched.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE src text; before text;
BEGIN
  SELECT p.prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='cancel_tenant_and_return_landlord_float';

  IF src IS NULL THEN RAISE EXCEPTION 'cancel_tenant_and_return_landlord_float not found'; END IF;

  IF position('can_reverse_landlord_float' in src) > 0 THEN
    RAISE NOTICE 'cancel_tenant_and_return_landlord_float already patched, skipping';
    RETURN;
  END IF;

  before := src;
  src := replace(src,
'  IF NOT v_is_system AND NOT (public.has_role(v_caller,''cfo''::app_role)
       OR public.has_role(v_caller,''manager''::app_role)
       OR public.has_role(v_caller,''super_admin''::app_role)
       OR public.has_role(v_caller,''coo''::app_role)
       OR public.has_role(v_caller,''operations''::app_role)
       OR public.has_role(v_caller,''financial_ops''::app_role)) THEN
    RAISE EXCEPTION ''FORBIDDEN: only CFO / Finance Operations / COO / Operations may cancel a tenant and return float''
      USING ERRCODE = ''insufficient_privilege'';
  END IF;',
'  IF NOT v_is_system AND NOT public.can_reverse_landlord_float(v_caller) THEN
    RAISE EXCEPTION ''FORBIDDEN: only the CFO, Landlord Operations, the CTO or a Super Admin may cancel a tenant and return landlord float''
      USING ERRCODE = ''insufficient_privilege'';
  END IF;');
  IF src = before THEN RAISE EXCEPTION 'cancel role block anchor missing'; END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.cancel_tenant_and_return_landlord_float(p_rent_request_id uuid, p_reason text)
     RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS %L', src);
END
$do$;

-- ---------------------------------------------------------------------------
-- 6. The queue needs somewhere to record what a human decided
-- ---------------------------------------------------------------------------
ALTER TABLE public.landlord_float_idle_alerts
  ADD COLUMN IF NOT EXISTS acknowledged_by uuid,
  ADD COLUMN IF NOT EXISTS review_note     text,
  ADD COLUMN IF NOT EXISTS reviewed_by     uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at     timestamptz;

COMMENT ON COLUMN public.landlord_float_idle_alerts.review_note IS
  'What the CFO or Landlord Ops actually decided, and why. Free text, kept for '
  'the 27 pre-go-live cases that will only ever be resolved by a person.';

-- ---------------------------------------------------------------------------
-- 7. The read: one round trip for the whole console
--
-- Scopes:
--   'open'      still live and unresolved (the working list)
--   'backlog'   pre-go-live, held for manual review — the 27
--   'escalated' a payout WAS attempted and failed — FinOps, not a recall
--   'resolved'  closed, for the audit trail
--   'all'       everything
--
-- `can_act` comes back with the payload so the UI never has to guess whether
-- to render the buttons; the RPCs enforce it regardless.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landlord_float_idle_queue(
  p_scope text DEFAULT 'open',
  p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_scope  text := lower(COALESCE(NULLIF(btrim(p_scope),''),'open'));
  v_limit  int  := LEAST(GREATEST(COALESCE(p_limit,200), 1), 500);
  v_rows   jsonb;
  v_sum    jsonb;
BEGIN
  IF v_caller IS NULL OR NOT public.can_view_landlord_float_queue(v_caller) THEN
    RAISE EXCEPTION 'FORBIDDEN: the landlord float queue is restricted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_scope NOT IN ('open','backlog','escalated','resolved','all') THEN
    RAISE EXCEPTION 'Unknown scope %', v_scope USING ERRCODE = 'check_violation';
  END IF;

  WITH base AS (
    SELECT
      a.id, a.allocation_id, a.rent_request_id, a.agent_id, a.agent_name,
      a.landlord_name, a.tenant_name, a.amount, a.funded_at, a.deadline_at,
      a.hours_outstanding, a.severity, a.payout_attempted, a.outcome,
      a.acknowledged_at, a.acknowledged_by, a.review_note, a.reviewed_at,
      a.resolved_at, a.created_at,
      a.funded_at >= public.landlord_float_recall_go_live() AS in_scope_for_recall,
      rr.status  AS plan_status,
      rr.rent_amount,
      ap.phone   AS agent_phone,
      tp.phone   AS tenant_phone,
      al.status  AS allocation_status,
      COALESCE(al.paid_out_amount,0) AS paid_out_amount,
      lp.status     AS last_payout_status,
      lp.last_error AS last_payout_error,
      lp.attempts   AS payout_attempts,
      lp.created_at AS last_payout_at,
      EXISTS (SELECT 1 FROM public.agent_allocation_return_requests q
               WHERE q.allocation_id = a.allocation_id AND q.status = 'pending') AS return_requested,
      rv.full_name AS reviewed_by_name
    FROM public.landlord_float_idle_alerts a
    LEFT JOIN public.rent_requests rr ON rr.id = a.rent_request_id
    LEFT JOIN public.profiles ap ON ap.id = a.agent_id
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.profiles rv ON rv.id = a.reviewed_by
    LEFT JOIN public.agent_landlord_float_allocations al ON al.id = a.allocation_id
    LEFT JOIN LATERAL (
      SELECT p.status, p.last_error, p.attempts, p.created_at
      FROM public.landlord_payouts p
      WHERE p.rent_request_id = a.rent_request_id
      ORDER BY p.created_at DESC
      LIMIT 1
    ) lp ON TRUE
  ),
  scoped AS (
    SELECT * FROM base b
    WHERE CASE v_scope
      WHEN 'open'      THEN b.resolved_at IS NULL
                        AND COALESCE(b.outcome,'') NOT IN ('pre_go_live_manual_review','escalated_payout_attempted')
      WHEN 'backlog'   THEN b.resolved_at IS NULL AND b.outcome = 'pre_go_live_manual_review'
      WHEN 'escalated' THEN b.resolved_at IS NULL AND b.outcome = 'escalated_payout_attempted'
      WHEN 'resolved'  THEN b.resolved_at IS NOT NULL
      ELSE TRUE
    END
  )
  SELECT
    COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.hours_outstanding DESC), '[]'::jsonb)
  INTO v_rows
  FROM (SELECT * FROM scoped ORDER BY hours_outstanding DESC LIMIT v_limit) s;

  -- Counts are over everything unresolved, not the scoped page, so the tabs can
  -- carry badges without a second round trip.
  SELECT jsonb_build_object(
    'open_count',        COUNT(*) FILTER (WHERE resolved_at IS NULL AND COALESCE(outcome,'') NOT IN ('pre_go_live_manual_review','escalated_payout_attempted')),
    'open_amount',       COALESCE(SUM(amount) FILTER (WHERE resolved_at IS NULL AND COALESCE(outcome,'') NOT IN ('pre_go_live_manual_review','escalated_payout_attempted')),0),
    'backlog_count',     COUNT(*) FILTER (WHERE resolved_at IS NULL AND outcome = 'pre_go_live_manual_review'),
    'backlog_amount',    COALESCE(SUM(amount) FILTER (WHERE resolved_at IS NULL AND outcome = 'pre_go_live_manual_review'),0),
    'escalated_count',   COUNT(*) FILTER (WHERE resolved_at IS NULL AND outcome = 'escalated_payout_attempted'),
    'escalated_amount',  COALESCE(SUM(amount) FILTER (WHERE resolved_at IS NULL AND outcome = 'escalated_payout_attempted'),0),
    'resolved_count',    COUNT(*) FILTER (WHERE resolved_at IS NOT NULL),
    'idle_total',        COALESCE(SUM(amount) FILTER (WHERE resolved_at IS NULL),0),
    'oldest_funded_at',  MIN(funded_at) FILTER (WHERE resolved_at IS NULL)
  ) INTO v_sum
  FROM public.landlord_float_idle_alerts;

  RETURN jsonb_build_object(
    'as_of',    now(),
    'scope',    v_scope,
    'go_live',  public.landlord_float_recall_go_live(),
    'can_act',  public.can_reverse_landlord_float(v_caller),
    'summary',  v_sum,
    'rows',     v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_float_idle_queue(text, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.landlord_float_idle_queue(text, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. The actions
--
--   acknowledge  someone has seen it and is working it. Stops it reading as
--                untouched. Does not move money.
--   note         record a finding without deciding. Does not move money.
--   recall_now   pull the float back and unwind the Rent Plan, NOW, without
--                waiting for the 24-hour clock. This is the manual version of
--                what the cron does, and the only route by which a human can
--                act on the 27 pre-go-live cases.
--   dismiss      close the alert without moving anything: the money is fine,
--                or it is being handled elsewhere.
--
-- Every action demands a note of at least 10 characters. `recall_now` demands
-- can_reverse_landlord_float; the others accept anyone who can see the queue,
-- because "I called the agent, he is paying today" is worth recording and is
-- not a money movement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landlord_float_idle_action(
  p_alert_id uuid,
  p_action   text,
  p_note     text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_action text := lower(COALESCE(NULLIF(btrim(p_action),''),''));
  v_note   text := NULLIF(btrim(COALESCE(p_note,'')),'');
  v_alert  public.landlord_float_idle_alerts%ROWTYPE;
  v_res    jsonb;
BEGIN
  IF v_caller IS NULL OR NOT public.can_view_landlord_float_queue(v_caller) THEN
    RAISE EXCEPTION 'FORBIDDEN: the landlord float queue is restricted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_action NOT IN ('acknowledge','note','recall_now','dismiss') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown action.');
  END IF;

  IF v_note IS NULL OR char_length(v_note) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Please say what you found or decided (10+ characters). It is kept on the record.');
  END IF;

  SELECT * INTO v_alert FROM public.landlord_float_idle_alerts
   WHERE id = p_alert_id FOR UPDATE;
  IF v_alert.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Alert not found.');
  END IF;

  IF v_action IN ('recall_now','dismiss') AND v_alert.resolved_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'This case is already closed.');
  END IF;

  IF v_action = 'recall_now' THEN
    IF NOT public.can_reverse_landlord_float(v_caller) THEN
      RETURN jsonb_build_object('success', false, 'error',
        'Only the CFO, Landlord Operations, the CTO or a Super Admin may recall landlord float.');
    END IF;

    -- Same function the cron calls, same book-balancing, same fee reversal.
    v_res := public.cancel_tenant_and_return_landlord_float(
               v_alert.rent_request_id,
               format('Manual recall by Landlord Ops/CFO: %s', v_note));

    UPDATE public.landlord_float_idle_alerts
       SET outcome = 'manual_recalled', resolved_at = now(),
           review_note = v_note, reviewed_by = v_caller, reviewed_at = now(),
           acknowledged_at = COALESCE(acknowledged_at, now()),
           acknowledged_by = COALESCE(acknowledged_by, v_caller),
           updated_at = now()
     WHERE id = p_alert_id;

  ELSIF v_action = 'dismiss' THEN
    UPDATE public.landlord_float_idle_alerts
       SET outcome = 'dismissed_by_reviewer', resolved_at = now(),
           review_note = v_note, reviewed_by = v_caller, reviewed_at = now(),
           acknowledged_at = COALESCE(acknowledged_at, now()),
           acknowledged_by = COALESCE(acknowledged_by, v_caller),
           updated_at = now()
     WHERE id = p_alert_id;

  ELSE -- acknowledge | note
    UPDATE public.landlord_float_idle_alerts
       SET acknowledged_at = COALESCE(acknowledged_at, now()),
           acknowledged_by = COALESCE(acknowledged_by, v_caller),
           review_note = v_note, reviewed_by = v_caller, reviewed_at = now(),
           updated_at = now()
     WHERE id = p_alert_id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'landlord_float_idle_'||v_action, 'landlord_float_idle_alerts', p_alert_id,
          jsonb_build_object('rent_request_id', v_alert.rent_request_id,
                             'allocation_id', v_alert.allocation_id,
                             'amount', v_alert.amount, 'note', v_note,
                             'cancel_result', v_res));

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('landlord_float_idle.'||v_action, v_caller, 'rent_request', v_alert.rent_request_id,
          jsonb_build_object('alert_id', p_alert_id, 'amount', v_alert.amount, 'note', v_note));

  RETURN jsonb_build_object('success', true, 'action', v_action, 'cancel_result', v_res);
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_float_idle_action(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.landlord_float_idle_action(uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.landlord_float_idle_action(uuid, text, text) IS
  'Landlord Ops / CFO actions on an idle-float case. recall_now is the manual '
  'form of the 24-hour cron recall and is restricted to '
  'can_reverse_landlord_float; acknowledge/note/dismiss only record a decision.';
