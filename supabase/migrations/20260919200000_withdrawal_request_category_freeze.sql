-- Financial Ops liquidity control: let an operator put specific pending
-- withdrawals on hold (independent of the account-level fraud freeze on
-- `profiles.is_frozen`), so they can pay some requests in a category (e.g.
-- Landlord Payouts) now and leave the rest queued for later without
-- rejecting them outright.
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS frozen boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS frozen_at timestamptz,
  ADD COLUMN IF NOT EXISTS frozen_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS frozen_reason text,
  ADD COLUMN IF NOT EXISTS frozen_category text;

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_frozen
  ON public.withdrawal_requests (frozen)
  WHERE frozen = true;

COMMENT ON COLUMN public.withdrawal_requests.frozen IS
  'Financial Ops liquidity hold. Set/cleared directly by the operator UI (Approval Queue) — not a fraud signal. Blocks approve-withdrawal and any further status advance until cleared.';
COMMENT ON COLUMN public.withdrawal_requests.frozen_category IS
  'Category label the operator was targeting when this row was frozen (e.g. landlord, agent, supporter) — audit/display only, not re-derived from it.';

-- Backstop at the database layer, mirroring the existing account-level
-- fraud gate (enforce_no_fraud_withdrawal_request): even if a caller bypasses
-- the edge function's explicit frozen check, no status transition other than
-- rejected/cancelled can proceed while frozen = true. Freezing/unfreezing
-- itself (a write to `frozen` with no `status` change) is untouched since
-- this trigger only fires on UPDATE OF status.
CREATE OR REPLACE FUNCTION public.enforce_no_progress_on_frozen_withdrawal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.frozen IS TRUE
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('rejected', 'cancelled') THEN
    RAISE EXCEPTION 'withdrawal_frozen: this withdrawal is on hold by Financial Ops and cannot advance until unfrozen'
      USING ERRCODE = '28000';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_no_progress_on_frozen_withdrawal ON public.withdrawal_requests;
CREATE TRIGGER trg_enforce_no_progress_on_frozen_withdrawal
  BEFORE UPDATE OF status ON public.withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_no_progress_on_frozen_withdrawal();
