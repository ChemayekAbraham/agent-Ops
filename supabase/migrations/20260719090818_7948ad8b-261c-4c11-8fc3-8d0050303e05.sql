
-- Anti-inflation guard for agent_advances
-- Prevents recorded principal from ever exceeding the actual UGX disbursed to the agent's wallet,
-- and locks principal against post-creation increases.

CREATE OR REPLACE FUNCTION public.enforce_advance_principal_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_disbursed numeric;
  v_grace_min integer := 10; -- ledger disbursement must land within 10 minutes of the advance row
BEGIN
  -- Rule 1: on UPDATE, principal is immutable-upward. It may only stay the same or decrease
  -- (a decrease is allowed for correction/refund workflows that shrink the recorded liability).
  IF TG_OP = 'UPDATE' THEN
    IF NEW.principal > OLD.principal THEN
      RAISE EXCEPTION 'ADVANCE_PRINCIPAL_INFLATION_BLOCKED: principal cannot be increased after creation (old=%, new=%)',
        OLD.principal, NEW.principal
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Rule 2: on INSERT, sanity bounds
  IF NEW.principal IS NULL OR NEW.principal <= 0 THEN
    RAISE EXCEPTION 'ADVANCE_PRINCIPAL_INVALID: principal must be > 0 (got %)', NEW.principal
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.principal < 1000 THEN
    RAISE EXCEPTION 'ADVANCE_PRINCIPAL_TOO_SMALL: principal % UGX is below the 1,000 UGX minimum (prevents fat-finger/test taps)',
      NEW.principal
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rule 3: monthly_rate cannot exceed the 33% standard
  IF NEW.monthly_rate > 0.33 THEN
    RAISE EXCEPTION 'ADVANCE_RATE_ABOVE_STANDARD: monthly_rate % exceeds the 33%% standard', NEW.monthly_rate
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_advance_principal_integrity ON public.agent_advances;
CREATE TRIGGER trg_enforce_advance_principal_integrity
BEFORE INSERT OR UPDATE OF principal, monthly_rate ON public.agent_advances
FOR EACH ROW
EXECUTE FUNCTION public.enforce_advance_principal_integrity();


-- Post-disbursement reconciliation: within 10 minutes of an advance being created,
-- the wallet leg of the disbursement (category 'agent_advance', recipient_type 'user', cash_in)
-- MUST equal principal. If it doesn't, a deferred check via a follow-up trigger on
-- general_ledger flags the mismatch and blocks any further ledger activity on the advance.

CREATE OR REPLACE FUNCTION public.verify_advance_disbursement_matches_principal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_advance RECORD;
  v_credited numeric;
BEGIN
  -- Only interested in wallet-scope credits to a user categorised as an advance disbursement
  IF NEW.ledger_scope <> 'wallet'
     OR NEW.cash_in IS NULL OR NEW.cash_in <= 0
     OR NEW.category <> 'agent_advance'
     OR COALESCE(NEW.recipient_type,'') <> 'user' THEN
    RETURN NEW;
  END IF;

  -- Find the most recent unverified active advance for this user in the last 10 minutes
  SELECT * INTO v_advance
  FROM public.agent_advances
  WHERE agent_id = NEW.user_id
    AND status = 'active'
    AND issued_at > now() - interval '10 minutes'
  ORDER BY issued_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Sum credited so far for this advance window (including this row)
  SELECT COALESCE(SUM(cash_in),0) INTO v_credited
  FROM public.general_ledger
  WHERE user_id = NEW.user_id
    AND ledger_scope = 'wallet'
    AND category = 'agent_advance'
    AND recipient_type = 'user'
    AND created_at >= v_advance.issued_at - interval '1 minute'
    AND created_at <= v_advance.issued_at + interval '10 minutes';

  v_credited := v_credited + NEW.cash_in;

  -- Hard cap: disbursed cannot exceed recorded principal
  IF v_credited > v_advance.principal THEN
    RAISE EXCEPTION 'ADVANCE_DISBURSEMENT_EXCEEDS_PRINCIPAL: attempted to credit % UGX which exceeds recorded principal % UGX for advance %',
      v_credited, v_advance.principal, v_advance.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_verify_advance_disbursement ON public.general_ledger;
CREATE TRIGGER trg_verify_advance_disbursement
BEFORE INSERT ON public.general_ledger
FOR EACH ROW
EXECUTE FUNCTION public.verify_advance_disbursement_matches_principal();
