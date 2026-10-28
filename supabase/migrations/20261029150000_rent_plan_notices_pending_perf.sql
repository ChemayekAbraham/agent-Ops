-- Speed up rent_plan_transition_notices_pending so the notice drain stays
-- inside the 8s authenticated statement_timeout.
--
-- Measured 2026-10-27 (pg_stat_statements since 12:54 UTC, PostgREST calls):
-- 45 calls, mean 2862 ms, max 7992 ms. A timeout skips the Rent Plan SMS and
-- email for that ten-minute run.
--
-- WHAT WAS SLOW
--
-- `paid` reads every landlord payout since landlord_float_recall_go_live()
-- (2026-09-27 21:00 UTC) with
--
--   COALESCE(finops_disbursed_at, disbursed_at) >= go_live
--
-- That expression cannot use a btree. The existing
-- idx_landlord_payouts_disbursed_at_desc is the same expression but only
-- WHERE status <> 'failed', which this query does not say, so the planner
-- seq-scans landlord_payouts. Downstream, T1 and the agent SMS then probe
-- sms_delivery_log once per plan since go-live, including plans that were
-- messaged weeks ago.
--
-- WHY THE WINDOW IS NOT p_lookback_hours
--
-- T1 and the agent "landlord paid" SMS do not expire. Migration
-- 20261005150000 removed the rolling lookback on purpose: a missed send must
-- still go out after 48 hours. Checked 2026-10-27: 4 agent SMS
-- (idempotency key rent-plan-ap:) were still unsent and older than 168 hours.
-- Cutting `paid` at now() - lookback would drop those notices. The email list
-- is the only branch with a clock, and it is six hours
-- (agent_landlord_paid_email / email_due), with the dedupe read looking back
-- eight hours.
--
-- Equivalent bound, proved against the three consumers of `paid`
-- (tenant_welcome, agent_landlord_paid, agent_landlord_paid_email):
--
--   * A payout whose disbursement stamp is inside the last six hours can
--     still owe an email, so it stays. The filter is on each stamp
--     (finops_disbursed_at >= X OR disbursed_at >= X), X = greatest(go_live,
--     now() - 6 hours), so either btree can serve it. The original
--     COALESCE(...) >= go_live predicate is kept, so a row whose two stamps
--     disagree is not newly included. On 2026-10-27, 17 payouts had
--     disagreeing stamps and 0 crossed the go-live boundary
--     (coalesce_not_or = 0, or_not_coalesce = 0).
--   * A payout older than six hours stays only when rent-plan-t1: or
--     rent-plan-ap: is still absent. Once both keys exist, T1 is excluded by
--     its NOT EXISTS, the agent SMS is excluded by sms_due, and the email is
--     excluded by paid_at >= now() - 6 hours. DISTINCT ON still sees the
--     latest disbursement whenever that latest row can appear in a list.
--
-- Indexes added only where missing:
--
--   * sms_delivery_log(idempotency_key) already exists as the partial unique
--     index uq_sms_delivery_log_idempotency_key (WHERE idempotency_key IS NOT
--     NULL). Equality probes use it. Not recreated.
--   * email_send_log(template_name, created_at) — the eight-hour dedupe read.
--   * landlord_payouts(finops_disbursed_at) and (disbursed_at).
--   * agent_landlord_float_allocations(created_at) WHERE status IN
--     ('open','partially_paid') — the A1 scan.
--
-- CREATE INDEX, not CONCURRENTLY: a migration runs inside a transaction.
-- email_send_log is about 220k rows / 128MB, so its build takes a ShareLock
-- that blocks inserts for the build. On a busy database, create
-- idx_email_send_log_template_created CONCURRENTLY by hand first; the
-- IF NOT EXISTS below then does nothing. landlord_payouts and
-- agent_landlord_float_allocations are about 1.6k rows.
--
-- Signature, SECURITY DEFINER, STABLE, search_path and the JSON keys are
-- unchanged. EXECUTE stays with service_role only (the 2026-10-18 close).
-- CREATE OR REPLACE keeps the existing ACL; the REVOKE / GRANT re-states it.

CREATE INDEX IF NOT EXISTS idx_email_send_log_template_created
  ON public.email_send_log (template_name, created_at);

CREATE INDEX IF NOT EXISTS idx_landlord_payouts_finops_disbursed_at
  ON public.landlord_payouts (finops_disbursed_at);

CREATE INDEX IF NOT EXISTS idx_landlord_payouts_disbursed_at
  ON public.landlord_payouts (disbursed_at);

CREATE INDEX IF NOT EXISTS idx_alfa_open_created_at
  ON public.agent_landlord_float_allocations (created_at)
  WHERE status IN ('open', 'partially_paid');

ANALYZE public.email_send_log;
ANALYZE public.landlord_payouts;
ANALYZE public.agent_landlord_float_allocations;

CREATE OR REPLACE FUNCTION public.rent_plan_transition_notices_pending(p_lookback_hours integer DEFAULT 48)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH since AS (SELECT now() - make_interval(hours => GREATEST(1, LEAST(COALESCE(p_lookback_hours,48), 168))) AS t),
  a1 AS (
    SELECT jsonb_agg(jsonb_build_object(
      'kind','agent_float_funded','rent_request_id',x.rent_request_id,
      'agent_id',x.agent_id,'agent_phone',x.agent_phone,'agent_name',x.agent_name,
      'landlord_name',x.landlord_name,'tenant_name',x.tenant_name,'rent_amount',x.rent_amount,
      'ref', upper(left(x.rent_request_id::text, 8)),
      'deadline_at', x.deadline_at,
      'deadline_time', to_char(x.deadline_at AT TIME ZONE 'Africa/Kampala', 'HH24:MI'),
      'deadline_date', to_char(x.deadline_at AT TIME ZONE 'Africa/Kampala', 'FMDay DD FMMonth'),
      'recall_active', (x.created_at >= public.landlord_float_recall_go_live())
    ) ORDER BY x.created_at) AS rows
    FROM (
      SELECT rr.id AS rent_request_id, al.agent_id, ap.phone AS agent_phone,
             ap.full_name AS agent_name, COALESCE(al.landlord_name, ll.name) AS landlord_name,
             tp.full_name AS tenant_name, rr.rent_amount, al.created_at,
             al.created_at + interval '24 hours' AS deadline_at
      FROM public.agent_landlord_float_allocations al
      JOIN public.rent_requests rr ON rr.id = al.rent_request_id
      JOIN public.profiles ap      ON ap.id = al.agent_id
      LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
      LEFT JOIN public.landlords ll ON ll.id = al.landlord_id, since
      WHERE al.created_at >= since.t AND rr.status = 'funded'
        AND al.status IN ('open','partially_paid')
        AND COALESCE(btrim(ap.phone),'') <> ''
        AND NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                         WHERE s.idempotency_key = 'rent-plan-a1:'||rr.id::text)
    ) x
  ),

  -- Recent disbursements, plus older ones that still owe an SMS. See
  -- 20261029150000. T1 / agent SMS do not expire; the email list is six hours.
  paid AS MATERIALIZED (
    SELECT DISTINCT ON (lp.rent_request_id)
           lp.rent_request_id AS rent_request_id,
           COALESCE(lp.landlord_name, ll.name) AS landlord_name,
           lp.id AS payout_id,
           COALESCE(lp.finops_disbursed_at, lp.disbursed_at) AS paid_at,
           lp.finops_momo_reference AS momo_ref,
           rr.tenant_id, rr.rent_amount, rr.duration_days, rr.total_repayment,
           rr.repayment_starts_on,
           CASE WHEN lower(COALESCE(rr.repayment_frequency,'daily'))='weekly'
                THEN COALESCE(rr.daily_repayment,0)*7 ELSE COALESCE(rr.daily_repayment,0) END AS instalment,
           CASE WHEN lower(COALESCE(rr.repayment_frequency,'daily'))='weekly'
                THEN 'per week' ELSE 'per day' END AS period_label,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id
    FROM (
      SELECT p.*
        FROM public.landlord_payouts p
       WHERE p.finops_disbursed_at >= GREATEST(public.landlord_float_recall_go_live(), now() - interval '6 hours')
          OR p.disbursed_at >= GREATEST(public.landlord_float_recall_go_live(), now() - interval '6 hours')
      UNION ALL
      SELECT p.*
        FROM public.landlord_payouts p
       WHERE (p.finops_disbursed_at >= public.landlord_float_recall_go_live()
           OR p.disbursed_at >= public.landlord_float_recall_go_live())
         AND COALESCE(p.finops_disbursed_at, p.disbursed_at) < now() - interval '6 hours'
         AND COALESCE(p.finops_disbursed_at, p.disbursed_at) >= public.landlord_float_recall_go_live()
         AND (
              NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                           WHERE s.idempotency_key = 'rent-plan-t1:'||p.rent_request_id::text)
           OR NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                           WHERE s.idempotency_key = 'rent-plan-ap:'||p.rent_request_id::text)
         )
    ) lp
    JOIN public.rent_requests rr ON rr.id = lp.rent_request_id
    LEFT JOIN public.landlords ll ON ll.id = lp.landlord_id
    WHERE COALESCE(lp.finops_disbursed_at, lp.disbursed_at) >= public.landlord_float_recall_go_live()
      AND rr.status IN ('funded','repaying')
      AND (rr.repayment_starts_on IS NULL
           OR rr.repayment_starts_on >= (public.landlord_float_recall_go_live())::date)
    ORDER BY lp.rent_request_id,
             COALESCE(lp.finops_disbursed_at, lp.disbursed_at) DESC
  ),
  t1 AS (
    SELECT jsonb_agg(jsonb_build_object(
      'kind','tenant_welcome','rent_request_id',p.rent_request_id,'tenant_id',p.tenant_id,
      'tenant_phone',tp.phone,
      'tenant_first_name',split_part(btrim(COALESCE(tp.full_name,'')),' ',1),
      'landlord_name',p.landlord_name,'rent_amount',p.rent_amount,
      'instalment',p.instalment,'period_label',p.period_label,
      'duration_days',p.duration_days,'total_repayment',p.total_repayment,
      'repayment_starts_on',p.repayment_starts_on,
      'agent_name',ap.full_name,'agent_phone',ap.phone,
      'ref', upper(left(p.rent_request_id::text, 8))
    ) ORDER BY p.repayment_starts_on) AS rows
    FROM paid p
    JOIN public.profiles tp ON tp.id = p.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = p.agent_id
    WHERE COALESCE(btrim(tp.phone),'') <> ''
      AND NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                       WHERE s.idempotency_key = 'rent-plan-t1:'||p.rent_request_id::text)
  ),

  -- The landlord-paid notice, by SMS and by email. See migration
  -- 20261013090000 for the reasoning behind each rule.
  emailed AS MATERIALIZED (
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
  quiet AS (
    SELECT (EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala')) < 6
         OR EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala')) >= 22) AS is_quiet
  ),
  nudge AS (
    SELECT jsonb_agg(jsonb_build_object(
      'kind', CASE WHEN a.severity='warning' THEN 'agent_warning' ELSE 'agent_reminder' END,
      'rent_request_id',a.rent_request_id,'agent_id',a.agent_id,'agent_phone',ap.phone,
      'agent_name',a.agent_name,'landlord_name',a.landlord_name,'tenant_name',a.tenant_name,
      'amount',a.amount,'deadline_at',a.deadline_at,'severity',a.severity,
      'ref', upper(left(a.rent_request_id::text, 8)),
      'deadline_time', to_char(a.deadline_at AT TIME ZONE 'Africa/Kampala', 'HH24:MI'),
      'deadline_date', to_char(a.deadline_at AT TIME ZONE 'Africa/Kampala', 'FMDay DD FMMonth'),
      'hours_left', GREATEST(0, round(EXTRACT(EPOCH FROM (a.deadline_at - now()))/3600.0, 1))
    ) ORDER BY a.deadline_at) AS rows
    FROM public.landlord_float_idle_alerts a
    JOIN public.profiles ap ON ap.id = a.agent_id
    CROSS JOIN quiet
    WHERE a.resolved_at IS NULL
      AND NOT quiet.is_quiet
      AND a.severity IN ('reminder','warning')
      AND a.funded_at >= public.landlord_float_recall_go_live()
      AND COALESCE(btrim(ap.phone),'') <> ''
      AND NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                       WHERE s.idempotency_key = 'rent-plan-'||a.severity||':'||a.rent_request_id::text)
  ),
  cancelled AS (
    SELECT jsonb_agg(jsonb_build_object(
      'kind','tenant_cancelled','rent_request_id',a.rent_request_id,
      'tenant_id',rr.tenant_id,'tenant_phone',tp.phone,
      'tenant_first_name',split_part(btrim(COALESCE(tp.full_name,'')),' ',1),
      'rent_amount',COALESCE(NULLIF(rr.rent_amount,0), a.amount),'landlord_name',a.landlord_name,
      'ref', upper(left(a.rent_request_id::text, 8))
    ) ORDER BY a.resolved_at) AS rows
    FROM public.landlord_float_idle_alerts a
    JOIN public.rent_requests rr ON rr.id = a.rent_request_id
    JOIN public.profiles tp ON tp.id = rr.tenant_id
    WHERE a.outcome IN ('auto_recalled','manual_recalled')
      AND rr.status = 'cancelled'
      AND COALESCE(btrim(tp.phone),'') <> ''
      AND NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                       WHERE s.idempotency_key = 'rent-plan-t2:'||a.rent_request_id::text)
  ),
  agent_cancelled AS (
    SELECT jsonb_agg(jsonb_build_object(
      'kind','agent_cancelled','rent_request_id',a.rent_request_id,
      'agent_id',a.agent_id,'agent_phone',ap.phone,'agent_name',a.agent_name,
      'landlord_name',a.landlord_name,
      'tenant_name',COALESCE(a.tenant_name, tp.full_name),
      'rent_amount',COALESCE(NULLIF(rr.rent_amount,0), a.amount),
      'ref', upper(left(a.rent_request_id::text, 8))
    ) ORDER BY a.resolved_at) AS rows
    FROM public.landlord_float_idle_alerts a
    JOIN public.rent_requests rr ON rr.id = a.rent_request_id
    JOIN public.profiles ap ON ap.id = a.agent_id
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    WHERE a.outcome IN ('auto_recalled','manual_recalled')
      AND rr.status = 'cancelled'
      AND COALESCE(btrim(ap.phone),'') <> ''
      AND NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                       WHERE s.idempotency_key = 'rent-plan-a4:'||a.rent_request_id::text)
  )
  SELECT jsonb_build_object(
    'as_of', now(),
    'agent_nudge',      COALESCE((SELECT rows FROM nudge), '[]'::jsonb),
    'tenant_cancelled', COALESCE((SELECT rows FROM cancelled), '[]'::jsonb),
    'agent_cancelled',  COALESCE((SELECT rows FROM agent_cancelled), '[]'::jsonb),
    'agent_float_funded',  COALESCE((SELECT rows FROM a1), '[]'::jsonb),
    'tenant_welcome',      COALESCE((SELECT rows FROM t1), '[]'::jsonb),
    'agent_landlord_paid', COALESCE((SELECT rows FROM ag), '[]'::jsonb),
    'agent_landlord_paid_email', COALESCE((SELECT rows FROM agem), '[]'::jsonb)
  );
$function$;

REVOKE ALL ON FUNCTION public.rent_plan_transition_notices_pending(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rent_plan_transition_notices_pending(integer) FROM anon;
REVOKE ALL ON FUNCTION public.rent_plan_transition_notices_pending(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rent_plan_transition_notices_pending(integer) TO service_role;

COMMENT ON FUNCTION public.rent_plan_transition_notices_pending(integer) IS
  'Work list for the Rent Plan transition notice drain. Read-only. paid keeps every disbursement since landlord_float_recall_go_live that can still produce a notice: the last six hours (email) plus older plans still missing rent-plan-t1 or rent-plan-ap. JSON keys and idempotency keys are unchanged.';
