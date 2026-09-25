-- Phase 3 — repayment starts when the landlord has actually been paid
--
-- Spec: docs/rent-plan-new-flow-full-report.md section 8, Phase 3.
-- Items 12, 15 and 17 are here. Items 11 and 13 (the two SMS) are the edge
-- function `rent-plan-transition-notices`. Item 14 is "change nothing", and
-- item 16 is deliberately deferred — see the note at the end.
--
-- NOTHING IS BACKFILLED. No existing plan has its status or its
-- repayment_starts_on rewritten, and no historical day is pinned. Every change
-- here takes effect on the next payout dispatch.
--
-- Ledger impact: none. Nothing in this migration posts to general_ledger,
-- touches ledger_account_map or ledger_category_allowlist, or changes what
-- post_landlord_payout_finops_commission pays. The 1% stays exactly where it
-- is, firing at `awaiting_agent_receipt`, deliberately a little later than the
-- status flip below.

-- ---------------------------------------------------------------------------
-- 12. The repaying gate
--
-- Until now a plan became `repaying` on its FIRST COLLECTION, and
-- `repayment_starts_on` was stamped at funding + 1 regardless of when the
-- landlord was actually paid. A plan funded on Monday whose landlord was paid
-- on Thursday was therefore billed for Tuesday, Wednesday and Thursday — three
-- days no agent could have collected, written permanently into a bill that is
-- immutable by design. That is what produced the phantom day-one arrears on
-- Faizal Kayondo and Hamiss Mutyaba.
--
-- Measured before applying, over the 89 plans sitting at `funded`: 41 have a
-- dispatched payout, and 19 of those 41 carry a repayment_starts_on EARLIER
-- than the day their payout was dispatched. The bug is live, not theoretical.
--
-- The trigger point is `awaiting_agent_receipt` -- the moment FinOps records
-- that the landlord has ACTUALLY been paid -- and not `pending_merchant_payout`.
--
-- An earlier draft of this used dispatch-to-merchant. That was wrong, and the
-- data says so plainly. Of the payouts sitting at `pending_merchant_payout`:
-- 0 have finops_disbursed_at, 0 have a finops_momo_reference, 0 have
-- disbursed_at. Nothing has reached the landlord. A payout can sit with a
-- merchant indefinitely, and asking a tenant to start repaying rent their
-- landlord has not received is indefensible -- as is recalling float for a
-- payment that never actually went out.
--
-- `awaiting_agent_receipt` is set inside approve-withdrawal after FinOps
-- disburses, stamping finops_disbursed_at, disbursed_at and the MoMo reference
-- that proves the payment. The outstanding "receipt" is the agent's paperwork,
-- not the money. 959 payouts rest there against 85 `completed`, so gating on
-- `completed` would strand roughly 92% of plans.
--
-- This also puts the status flip, the allocation's paid_out_amount and the
-- agent's 1% commission on the same event, which is what they always should
-- have shared: all three mean "the landlord has the money".
--
-- Guards on the trigger:
--   * acts only on a plan still at `funded`, so a second payout on the same
--     plan can never move a date that is already in use;
--   * wrapped so a failure can never block a payout — a missed status flip is
--     recoverable, a blocked landlord payment is not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_repaying_on_landlord_paid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_plan     uuid;
  v_today    date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_updated  int  := 0;
BEGIN
  -- The WHEN clause on the trigger already restricts NEW.status to the
  -- dispatch set. Here we only need to ignore a no-op status rewrite.
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  v_plan := NEW.rent_request_id;

  -- Fall back to the tenant, exactly as apply_landlord_payout_to_allocation
  -- does, for payouts raised without a rent_request_id.
  IF v_plan IS NULL AND NEW.tenant_id IS NOT NULL THEN
    SELECT rr.id INTO v_plan
    FROM public.rent_requests rr
    WHERE rr.tenant_id = NEW.tenant_id
      AND rr.status IN ('funded','disbursed','approved')
    ORDER BY rr.funded_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_plan IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    UPDATE public.rent_requests
       SET status              = 'repaying',
           repayment_starts_on = v_today + 1,
           updated_at          = now()
     WHERE id = v_plan
       AND status IN ('funded','disbursed','approved');

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated > 0 THEN
      INSERT INTO public.system_events (
        event_type, user_id, related_entity_type, related_entity_id, metadata
      ) VALUES (
        'rent_request_repaying_started',
        NEW.agent_id,
        'rent_request',
        v_plan,
        jsonb_build_object(
          'landlord_payout_id',  NEW.id,
          'landlord_payout_status', NEW.status,
          'landlord_name',       NEW.landlord_name,
          'amount',              NEW.amount,
          'finops_momo_reference', NEW.finops_momo_reference,
          'landlord_paid_on',    v_today,
          'repayment_starts_on', v_today + 1,
          'trigger',             'start_repaying_on_landlord_paid'
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never block a landlord payout because the status flip failed.
    RAISE WARNING 'start_repaying_on_landlord_paid failed for plan %: %', v_plan, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

-- IMPORTANT, found while testing. A trigger named
-- trg_promote_repaying_from_landlord_payout already existed: it sets
-- status='repaying' at `awaiting_agent_receipt`/`completed` but NEVER touches
-- repayment_starts_on -- which is precisely the half that matters. Postgres
-- fires triggers in NAME order, and 'promote' < 'start', so it would have won
-- the race, flipped the status, and left this one with nothing to do: the date
-- would never have been stamped.
--
-- Hence the 'aa_' prefix (a convention already used here, e.g.
-- trg_aa_landlord_verification_gate) and a WHEN clause covering every status
-- at which the money counts as gone. This trigger now always runs first and
-- does the complete job; the older one becomes a harmless no-op because the
-- plan is already 'repaying' by the time it looks.
DROP TRIGGER IF EXISTS trg_start_repaying_on_landlord_paid ON public.landlord_payouts;
DROP TRIGGER IF EXISTS trg_aa_start_repaying_on_landlord_paid ON public.landlord_payouts;
CREATE TRIGGER trg_aa_start_repaying_on_landlord_paid
AFTER INSERT OR UPDATE OF status ON public.landlord_payouts
FOR EACH ROW
WHEN (NEW.status IN ('awaiting_agent_receipt','disbursed','completed'))
EXECUTE FUNCTION public.start_repaying_on_landlord_paid();

-- ---------------------------------------------------------------------------
-- 17. A payout that fails AFTER repayment has started
--
-- From the second day onward the tenant may already have paid. Reverting the
-- plan to `funded` would orphan those collections, so the status is left
-- alone and the situation is escalated instead: the landlord needs paying and
-- only a human can decide how.
--
-- 107 payouts are currently `failed`, worth 74,700,000, so this will fire.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.alert_payout_failed_after_repaying()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rr public.rent_requests%ROWTYPE;
BEGIN
  IF NEW.status IS DISTINCT FROM 'failed' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  IF NEW.rent_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = NEW.rent_request_id;

  -- Only interesting once the tenant has been asked to start repaying.
  IF v_rr.id IS NULL
     OR v_rr.status <> 'repaying'
     OR v_rr.repayment_starts_on IS NULL
     OR v_rr.repayment_starts_on > (now() AT TIME ZONE 'Africa/Kampala')::date THEN
    RETURN NEW;
  END IF;

  BEGIN
    INSERT INTO public.system_events (
      event_type, user_id, related_entity_type, related_entity_id, metadata
    ) VALUES (
      'landlord_payout_failed_after_repayment',
      NEW.agent_id,
      'rent_request',
      NEW.rent_request_id,
      jsonb_build_object(
        'severity',            'critical',
        'landlord_payout_id',  NEW.id,
        'landlord_name',       NEW.landlord_name,
        'amount',              NEW.amount,
        'last_error',          NEW.last_error,
        'repayment_starts_on', v_rr.repayment_starts_on,
        'amount_repaid',       v_rr.amount_repaid,
        'action',              'Re-dispatch the payout against the same allocation. Do NOT revert the plan: collections already exist.'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'alert_payout_failed_after_repaying failed for payout %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_alert_payout_failed_after_repaying ON public.landlord_payouts;
CREATE TRIGGER trg_alert_payout_failed_after_repaying
AFTER UPDATE OF status ON public.landlord_payouts
FOR EACH ROW
EXECUTE FUNCTION public.alert_payout_failed_after_repaying();

-- ---------------------------------------------------------------------------
-- 15. Make `repaying` sufficient for the schedule — WITHOUT stranding anyone
--
-- The spec said to replace the landlord-payout evidence clause outright with
-- `rr.status = 'repaying'`. Measured first, that would have been destructive on
-- two counts:
--
--   1. `v_rent_plan_schedule` is read by 19 functions, not just the pin —
--      among them agent_ops_collection_target, the command centre, the tenant
--      arrears watchlist and tppo_freeze_period, which closes financial
--      periods. Narrowing the shared view narrows all of them.
--
--   2. Today's bill contains 12 plans worth 669,566 that are still at `funded`
--      with their landlord already paid, plus 1 `completed`. Gating on
--      `repaying` alone would drop 13 plans and 685,473 — 13% of the day's
--      expected — and strand them permanently: unbillable means uncollectable,
--      and only a collection used to set `repaying`. With no backfill allowed,
--      they would never recover.
--
-- So the clause becomes additive rather than replaced. `repaying` is now
-- sufficient on its own, which is what closes the day-one pin gap for every
-- plan that flips through the trigger above. The old evidence arm stays only
-- for plans that predate the trigger, and can be deleted once they have
-- drained. No plan gains or loses billability today.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_rent_plan_schedule AS
 WITH pay AS (
         SELECT x.rent_request_id,
            max((x.created_at AT TIME ZONE 'Africa/Kampala'::text)::date) AS last_pay_date
           FROM ( SELECT agent_collections.rent_request_id, agent_collections.created_at
                   FROM agent_collections
                  WHERE agent_collections.rent_request_id IS NOT NULL
                UNION ALL
                 SELECT repayments.rent_request_id, repayments.created_at
                   FROM repayments
                  WHERE repayments.rent_request_id IS NOT NULL) x
          GROUP BY x.rent_request_id
        ), landlord_evidence AS (
         SELECT a.rent_request_id,
            count(*) FILTER (WHERE a.status = 'open'::text) AS open_allocs,
            COALESCE(sum(a.paid_out_amount), 0::numeric) AS paid_out
           FROM agent_landlord_float_allocations a
          WHERE a.rent_request_id IS NOT NULL
          GROUP BY a.rent_request_id
        )
 SELECT rr.id AS rent_request_id,
    rr.agent_id,
    rr.tenant_id,
    COALESCE(rr.daily_repayment, 0::numeric) AS daily_amount,
    COALESCE(rr.total_repayment, 0::numeric) AS total_amount,
    COALESCE(rr.amount_repaid, 0::numeric) AS amount_repaid,
    s.term_start,
    s.term_end,
    COALESCE(rr.duration_days, 0) AS term_days,
    o.obligation_end,
    o.obligation_end - s.term_start + 1 AS oblig_days,
    (rr.status = ANY (ARRAY['funded'::text, 'repaying'::text])) AND (COALESCE(rr.total_repayment, 0::numeric) - COALESCE(rr.amount_repaid, 0::numeric)) > 0::numeric AS is_live
   FROM rent_requests rr
     LEFT JOIN pay ON pay.rent_request_id = rr.id
     LEFT JOIN landlord_evidence le ON le.rent_request_id = rr.id
     CROSS JOIN LATERAL ( SELECT COALESCE(rr.repayment_starts_on, (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala'::text)::date) AS term_start,
            COALESCE(rr.repayment_starts_on, (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala'::text)::date) + COALESCE(rr.duration_days, 0) - 1 AS term_end) s
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN (COALESCE(rr.total_repayment, 0::numeric) - COALESCE(rr.amount_repaid, 0::numeric)) > 0::numeric THEN s.term_end
                    ELSE LEAST(s.term_end, COALESCE(pay.last_pay_date, s.term_start - 1))
                END AS obligation_end) o
  WHERE s.term_start IS NOT NULL
    AND (rr.status = ANY (ARRAY['funded'::text, 'repaying'::text, 'completed'::text]))
    AND COALESCE(rr.agent_payment_status, 'paying'::text) <> 'not_paying'::text
    AND rr.tenancy_status = 'active'::text
    AND rr.tenancy_ended_at IS NULL
    AND COALESCE(rr.duration_days, 0) > 0
    AND NOT (EXISTS ( SELECT 1
           FROM rent_repayment_pauses pz
          WHERE pz.rent_request_id = rr.id AND pz.status = 'active'::text AND pz.resumed_at IS NULL))
    AND (
      -- Authoritative from Phase 3 onward: the landlord has been paid.
      rr.status = 'repaying'::text
      -- Transitional, for plans that predate trg_start_repaying_on_landlord_paid.
      -- Delete this arm once they have drained.
      OR COALESCE(rr.amount_repaid, 0::numeric) > 0::numeric
      OR le.rent_request_id IS NULL
      OR le.paid_out > 0::numeric
      OR COALESCE(le.open_allocs, 0::bigint) = 0
    );

-- ---------------------------------------------------------------------------
-- 16. NOT DONE, and deliberately so.
--
-- The spec asked to cut pin_agent_expected_day_catchup's lookback from 6 days
-- to 1, on the grounds that the day-one gap can no longer occur. That holds
-- for plans flipping through the new trigger, but the catch-up is still
-- actively repairing older ones: 31 late pins written on 24 September covering
-- 16–23 September, and 70 on 23 September covering 15–22 September. Cutting
-- the window today would abandon those repairs.
--
-- Revisit once late pins fall to zero for several consecutive days, which is
-- the signal that every plan still being billed flipped through the trigger.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 11 + 13. The work list for the two transition SMS
--
-- Read by the `rent-plan-transition-notices` edge function, which cron runs
-- every 10 minutes. One round trip returns both lists; the edge function only
-- loops to send, because sending is inherently one message per person.
--
-- A cron drain rather than an inline send from the trigger, deliberately: the
-- status flip happens inside a landlord-payout transaction and nothing there
-- may fail or stall because an SMS provider is having a bad minute. Scanning
-- for the gap also makes it self-healing — a failed send is retried next run.
--
-- Idempotency is the unique index on sms_delivery_log(idempotency_key). This
-- function filters on the same keys, so an already-messaged plan never even
-- reaches the loop.
--
-- SECURITY DEFINER and revoked from anon/authenticated: it returns phone
-- numbers and is for the service role only.
-- ---------------------------------------------------------------------------
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
      'kind','agent_float_funded',
      'rent_request_id', x.rent_request_id,
      'reference_id',   'a1:'||x.rent_request_id::text,
      'agent_id',       x.agent_id,
      'agent_phone',    x.agent_phone,
      'agent_name',     x.agent_name,
      'landlord_name',  x.landlord_name,
      'tenant_name',    x.tenant_name,
      'rent_amount',    x.rent_amount,
      'deadline_at',    x.deadline_at
    ) ORDER BY x.deadline_at) AS rows
    FROM (
      SELECT rr.id AS rent_request_id, al.agent_id, ap.phone AS agent_phone,
             ap.full_name AS agent_name,
             COALESCE(al.landlord_name, ll.name) AS landlord_name,
             tp.full_name AS tenant_name, rr.rent_amount,
             al.created_at + interval '24 hours' AS deadline_at
      FROM public.agent_landlord_float_allocations al
      JOIN public.rent_requests rr ON rr.id = al.rent_request_id
      JOIN public.profiles ap      ON ap.id = al.agent_id
      LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
      LEFT JOIN public.landlords ll ON ll.id = al.landlord_id
      , since
      WHERE al.created_at >= since.t
        AND rr.status = 'funded'
        AND al.status IN ('open','partially_paid')
        AND COALESCE(btrim(ap.phone),'') <> ''
        AND NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                         WHERE s.idempotency_key = 'rent-plan-a1:'||rr.id::text)
    ) x
  ),
  t1 AS (
    SELECT jsonb_agg(jsonb_build_object(
      'kind','tenant_welcome',
      'rent_request_id',     y.rent_request_id,
      'reference_id',        't1:'||y.rent_request_id::text,
      'tenant_id',           y.tenant_id,
      'tenant_phone',        y.tenant_phone,
      'tenant_first_name',   y.tenant_first_name,
      'landlord_name',       y.landlord_name,
      'rent_amount',         y.rent_amount,
      'instalment',          y.instalment,
      'period_label',        y.period_label,
      'duration_days',       y.duration_days,
      'total_repayment',     y.total_repayment,
      'repayment_starts_on', y.repayment_starts_on,
      'agent_name',          y.agent_name,
      'agent_phone',         y.agent_phone
    ) ORDER BY y.repayment_starts_on) AS rows
    FROM (
      SELECT rr.id AS rent_request_id, rr.tenant_id, tp.phone AS tenant_phone,
             split_part(btrim(COALESCE(tp.full_name,'')), ' ', 1) AS tenant_first_name,
             (ev.metadata->>'landlord_name') AS landlord_name,
             rr.rent_amount,
             -- Weekly plans are billed the whole week on their due day, so the
             -- tenant must be quoted the weekly figure, not one seventh of it.
             CASE WHEN lower(COALESCE(rr.repayment_frequency,'daily')) = 'weekly'
                  THEN COALESCE(rr.daily_repayment,0) * 7
                  ELSE COALESCE(rr.daily_repayment,0) END AS instalment,
             CASE WHEN lower(COALESCE(rr.repayment_frequency,'daily')) = 'weekly'
                  THEN 'per week' ELSE 'per day' END AS period_label,
             rr.duration_days, rr.total_repayment, rr.repayment_starts_on,
             ap.full_name AS agent_name, ap.phone AS agent_phone
      FROM public.system_events ev
      JOIN public.rent_requests rr ON rr.id = ev.related_entity_id
      JOIN public.profiles tp      ON tp.id = rr.tenant_id
      LEFT JOIN public.profiles ap ON ap.id = COALESCE(rr.assigned_agent_id, rr.agent_id)
      , since
      WHERE ev.event_type = 'rent_request_repaying_started'
        AND ev.created_at >= since.t
        AND rr.status = 'repaying'
        AND COALESCE(btrim(tp.phone),'') <> ''
        AND NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                         WHERE s.idempotency_key = 'rent-plan-t1:'||rr.id::text)
    ) y
  )
  SELECT jsonb_build_object(
    'as_of', now(),
    'agent_float_funded', COALESCE((SELECT rows FROM a1), '[]'::jsonb),
    'tenant_welcome',     COALESCE((SELECT rows FROM t1), '[]'::jsonb)
  );
$function$;

REVOKE ALL ON FUNCTION public.rent_plan_transition_notices_pending(integer) FROM public, anon, authenticated;

-- Cron: drain every 10 minutes.
--   select cron.schedule('rent-plan-transition-notices', '*/10 * * * *', $cron$
--     select net.http_post(
--       url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/rent-plan-transition-notices',
--       headers := jsonb_build_object('Content-Type','application/json'),
--       body := '{}'::jsonb);
--   $cron$);
-- Registered in production as jobid 41650.
