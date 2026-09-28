-- Give the transition notices what section 5 of the spec actually asks for.
--
-- WHAT WAS WRONG
--
-- The A1 message an agent gets when the CFO disburses landlord float said:
--
--   "UGX 100,000 landlord float is in your wallet to pay John Kibalama for
--    Aaron Gwokto. Please pay the landlord and submit the TID and receipt.
--    The tenant starts repaying the day after the landlord is paid.
--    Payouts run 06:00-22:00."
--
-- The spec says:
--
--   "UGX {rent_amount} landlord float has been sent to your wallet for
--    {landlord_name} ({tenant_name}).
--    Pay the landlord within 24 hours - by {deadline_time} on {deadline_date} -
--    or the float will be returned and the Rent Plan cancelled.
--    Payouts run 06:00-22:00. Ref {ref}."
--
-- THE MISSING SENTENCE IS THE WHOLE POINT OF THE MESSAGE. The 24-hour recall
-- is live: float that sits unpaid is taken back and the Rent Plan cancelled.
-- Agents were being asked to act without being told the deadline or the
-- consequence. The edge function said so in its own header - the sentence was
-- deliberately withheld while the recall was still Phase 4 - and nobody went
-- back for it when Phase 4 shipped.
--
-- WHAT THIS MIGRATION ADDS (data only; the wording lives in the edge function)
--
--   * `deadline_at`, `deadline_time`, `deadline_date` on A1, formatted in
--     Africa/Kampala here so the edge function never guesses a timezone. The
--     clock starts when the allocation is created, which IS the moment the CFO
--     disburses.
--   * `recall_active` on A1: false for plans funded before
--     `landlord_float_recall_go_live()`. Those are not governed by the timer,
--     and threatening a consequence that cannot happen to them would be a lie.
--   * `deadline_time` on the A3 warning, which the spec quotes.
--   * `ref` on every notice - the spec ends five of its six messages with one
--     and not a single message carried it.
--   * A NEW `agent_cancelled` list for A4. The spec has always required telling
--     the AGENT their float was taken back and the plan cancelled; only the
--     tenant was ever told. That message did not exist.
--
-- A2 IS DELIBERATELY UNTOUCHED. The spec lists it in the table but gives no
-- text for it, so the wording already in service stays. Inventing copy that
-- looks like a spec it is not in would be worse than leaving it visible.

CREATE OR REPLACE FUNCTION public.rent_plan_transition_notices_pending(p_lookback_hours integer DEFAULT 48)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
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
  paid AS (
    SELECT ev.related_entity_id AS rent_request_id,
           (ev.metadata->>'landlord_name') AS landlord_name,
           (ev.metadata->>'landlord_payout_id')::uuid AS payout_id,
           (ev.metadata->>'finops_momo_reference') AS momo_ref,
           rr.tenant_id, rr.rent_amount, rr.duration_days, rr.total_repayment,
           rr.repayment_starts_on,
           CASE WHEN lower(COALESCE(rr.repayment_frequency,'daily'))='weekly'
                THEN COALESCE(rr.daily_repayment,0)*7 ELSE COALESCE(rr.daily_repayment,0) END AS instalment,
           CASE WHEN lower(COALESCE(rr.repayment_frequency,'daily'))='weekly'
                THEN 'per week' ELSE 'per day' END AS period_label,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id
    FROM public.system_events ev
    JOIN public.rent_requests rr ON rr.id = ev.related_entity_id, since
    WHERE ev.event_type = 'rent_request_repaying_started'
      AND ev.created_at >= since.t
      AND rr.status = 'repaying'
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
  ag AS (
    SELECT jsonb_agg(jsonb_build_object(
      'kind','agent_landlord_paid','rent_request_id',p.rent_request_id,
      'agent_id',p.agent_id,'agent_phone',ap.phone,'agent_name',ap.full_name,
      'landlord_name',p.landlord_name,'tenant_first_name',split_part(btrim(COALESCE(tp.full_name,'')),' ',1),
      'rent_amount',p.rent_amount,'instalment',p.instalment,'period_label',p.period_label,
      'repayment_starts_on',p.repayment_starts_on,'momo_ref',p.momo_ref,
      'ref', upper(left(p.rent_request_id::text, 8)),
      'receipt_number',(SELECT r.receipt_number FROM public.landlord_payout_receipts r
                         WHERE r.payout_id = p.payout_id LIMIT 1),
      'commission_ugx',(SELECT gl.amount FROM public.general_ledger gl
                         WHERE gl.source_table='landlord_payouts' AND gl.source_id = p.payout_id
                           AND gl.category='agent_commission_earned' AND gl.ledger_scope='wallet'
                         LIMIT 1)
    ) ORDER BY p.repayment_starts_on) AS rows
    FROM paid p
    JOIN public.profiles ap ON ap.id = p.agent_id
    LEFT JOIN public.profiles tp ON tp.id = p.tenant_id
    WHERE COALESCE(btrim(ap.phone),'') <> ''
      AND NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                       WHERE s.idempotency_key = 'rent-plan-ap:'||p.rent_request_id::text)
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
    'agent_landlord_paid', COALESCE((SELECT rows FROM ag), '[]'::jsonb)
  );
$function$;
