-- The detector must respect a human decision
--
-- Companion to 20260925170000, which gives Landlord Ops and the CFO actions on
-- the idle-float queue. Without this, those actions are cosmetic.
-- detect_idle_landlord_float runs every 15 minutes and unconditionally
-- rewrites `outcome` on any alert whose allocation is still open, so:
--
--   * a case a reviewer DISMISSED would have its outcome overwritten back to
--     'pre_go_live_manual_review' on the next tick, and
--   * worse, once the go-live line passes, a dismissed case whose float is
--     still sitting there would be auto-recalled anyway — the system
--     overruling the person who looked at it.
--
-- A resolved alert is now left entirely alone: the hours are still refreshed so
-- the register stays truthful, but no outcome is rewritten and no recall is
-- considered. Everything else is the 20260925140000 body unchanged.

CREATE OR REPLACE FUNCTION public.detect_idle_landlord_float(p_system_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  r             record;
  v_recalled    int := 0;
  v_escalated   int := 0;
  v_tracked     int := 0;
  v_pre_go_live int := 0;
  v_reviewed    int := 0;
  v_amount      numeric := 0;
  v_actor       uuid := COALESCE(p_system_actor,
                                 NULLIF(current_setting('app.system_actor', true), '')::uuid);
  v_res         jsonb;
BEGIN
  FOR r IN
    SELECT al.id AS allocation_id, al.rent_request_id, al.agent_id,
           ap.full_name AS agent_name,
           COALESCE(al.landlord_name, ll.name) AS landlord_name,
           tp.full_name AS tenant_name,
           al.allocated_amount AS amount,
           al.created_at AS funded_at,
           al.created_at + interval '24 hours' AS deadline_at,
           round(extract(epoch FROM (now() - al.created_at)) / 3600.0, 2) AS hrs,
           EXISTS (SELECT 1 FROM public.landlord_payouts lp
                    WHERE lp.rent_request_id = al.rent_request_id
                      AND (lp.status IN ('pending_merchant_payout','pending_finops_disbursement',
                                         'awaiting_agent_receipt','disbursed','completed')
                           OR lp.finops_disbursed_at IS NOT NULL
                           OR lp.disbursed_at IS NOT NULL)) AS ever_dispatched,
           EXISTS (SELECT 1 FROM public.landlord_payouts lp
                    WHERE lp.rent_request_id = al.rent_request_id
                      AND lp.status = 'failed') AS has_failed_payout,
           EXISTS (SELECT 1 FROM public.landlord_float_idle_alerts x
                    WHERE x.allocation_id = al.id AND x.resolved_at IS NOT NULL) AS human_closed
    FROM public.agent_landlord_float_allocations al
    JOIN public.rent_requests rr ON rr.id = al.rent_request_id
    LEFT JOIN public.profiles ap  ON ap.id = al.agent_id
    LEFT JOIN public.profiles tp  ON tp.id = rr.tenant_id
    LEFT JOIN public.landlords ll ON ll.id = al.landlord_id
    WHERE al.status IN ('open','partially_paid')
      AND rr.status = 'funded'
      AND COALESCE(al.paid_out_amount, 0) = 0
      AND al.created_at < now() - interval '6 hours'
  LOOP
    v_tracked := v_tracked + 1;

    INSERT INTO public.landlord_float_idle_alerts (
      allocation_id, rent_request_id, agent_id, agent_name, landlord_name,
      tenant_name, amount, funded_at, deadline_at, hours_outstanding, severity,
      payout_attempted
    ) VALUES (
      r.allocation_id, r.rent_request_id, r.agent_id, r.agent_name, r.landlord_name,
      r.tenant_name, r.amount, r.funded_at, r.deadline_at, r.hrs,
      CASE WHEN r.hrs >= 24 THEN 'overdue'
           WHEN r.hrs >= 18 THEN 'warning'
           ELSE 'reminder' END,
      r.ever_dispatched OR r.has_failed_payout
    )
    ON CONFLICT (allocation_id) DO UPDATE
      SET hours_outstanding = EXCLUDED.hours_outstanding,
          severity          = EXCLUDED.severity,
          payout_attempted  = EXCLUDED.payout_attempted,
          updated_at        = now();

    -- A person has closed this one. Their decision stands.
    IF r.human_closed THEN
      v_reviewed := v_reviewed + 1;
      CONTINUE;
    END IF;

    IF r.hrs >= 24 THEN
      IF r.ever_dispatched OR r.has_failed_payout THEN
        UPDATE public.landlord_float_idle_alerts
           SET outcome = 'escalated_payout_attempted', updated_at = now()
         WHERE allocation_id = r.allocation_id
           AND resolved_at IS NULL
           AND outcome IS DISTINCT FROM 'escalated_payout_attempted';

        INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
        VALUES ('landlord_float_idle_escalated', r.agent_id, 'rent_request', r.rent_request_id,
          jsonb_build_object('severity','high','allocation_id',r.allocation_id,
            'amount',r.amount,'hours_outstanding',r.hrs,'landlord_name',r.landlord_name,
            'reason','Payout was dispatched or failed — needs FinOps, not an automatic recall.'));
        v_escalated := v_escalated + 1;

      ELSIF r.funded_at < public.landlord_float_recall_go_live() THEN
        UPDATE public.landlord_float_idle_alerts
           SET outcome = 'pre_go_live_manual_review', updated_at = now()
         WHERE allocation_id = r.allocation_id
           AND resolved_at IS NULL
           AND outcome IS DISTINCT FROM 'pre_go_live_manual_review';
        v_pre_go_live := v_pre_go_live + 1;

      ELSE
        BEGIN
          PERFORM set_config('app.system_actor', COALESCE(v_actor::text, ''), true);
          v_res := public.cancel_tenant_and_return_landlord_float(
                     r.rent_request_id,
                     format('Automatic recall: landlord %s was not paid within 24 hours of funding.',
                            COALESCE(r.landlord_name,'')));
          UPDATE public.landlord_float_idle_alerts
             SET outcome = 'auto_recalled', resolved_at = now(), updated_at = now()
           WHERE allocation_id = r.allocation_id;
          v_recalled := v_recalled + 1;
          v_amount := v_amount + COALESCE((v_res->>'float_returned')::numeric, 0);
        EXCEPTION WHEN OTHERS THEN
          UPDATE public.landlord_float_idle_alerts
             SET outcome = 'recall_failed: '||SQLERRM, updated_at = now()
           WHERE allocation_id = r.allocation_id;
          RAISE WARNING 'auto recall failed for plan %: %', r.rent_request_id, SQLERRM;
        END;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.landlord_float_idle_alerts a
     SET resolved_at = now(), outcome = COALESCE(a.outcome,'landlord_paid'), updated_at = now()
   WHERE a.resolved_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.agent_landlord_float_allocations al
        JOIN public.rent_requests rr ON rr.id = al.rent_request_id
        WHERE al.id = a.allocation_id
          AND al.status IN ('open','partially_paid')
          AND rr.status = 'funded'
          AND COALESCE(al.paid_out_amount,0) = 0);

  RETURN jsonb_build_object('status','ok','as_of',now(),
    'tracked',v_tracked,'auto_recalled',v_recalled,'float_returned',v_amount,
    'escalated',v_escalated,'pre_go_live_held',v_pre_go_live,
    'human_closed_skipped',v_reviewed,
    'go_live',public.landlord_float_recall_go_live());
END;
$function$;

REVOKE ALL ON FUNCTION public.detect_idle_landlord_float(uuid) FROM public, anon, authenticated;
