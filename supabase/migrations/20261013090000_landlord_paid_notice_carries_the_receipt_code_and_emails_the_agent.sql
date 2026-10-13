-- The landlord-paid notice carries the receipt code, and reaches the agent by email.
--
-- WHAT WAS MISSING
--
-- When a landlord is paid, the landlord is told the receipt number AND code
-- ("Receipt No: WLR-101212 (Code: 4N2X3GDHAE)") and given a link. The agent, who
-- made the payout happen, was told only "Receipt No WLR-101212" - no code, no
-- link - and only by SMS. Measured 2026-10-12 over the last 14 days: 184 landlord
-- SMS, every one with number, code and link; 178 agent SMS, every one with the
-- number and none with the code or link.
--
-- WHAT THIS CHANGES in rent_plan_transition_notices_pending
--
--   1. The AP list (`agent_landlord_paid`) now carries `receipt_code`, so the SMS
--      can quote the same two identifiers the landlord was sent.
--
--   2. AP waits for the receipt. It is issued a moment AFTER the payout is
--      confirmed, and this list is read every ten minutes, so a plan could be
--      picked up in the gap and the SMS sent with no receipt at all - the one
--      thing this message is now for. AP is held until the receipt exists, with a
--      15 minute grace: a receipt that never arrives must not leave the agent
--      with no confirmation whatever, so after that it goes without the receipt
--      lines, exactly as it always has.
--
--   3. A new list, `agent_landlord_paid_email`: the same event, for the agent's
--      email. It is offered only when
--        - the receipt exists and is not reversed (the code is the point),
--        - the payout was in the last six hours (so this never mails history),
--        - the agent has an address that provably belongs to them
--          (resolve_owned_notification_email: never a phone-only placeholder,
--          never an address shared between accounts), and
--        - that plan has no row in email_send_log yet.
--
-- "NO ROW IN email_send_log" IS THE DEDUPLICATION
--
-- send-transactional-email writes a `pending` row for every email it accepts and
-- stores the template data on it; process-email-queue carries that data onto the
-- `sent` row. The edge function puts the plan id in the template data, so the
-- plan id is readable back out of the log. Any row at all means the mailer has
-- the message - queued, sent, suppressed or dead-lettered - so the plan is not
-- offered again. Deliberately NOT retried on `failed`: the queue retries inside
-- itself, and re-offering here would risk a second copy when it recovers.
--
-- The log is scanned ONCE per run (a single pass over the last eight hours), not
-- once per plan. Receipt and commission are looked up only for plans that still
-- owe a message, not for every payout since go-live.
--
-- BACKWARD COMPATIBLE. Every existing key is unchanged and `receipt_code` and the
-- new list are additions, so the edge function currently deployed keeps working
-- against this and simply ignores them until it is redeployed.
--
-- Patched from pg_get_functiondef rather than retyped, so the signature and the
-- parts this does not touch come from the database.

DO $patch$
DECLARE
  v_oid  oid;
  v_def  text;
  v_new  text;
  v_a    integer;
  v_b    integer;
  v_cte  text := $cte$
  -- The landlord-paid notice, by SMS and by email. See migration
  -- 20261013090000 for the reasoning behind each rule.
  emailed AS (
    -- Plans the mailer already has. One pass over a few hours of log, read as a
    -- set; the plan id is in the template data the edge function sends.
    SELECT DISTINCT e.metadata->'template_data'->>'rent_request_id' AS rent_request_id
      FROM public.email_send_log e
     WHERE e.template_name = 'agent-landlord-paid-receipt'
       AND e.created_at >= now() - interval '8 hours'
  ),
  due AS (
    -- Which of the paid plans still owe a message, and on which channel. Cheap:
    -- one unique-index probe and one set lookup each.
    SELECT p.*,
           NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                        WHERE s.idempotency_key = 'rent-plan-ap:'||p.rent_request_id::text) AS sms_due,
           (p.paid_at >= now() - interval '6 hours'
            AND NOT EXISTS (SELECT 1 FROM emailed m
                             WHERE m.rent_request_id = p.rent_request_id::text)) AS email_due
      FROM paid p
  ),
  ctx AS (
    -- Everything either message quotes, fetched ONCE per plan and only for the
    -- plans that owe something, so SMS and email read the same receipt and the
    -- same commission.
    SELECT d.rent_request_id, d.payout_id, d.paid_at, d.agent_id, d.landlord_name,
           d.rent_amount, d.instalment, d.period_label, d.repayment_starts_on,
           d.momo_ref, d.sms_due, d.email_due,
           ap.phone AS agent_phone, ap.full_name AS agent_name, tp.full_name AS tenant_name,
           rc.receipt_number, rc.receipt_code, cm.commission_ugx
      FROM due d
      JOIN public.profiles ap      ON ap.id = d.agent_id
      LEFT JOIN public.profiles tp ON tp.id = d.tenant_id
      LEFT JOIN LATERAL (
        SELECT r.receipt_number, r.receipt_code
          FROM public.landlord_payout_receipts r
         WHERE r.payout_id = d.payout_id AND r.reversed_at IS NULL
         LIMIT 1) rc ON true
      -- Only present when the commission leg actually exists in general_ledger.
      LEFT JOIN LATERAL (
        SELECT gl.amount AS commission_ugx
          FROM public.general_ledger gl
         WHERE gl.source_table = 'landlord_payouts' AND gl.source_id = d.payout_id
           AND gl.category = 'agent_commission_earned' AND gl.ledger_scope = 'wallet'
         LIMIT 1) cm ON true
     WHERE d.sms_due OR d.email_due
  ),
  ag AS (
    SELECT jsonb_agg(jsonb_build_object(
      'kind','agent_landlord_paid','rent_request_id',c.rent_request_id,
      'agent_id',c.agent_id,'agent_phone',c.agent_phone,'agent_name',c.agent_name,
      'landlord_name',c.landlord_name,
      'tenant_first_name',split_part(btrim(COALESCE(c.tenant_name,'')),' ',1),
      'rent_amount',c.rent_amount,'instalment',c.instalment,'period_label',c.period_label,
      'repayment_starts_on',c.repayment_starts_on,'momo_ref',c.momo_ref,
      'ref', upper(left(c.rent_request_id::text, 8)),
      'receipt_number',c.receipt_number,'receipt_code',c.receipt_code,
      'commission_ugx',c.commission_ugx
    ) ORDER BY c.repayment_starts_on) AS rows
    FROM ctx c
    WHERE c.sms_due
      AND COALESCE(btrim(c.agent_phone),'') <> ''
      -- Held for the receipt; after 15 minutes it goes without rather than not at all.
      AND (c.receipt_code IS NOT NULL OR c.paid_at < now() - interval '15 minutes')
  ),
  agem AS (
    SELECT jsonb_agg(jsonb_build_object(
      'kind','agent_landlord_paid_email','rent_request_id',c.rent_request_id,
      'agent_id',c.agent_id,'agent_email',em.email,'agent_name',c.agent_name,
      'landlord_name',c.landlord_name,'tenant_name',c.tenant_name,
      'rent_amount',c.rent_amount,'instalment',c.instalment,'period_label',c.period_label,
      'repayment_starts_on',c.repayment_starts_on,
      'ref', upper(left(c.rent_request_id::text, 8)),
      'receipt_number',c.receipt_number,'receipt_code',c.receipt_code,
      'paid_at',c.paid_at,'commission_ugx',c.commission_ugx
    ) ORDER BY c.paid_at) AS rows
    FROM ctx c
    -- Resolved only for plans that owe an email and have a receipt to quote.
    CROSS JOIN LATERAL (SELECT public.resolve_owned_notification_email(c.agent_id) AS email) em
    WHERE c.email_due
      AND c.receipt_code IS NOT NULL
      AND em.email IS NOT NULL
  ),
$cte$;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rent_plan_transition_notices_pending';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'rent_plan_transition_notices_pending not found'; END IF;

  v_def := pg_get_functiondef(v_oid);
  IF v_def LIKE '%agent_landlord_paid_email%' THEN
    RAISE NOTICE 'Already applied - the pending list already carries the AP email.';
    RETURN;
  END IF;

  -- 1. `paid` exposes when the payout was made (the six-hour window and the
  --    15-minute grace both run off it).
  IF (length(v_def) - length(replace(v_def, 'lp.id AS payout_id,', ''))) / length('lp.id AS payout_id,') <> 1 THEN
    RAISE EXCEPTION 'paid CTE anchor (lp.id AS payout_id,) not found exactly once';
  END IF;
  v_new := replace(v_def, 'lp.id AS payout_id,',
    E'lp.id AS payout_id,\n           COALESCE(lp.finops_disbursed_at, lp.disbursed_at) AS paid_at,');

  -- 2. The old `ag` CTE is replaced, whole, by emailed / due / ctx / ag / agem.
  v_a := strpos(v_new, E'  ag AS (\n');
  v_b := strpos(v_new, E'  quiet AS (\n');
  IF v_a = 0 OR v_b = 0 OR v_b < v_a THEN
    RAISE EXCEPTION 'ag / quiet CTE anchors not found in order (ag at %, quiet at %)', v_a, v_b;
  END IF;
  v_new := substr(v_new, 1, v_a - 1) || v_cte || substr(v_new, v_b);

  -- 3. The result carries the new list.
  v_def := v_new;
  v_new := replace(v_def,
    $o$'agent_landlord_paid', COALESCE((SELECT rows FROM ag), '[]'::jsonb)$o$,
    $o$'agent_landlord_paid', COALESCE((SELECT rows FROM ag), '[]'::jsonb),
    'agent_landlord_paid_email', COALESCE((SELECT rows FROM agem), '[]'::jsonb)$o$);
  IF v_new = v_def THEN RAISE EXCEPTION 'result anchor not found'; END IF;

  EXECUTE v_new;
END
$patch$;
