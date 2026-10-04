-- =====================================================================
-- PHASE 2: explicit, reconcilable settlement state for every payout.
-- =====================================================================

ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS settlement_state text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS settlement_missing_legs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS settlement_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS settlement_attempts integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_settlement_state
  ON public.withdrawal_requests(settlement_state, updated_at DESC);

-- 1. Single writer of settlement state ------------------------------------
CREATE OR REPLACE FUNCTION public.record_withdrawal_settlement_state(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w record;
  v_status jsonb;
  v_settled boolean;
  v_missing jsonb;
  v_state text;
  v_prev text;
BEGIN
  SELECT * INTO w FROM public.withdrawal_requests WHERE id = p_withdrawal_id;
  IF w IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'withdrawal_not_found');
  END IF;

  v_status := public.withdrawal_settlement_status(p_withdrawal_id);
  v_settled := coalesce((v_status->>'settled')::boolean, false);
  v_missing := coalesce(v_status->'missing', '[]'::jsonb);
  v_prev := w.settlement_state;

  IF v_settled THEN
    v_state := 'settled';
  ELSIF w.status IN ('rejected', 'cancelled') THEN
    v_state := 'pending';
  ELSIF w.status IN ('paid', 'completed', 'disbursed')
     OR EXISTS (SELECT 1 FROM public.withdrawal_payment_evidence e WHERE e.withdrawal_id = p_withdrawal_id)
     OR jsonb_array_length(v_missing) < 4 THEN
    -- money has started moving (or the payout claims to be paid) but legs are missing
    v_state := 'unsettled';
  ELSIF w.status = 'processing' THEN
    v_state := 'processing';
  ELSE
    v_state := 'pending';
  END IF;

  UPDATE public.withdrawal_requests
     SET settlement_state = v_state,
         settlement_missing_legs = v_missing,
         settlement_checked_at = now(),
         settlement_attempts = settlement_attempts + 1,
         updated_at = now()
   WHERE id = p_withdrawal_id;

  IF v_state = 'unsettled' AND coalesce(v_prev, '') <> 'unsettled' THEN
    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES ('withdrawal.settlement_unsettled', w.user_id, 'withdrawal_requests', p_withdrawal_id,
            jsonb_build_object('status', w.status, 'settlement', v_status));
  END IF;

  RETURN jsonb_build_object('ok', true, 'settlement_state', v_state, 'missing', v_missing, 'detail', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public.record_withdrawal_settlement_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_withdrawal_settlement_state(uuid) TO authenticated, service_role;

-- 2. Terminal status can never self-declare settlement --------------------
CREATE OR REPLACE FUNCTION public.mark_withdrawal_settlement_dirty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'processing' AND NEW.settlement_state IN ('pending', 'processing') THEN
      NEW.settlement_state := 'processing';
      NEW.settlement_missing_legs := '[]'::jsonb;
    ELSIF NEW.status IN ('paid', 'completed', 'disbursed')
          AND NEW.settlement_state IS DISTINCT FROM 'settled' THEN
      -- Never trust the status: recompute against the ledger.
      NEW.settlement_state := 'unsettled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mark_withdrawal_settlement_dirty ON public.withdrawal_requests;
CREATE TRIGGER trg_mark_withdrawal_settlement_dirty
BEFORE UPDATE ON public.withdrawal_requests
FOR EACH ROW
EXECUTE FUNCTION public.mark_withdrawal_settlement_dirty();

-- 3. Reconciliation surface ----------------------------------------------
CREATE OR REPLACE VIEW public.v_unsettled_payouts
WITH (security_invoker = true) AS
SELECT w.id AS withdrawal_id,
       w.user_id,
       w.amount,
       w.status,
       w.settlement_state,
       w.settlement_missing_legs,
       w.settlement_checked_at,
       w.settlement_attempts,
       coalesce(w.processing_started_by, w.assigned_cashout_agent_id, w.dispatch_claimed_by) AS merchant_id,
       w.payout_method,
       w.fin_ops_reference,
       w.processed_at,
       w.created_at,
       (e.id IS NOT NULL) AS has_payment_evidence
  FROM public.withdrawal_requests w
  LEFT JOIN public.withdrawal_payment_evidence e ON e.withdrawal_id = w.id
 WHERE w.settlement_state = 'unsettled';

GRANT SELECT ON public.v_unsettled_payouts TO authenticated;

-- 4. Reconciler owns promotion to settled --------------------------------
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
     LIMIT 500
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
