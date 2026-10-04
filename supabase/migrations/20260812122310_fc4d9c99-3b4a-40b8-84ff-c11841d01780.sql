-- 1) Harden the settlement fence: evidence-based, not just status-based.
CREATE OR REPLACE FUNCTION public.enforce_settled_withdrawal_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_terminal text[] := ARRAY['completed','paid','disbursed','rejected','cancelled'];
  v_queue text[] := ARRAY['pending','requested','manager_approved','cfo_approved','fin_ops_approved','approved','processing'];
  v_had_evidence boolean;
BEGIN
  v_had_evidence := (OLD.fin_ops_reference IS NOT NULL OR OLD.processed_at IS NOT NULL);

  -- Never allow a settled payout (terminal status OR carrying settlement
  -- evidence) to be moved back into any queue/processing state. This covers the
  -- timeout / retry / duplicate-confirmation paths that previously reset rows
  -- to 'pending' after cash had already left.
  IF (OLD.status = ANY (v_terminal) OR v_had_evidence)
     AND NEW.status <> OLD.status
     AND NEW.status = ANY (v_queue) THEN
    RAISE EXCEPTION 'Withdrawal % is already settled (status=%, ref=%). A settled payout cannot be returned to the pending queue.',
      OLD.id, OLD.status, COALESCE(OLD.fin_ops_reference, 'n/a')
      USING ERRCODE = '23514';
  END IF;

  -- Settlement evidence is immutable once written.
  IF OLD.status = ANY (v_terminal) OR v_had_evidence THEN
    IF OLD.fin_ops_reference IS NOT NULL AND NEW.fin_ops_reference IS NULL THEN
      NEW.fin_ops_reference := OLD.fin_ops_reference;
    END IF;
    IF OLD.processed_at IS NOT NULL AND NEW.processed_at IS NULL THEN
      NEW.processed_at := OLD.processed_at;
    END IF;
    IF OLD.payout_proof_path IS NOT NULL AND NEW.payout_proof_path IS NULL THEN
      NEW.payout_proof_path := OLD.payout_proof_path;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- 2) One authoritative, backend-enforced definition of "actionable merchant queue".
CREATE OR REPLACE VIEW public.v_merchant_payout_queue
WITH (security_invoker = true) AS
SELECT w.*
FROM public.withdrawal_requests w
WHERE w.status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved')
  AND w.processed_at IS NULL
  AND w.fin_ops_reference IS NULL;

GRANT SELECT ON public.v_merchant_payout_queue TO authenticated;
GRANT SELECT ON public.v_merchant_payout_queue TO service_role;

COMMENT ON VIEW public.v_merchant_payout_queue IS
  'Sole source of truth for the Merchant Agent pending payout queue. Terminal or settlement-stamped withdrawals can never appear here.';
