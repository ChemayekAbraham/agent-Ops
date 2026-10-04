-- 2026-09-11 Daily CTO Report: cron job "reconcile-evidenced-withdrawal-
-- settlements" (*/10 * * * *) timing out (2/144 runs today, "canceling
-- statement due to statement timeout"), and separately the single slowest
-- statement platform-wide (41,680ms mean over 4,348 calls/day).
--
-- public.reconcile_evidenced_withdrawal_settlements() loops over up to 500
-- candidate withdrawals per run, calling record_withdrawal_settlement_state()
-- -> withdrawal_settlement_status() once per row — each of those does its
-- own several-way SUM(...) FILTER scan against general_ledger keyed by
-- reference_id. That's a genuine N+1: the per-row query itself is indexed
-- (idx_general_ledger_reference_id already exists and is in use), but 500
-- scalar round-trips every 10 minutes at current withdrawal volume is what
-- exceeds the statement timeout, not a missing index.
--
-- The correct long-term fix is to batch withdrawal_settlement_status's
-- aggregates into one set-based pass over all candidate IDs at once, but
-- that touches settlement classification for real payouts and deserves its
-- own careful, independently-verified change rather than being bundled in
-- here. As an immediate, zero-behavior-risk mitigation — this job already
-- self-feeds every 10 minutes, so a smaller batch only delays how quickly a
-- backlog drains, it never drops or skips a withdrawal — cut the per-run
-- batch size so a run completes comfortably inside the statement timeout.
-- No other logic in this function changes.

CREATE OR REPLACE FUNCTION public.reconcile_evidenced_withdrawal_settlements()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
       AND w.updated_at > now() - interval '30 days'
     ORDER BY w.updated_at
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
$$;

REVOKE ALL ON FUNCTION public.reconcile_evidenced_withdrawal_settlements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_evidenced_withdrawal_settlements() TO service_role;
