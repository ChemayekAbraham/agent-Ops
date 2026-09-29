-- The 24-hour landlord-float recall runs as the system, not as a person.
--
-- MEASURED 2026-09-29: the first recall ever due (agent TIMOTHY CHRISTIAN
-- WANIAYE, UGX 100,000 for landlord John Kibalama, funded 2026-09-28 15:15
-- UTC) was attempted by the cron at 16:00 and recorded
-- `recall_failed: AUTH_REQUIRED`. The float stayed open, the Rent Plan stayed
-- funded, and the "float returned" SMS (A4) was never sent, because A4 is only
-- sent after a successful recall. 0 recalls have ever succeeded.
--
-- Why: cancel_tenant_and_return_landlord_float, with no signed-in user,
-- accepts only a system actor UUID in the `app.system_actor` GUC. The cron
-- (`select public.detect_idle_landlord_float();`) never supplies one, and no
-- system user exists. Borrowing a staff member's account instead was rejected:
-- an automatic job must not depend on a person's account (if the account is
-- removed or loses its role, the recall silently stops).
--
-- Fix: a genuine SYSTEM mode. The cancellation accepts a caller-less run only
-- when ALL of these hold:
--   · auth.uid() IS NULL                       — no signed-in user
--   · app.system_context = 'landlord_float_recall' (transaction-local, set by
--     detect_idle_landlord_float immediately before it calls the cancellation)
--   · session_user is not one of the API roles — every app, PostgREST and edge
--     function call connects as `authenticator`; pg_cron runs as `postgres`.
--     So no app user, anon caller or service-role client can reach it.
-- The actor columns it writes (agent_payment_status_set_by,
-- tenant_inactive_reviews.*_by, audit_logs.user_id, system_events.user_id) are
-- all nullable; the audit row already records actor_kind = 'system'.
--
-- Both functions are edited IN PLACE from their live definitions: each change
-- is an exact line replacement that must match exactly once, or the migration
-- aborts. Nothing else in either function changes.
--
-- Also: EXECUTE on the cancellation is revoked from anon. It could never pass
-- the auth check, but it never needed the grant either.

DO $mig$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  -- ── 1. cancel_tenant_and_return_landlord_float: accept the system context ─
  v_def := pg_get_functiondef('public.cancel_tenant_and_return_landlord_float'::regproc);
  v_old := $o$  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;$o$;
  v_new := $n$  -- The automatic 24-hour recall runs as the SYSTEM, not as a person
  -- (20260929231000). Reachable only with no signed-in user, the recall's own
  -- transaction-local context, and a non-API session (pg_cron runs as
  -- postgres; every app / PostgREST / edge call connects as authenticator).
  IF v_caller IS NULL AND NOT v_is_system
     AND current_setting('app.system_context', true) = 'landlord_float_recall'
     AND session_user NOT IN ('authenticator', 'anon', 'authenticated', 'service_role') THEN
    v_is_system := true;
  END IF;

  IF v_caller IS NULL AND NOT v_is_system THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;$n$;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'cancel_tenant_and_return_landlord_float: auth block not found exactly once — live definition changed, aborting';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  -- ── 1b. cancel_tenant_and_return_landlord_float: reverse only what was ────
  --        actually booked out for this plan.
  --
  -- MEASURED 2026-09-29 on the same plan: it was funded twice (13:18, cancelled
  -- 13:36; re-funded 15:15). fund-agent-landlord-float keys its ledger group on
  -- `fund-agent-landlord-float:<rent_request>:float`, so the re-funding got the
  -- OLD group back and posted nothing — the second float was never booked. The
  -- cancellation then (a) linked its reversal to the first-ever funding group,
  -- already used by the first cancellation → unique violation on
  -- agent_tenant_float_reversals.original_transaction_group, and (b) would have
  -- credited treasury for money the books never took out. 6 plans are in that
  -- state (fixed separately, with approval).
  --
  -- Now: the ledger reversal is capped at the plan's NET booked disbursement
  -- (rent_disbursement cash_out − cash_in, on the rent request and on its
  -- self-managed funding lines), and links to the earliest funding group not
  -- already reversed. The operational cancel — allocation cancelled, lifetime
  -- float counter reduced, plan cancelled — is unchanged.
  v_def := pg_get_functiondef('public.cancel_tenant_and_return_landlord_float'::regproc);
  FOR v_old, v_new IN
    SELECT o, n FROM (VALUES
      ($o$  v_fee_rev    jsonb;
BEGIN$o$,
       $n$  v_fee_rev    jsonb;
  v_rev         numeric;
  v_booked_left numeric := 0;
BEGIN$n$),
      ($o$  v_agent := COALESCE(v_rr.assigned_agent_id, v_rr.agent_id);
$o$,
       $n$  v_agent := COALESCE(v_rr.assigned_agent_id, v_rr.agent_id);

  -- What the books actually took out for this plan and have not yet put back
  -- (20260929231000). A float that was never booked is never reversed.
  SELECT COALESCE(SUM(CASE WHEN gl.direction = 'cash_out' THEN gl.amount ELSE -gl.amount END), 0)
    INTO v_booked_left
    FROM public.general_ledger gl
   WHERE gl.category = 'rent_disbursement'
     AND ((gl.source_table = 'rent_requests' AND gl.source_id = p_rent_request_id)
       OR (gl.source_table = 'partner_self_funding_lines'
           AND gl.source_id IN (SELECT l.id FROM public.partner_self_funding_lines l
                                 WHERE l.rent_request_id = p_rent_request_id)));
$n$),
      ($o$    IF COALESCE(v_alloc.remaining_amount, 0) > 0 THEN
$o$,
       $n$    v_rev := LEAST(COALESCE(v_alloc.remaining_amount, 0), GREATEST(v_booked_left, 0));
    IF v_rev > 0 THEN
$n$),
      ($o$'user_id', v_alloc.agent_id, 'amount', v_alloc.remaining_amount, 'direction', 'cash_in',$o$,
       $n$'user_id', v_alloc.agent_id, 'amount', v_rev, 'direction', 'cash_in',$n$),
      ($o$'user_id', v_alloc.agent_id, 'amount', v_alloc.remaining_amount, 'direction', 'cash_out',$o$,
       $n$'user_id', v_alloc.agent_id, 'amount', v_rev, 'direction', 'cash_out',$n$),
      ($o$      v_returned := v_returned + v_alloc.remaining_amount;
$o$,
       $n$      v_booked_left := v_booked_left - v_rev;
$n$),
      ($o$              AND gl.direction    = 'cash_out'
            ORDER BY gl.created_at ASC$o$,
       $n$              AND gl.direction    = 'cash_out'
              AND NOT EXISTS (SELECT 1 FROM public.agent_tenant_float_reversals x
                               WHERE x.original_transaction_group = gl.transaction_group_id)
            ORDER BY gl.created_at ASC$n$),
      ($o$        v_group, v_alloc.remaining_amount, 0,
$o$,
       $n$        v_group, v_rev, 0,
$n$),
      ($o$    -- Cancelling the allocation is what drops the agent's derived float balance.
$o$,
       $n$    v_returned := v_returned + COALESCE(v_alloc.remaining_amount, 0);

    -- Cancelling the allocation is what drops the agent's derived float balance.
$n$)
    ) AS t(o, n)
  LOOP
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'cancel_tenant_and_return_landlord_float: fragment not found exactly once — aborting: %', left(v_old, 80);
    END IF;
    v_def := replace(v_def, v_old, v_new);
  END LOOP;
  EXECUTE v_def;

  -- ── 2. detect_idle_landlord_float: mark the transaction as the recall ─────
  v_def := pg_get_functiondef('public.detect_idle_landlord_float'::regproc);
  v_old := $o$          PERFORM set_config('app.system_actor', COALESCE(v_actor::text, ''), true);$o$;
  v_new := $n$          PERFORM set_config('app.system_actor', COALESCE(v_actor::text, ''), true);
          PERFORM set_config('app.system_context', 'landlord_float_recall', true);$n$;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'detect_idle_landlord_float: system_actor line not found exactly once — live definition changed, aborting';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.cancel_tenant_and_return_landlord_float(uuid, text) FROM anon;
