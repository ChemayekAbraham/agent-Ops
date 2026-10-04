-- Violation log
CREATE TABLE IF NOT EXISTS public.managed_proxy_roi_routing_violations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempted_user_id uuid NOT NULL,
  expected_agent_id uuid NOT NULL,
  linked_party uuid NOT NULL,
  amount numeric NOT NULL,
  category text NOT NULL,
  direction text NOT NULL,
  reference text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.managed_proxy_roi_routing_violations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "CFO and managers can view ROI routing violations" ON public.managed_proxy_roi_routing_violations;
CREATE POLICY "CFO and managers can view ROI routing violations"
ON public.managed_proxy_roi_routing_violations
FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager'));

-- Guardrail trigger function
CREATE OR REPLACE FUNCTION public.enforce_managed_proxy_roi_routing()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lp uuid;
  v_agent uuid;
BEGIN
  -- Only inspect wallet-side ROI credits (cash_in on a real user wallet)
  IF NEW.category NOT IN ('roi_wallet_credit', 'roi_payout') THEN
    RETURN NEW;
  END IF;
  IF NEW.direction <> 'cash_in' THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL OR NEW.linked_party IS NULL THEN
    RETURN NEW;
  END IF;

  -- linked_party may be text/uuid depending on column type; cast safely
  BEGIN
    v_lp := NEW.linked_party::uuid;
  EXCEPTION WHEN others THEN
    RETURN NEW;
  END;

  -- Find an active, approved managed-proxy agent for this partner (linked_party)
  SELECT agent_id INTO v_agent
  FROM public.proxy_agent_assignments
  WHERE beneficiary_id = v_lp
    AND is_active = true
    AND is_managed_account = true
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_agent IS NULL THEN
    RETURN NEW; -- no managed proxy => no routing constraint
  END IF;

  -- If credit is already landing on the proxy agent's wallet, allow
  IF NEW.user_id = v_agent THEN
    RETURN NEW;
  END IF;

  -- If credit is landing on the partner's own wallet (the linked_party),
  -- this is a misroute under managed-proxy custody: block + log.
  IF NEW.user_id = v_lp THEN
    INSERT INTO public.managed_proxy_roi_routing_violations(
      attempted_user_id, expected_agent_id, linked_party,
      amount, category, direction, reference, description
    ) VALUES (
      NEW.user_id, v_agent, v_lp,
      NEW.amount, NEW.category, NEW.direction, NEW.reference, NEW.description
    );

    RAISE EXCEPTION
      'Managed-proxy ROI routing violation: partner % is under managed proxy agent %; ROI must land 100%% on agent wallet, not partner wallet. (category=%, amount=%)',
      v_lp, v_agent, NEW.category, NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_managed_proxy_roi_routing ON public.general_ledger;
CREATE TRIGGER trg_enforce_managed_proxy_roi_routing
BEFORE INSERT ON public.general_ledger
FOR EACH ROW
EXECUTE FUNCTION public.enforce_managed_proxy_roi_routing();