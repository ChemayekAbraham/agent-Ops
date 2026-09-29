-- Collection waits for the landlord again — but only where the recall can act.
--
-- WHAT WAS WRONG
--
-- On 2026-09-21 the landlord-paid gate was removed from the collection path,
-- in three places, with the same note in each:
--
--   "Landlord-paid gate REMOVED (2026-09-21, business decision)"
--
--     public.agent_allocate_tenant_payment      the agent's collection RPC
--     supabase/functions/tenant-pay-rent        tenant wallet / auto-collect
--     src/components/agent/TenantProfileView    `const awaitingLandlord = false`
--
-- On 2026-09-25 the 24-hour landlord float recall went in. From then on a plan
-- whose landlord is not paid within 24 hours is CANCELLED automatically and the
-- float returned. The two changes contradict each other: for a whole day the
-- platform will take repayments from a tenant, and pay the agent 10% commission
-- on them, against a Rent Plan it is about to unwind. The tenant ends up having
-- paid for rent their landlord never received.
--
-- The September 21 decision was taken four days before the recall existed. It
-- was not wrong then. It is wrong now.
--
-- MEASURED 2026-09-29, live plans (repaying/funded/disbursed/active):
--
--   65 plans carry an open landlord float allocation
--   UGX 23,792,727 of landlord money never delivered
--   26 of those plans have ALREADY collected UGX 6,363,938 from tenants
--   paid_out_amount = 0 on all 65 — not one shilling reached a landlord
--
-- WHY THIS GATE IS SCOPED, AND NOT TOTAL
--
-- 63 of those 65 were funded before `landlord_float_recall_go_live()`
-- (2026-09-28 00:00 Kampala). The recall itself refuses to touch them — it
-- parks them as `pre_go_live_manual_review` precisely because nobody has
-- established what happened to that money. Blocking them here would cut 26
-- agents off from tenants they have been collecting from since April, over a
-- backlog this migration cannot resolve and should not pretend to.
--
-- So the gate uses the recall's OWN go-live function as its boundary. It covers
-- exactly the plans the recall will act on, which is exactly the set where
-- collecting first and cancelling later is possible. Today that is 2 plans.
-- The backlog of 63 is a separate piece of work with a human in it; see
-- docs/landlord-float-backlog-triage.md.
--
-- The window a gated plan can sit in is at most 24 hours: pay the landlord and
-- collection opens immediately, or the recall cancels the plan and there is
-- nothing to collect. No agent waits longer than a day.

-- 1. One definition of "waiting for the landlord" ---------------------------
--
-- Used by the RPC below, by the tenant-pay-rent edge function and by the agent
-- app, so the button, the tenant's own wallet payment and the ledger can never
-- disagree about whether this plan is collectable.
CREATE OR REPLACE FUNCTION public.rent_plan_awaiting_landlord(p_rent_request_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.agent_landlord_float_allocations al
     WHERE al.rent_request_id = p_rent_request_id
       AND al.status IN ('open', 'partially_paid')
       -- A part-paid landlord has had money reach them; that is a FinOps
       -- shortfall to chase, not a reason to freeze the tenant's plan.
       AND COALESCE(al.paid_out_amount, 0) = 0
       -- Only plans the 24-hour recall can actually cancel.
       AND al.created_at >= public.landlord_float_recall_go_live()
  );
$function$;

COMMENT ON FUNCTION public.rent_plan_awaiting_landlord(uuid) IS
  'True when a Rent Plan has landlord float still sitting with the agent, none '
  'of it paid out, and the plan is new enough for the 24-hour recall to cancel '
  'it. Collection is closed while this is true: taking repayment on a plan that '
  'is about to be unwound means the tenant paid for rent the landlord never '
  'received. Plans funded before landlord_float_recall_go_live() are excluded — '
  'the recall will not cancel them, so this gate must not block them either.';

GRANT EXECUTE ON FUNCTION public.rent_plan_awaiting_landlord(uuid) TO authenticated, service_role;

-- 2. The agent's collection RPC refuses while the landlord is unpaid --------
--
-- Applied as an anchored patch: the function is long and every other line of it
-- — ownership, idempotency, partial-payment accounting, day attribution — is
-- correct and untouched. The gate goes back exactly where it was taken out,
-- after the ownership checks (so a stranger still gets NOT_YOUR_TENANT) and
-- after the idempotency replay (so a double tap on an already-accepted payment
-- still replays cleanly instead of erroring).
DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  SELECT prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_allocate_tenant_payment';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'agent_allocate_tenant_payment not found';
  END IF;

  IF v_src LIKE '%AWAITING_LANDLORD_PAYMENT%' THEN
    RAISE NOTICE 'Already applied - the landlord gate is already in place.';
    RETURN;
  END IF;

  v_new := replace(v_src,
$anchor$  -- Landlord-paid gate REMOVED (2026-09-21, business decision): tenant
  -- repayments are accepted even when the landlord float released to the agent
  -- has not yet reached the landlord. Landlord settlement is tracked separately
  -- via agent_landlord_float_allocations.$anchor$,
$repl$  -- Landlord-paid gate RESTORED (2026-09-29), scoped to the recall regime.
  -- The 24-hour recall cancels this plan if the landlord is not paid, so a
  -- collection taken now would be a repayment against a plan about to be
  -- unwound, with commission already paid on it.
  IF public.rent_plan_awaiting_landlord(p_rent_request_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'AWAITING_LANDLORD_PAYMENT',
      'error', 'The landlord for this Rent Plan has not been paid yet. Pay the landlord first - collection opens the moment the landlord is paid.');
  END IF;$repl$);

  IF v_new = v_src THEN
    RAISE EXCEPTION 'anchor not found in agent_allocate_tenant_payment - the 2026-09-21 comment block has changed';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.agent_allocate_tenant_payment(
       p_agent_id uuid,
       p_tenant_id uuid,
       p_rent_request_id uuid,
       p_amount numeric,
       p_notes text DEFAULT NULL::text,
       p_partial_confirmed boolean DEFAULT false,
       p_partial_reason text DEFAULT NULL::text,
       p_client_ref uuid DEFAULT NULL::uuid)
     RETURNS jsonb
     LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public''
     AS %L', v_new);
END
$patch$;
