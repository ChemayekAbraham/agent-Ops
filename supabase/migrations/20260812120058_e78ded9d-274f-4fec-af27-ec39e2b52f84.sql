CREATE OR REPLACE FUNCTION public.enforce_settled_withdrawal_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal text[] := ARRAY['completed','paid','disbursed','rejected','cancelled'];
  v_queue text[] := ARRAY['pending','requested','manager_approved','cfo_approved','fin_ops_approved','approved','processing'];
BEGIN
  IF OLD.status = ANY (v_terminal) AND NEW.status <> OLD.status AND NEW.status = ANY (v_queue) THEN
    RAISE EXCEPTION 'Withdrawal % is already settled (%). A settled payout cannot be returned to the pending queue.', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = ANY (v_terminal) THEN
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
$$;

DROP TRIGGER IF EXISTS trg_enforce_settled_withdrawal_terminal ON public.withdrawal_requests;
CREATE TRIGGER trg_enforce_settled_withdrawal_terminal
BEFORE UPDATE ON public.withdrawal_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_settled_withdrawal_terminal();