-- reconcile_evidenced_withdrawal_settlements(): stop re-checking the same
-- unresolvable rows forever (doc 143).
--
-- Found 2026-09-28 while tracing the CTO report's rollback/slow-query items:
-- the */10 job rewrote exactly 150 withdrawal_requests rows every run
-- (~21.6k row updates/day, 235k since 09-17). 3,512 rows were in the loop,
-- averaging 748 re-checks each (max 1,309). 3,508 of them are `completed`
-- withdrawals whose only missing ledger leg is `merchant_telecom_charge`
-- (the pre-3f179b8c0 telecom split) with no payment evidence — they can never
-- become settled, so they never leave the candidate set.
--
-- Why they never aged out: candidates were windowed and ordered by
-- w.updated_at, and record_withdrawal_settlement_state() sets updated_at =
-- now() on every check. Side effects of the loop:
--   * every re-check is an UPDATE on a Realtime-published table with
--     unfiltered listeners;
--   * the queue is round-robin over ~3.5k rows ordered oldest-updated first,
--     so a NEWLY evidenced withdrawal waited up to ~4h for its turn to be
--     finalized to 'paid'.
--
-- Fix (selection only — the per-row logic and the finalize-to-paid branch are
-- unchanged):
--   * window on greatest(created_at, evidence created_at), not updated_at;
--   * back off: re-check every run for the first 6 attempts (~1h), then at
--     most once per 24h;
--   * least-recently-checked first (never-checked rows first of all).
-- record_withdrawal_settlement_state() is NOT changed (approve-withdrawal
-- also calls it).

CREATE OR REPLACE FUNCTION public.reconcile_evidenced_withdrawal_settlements()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_res jsonb;
  v_state text;
  v_finalized int := 0;
  v_alerted int := 0;
  v_rechecked int := 0;
BEGIN
  FOR r IN
    SELECT w.id, w.status, w.user_id, e.transaction_id, e.created_at AS evidence_at
      FROM public.withdrawal_requests w
      LEFT JOIN public.withdrawal_payment_evidence e ON e.withdrawal_id = w.id
     WHERE (
             e.id IS NOT NULL
             OR w.settlement_state IN ('processing', 'unsettled')
           )
       AND w.status NOT IN ('rejected', 'cancelled')
       AND greatest(w.created_at, coalesce(e.created_at, w.created_at)) > now() - interval '30 days'
       AND (
             w.settlement_checked_at IS NULL
             OR w.settlement_checked_at < now() - CASE
                  WHEN coalesce(w.settlement_attempts, 0) < 6 THEN interval '9 minutes'
                  ELSE interval '24 hours'
                END
           )
     ORDER BY w.settlement_checked_at NULLS FIRST, w.created_at DESC
     LIMIT 150
  LOOP
    v_res := public.record_withdrawal_settlement_state(r.id);
    v_state := v_res->>'settlement_state';
    v_rechecked := v_rechecked + 1;

    IF v_state = 'settled'
       AND r.status NOT IN ('completed', 'disbursed', 'paid')
       AND r.transaction_id IS NOT NULL THEN
      UPDATE public.withdrawal_requests
         SET status = 'paid',
             fin_ops_reference = COALESCE(fin_ops_reference, r.transaction_id),
             transaction_id = COALESCE(transaction_id, r.transaction_id),
             processed_at = COALESCE(processed_at, now()),
             fin_ops_verified_at = COALESCE(fin_ops_verified_at, now()),
             settlement_state = 'settled',
             metadata = coalesce(metadata, '{}'::jsonb)
                        || jsonb_build_object('settlement_pending', false,
                                              'settlement_verified_at', now(),
                                              'settlement_finalized_by', 'settlement_reconciler'),
             updated_at = now()
       WHERE id = r.id;
      v_finalized := v_finalized + 1;
    ELSIF v_state = 'unsettled'
          AND coalesce(r.evidence_at, now()) < now() - interval '20 minutes' THEN
      INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
      VALUES ('withdrawal.settlement_incomplete_alert', r.user_id, 'withdrawal_requests', r.id,
              jsonb_build_object('settlement', v_res, 'evidence_at', r.evidence_at));
      v_alerted := v_alerted + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('rechecked', v_rechecked, 'finalized', v_finalized,
                            'alerted', v_alerted, 'ran_at', now());
END;
$function$;
