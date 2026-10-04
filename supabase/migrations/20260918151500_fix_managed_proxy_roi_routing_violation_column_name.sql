-- Bug fix only, no logic change: enforce_managed_proxy_roi_routing()'s
-- violation-logging INSERT referenced NEW.reference, but general_ledger's
-- actual column is reference_id. Any time this trigger's intended
-- RAISE EXCEPTION path was reached, Postgres raised a confusing
-- "record \"new\" has no field \"reference\"" error instead, masking the
-- real, correct "Managed-proxy ROI routing violation" message.
--
-- Surfaced live 2026-09-18 while testing the Split Payout "pay to a
-- different person's wallet" feature against Constance Lutaaya, who has
-- an active managed proxy agent (5f277e34-a830-4ebb-8680-c0c074b279da) —
-- this trigger correctly rejects crediting her own wallet with any
-- portion of her ROI while under managed-proxy custody. Only the error
-- message was broken; the block itself was already doing its job.

CREATE OR REPLACE FUNCTION public.enforce_managed_proxy_roi_routing()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lp uuid;
  v_agent uuid;
BEGIN
  IF NEW.category NOT IN ('roi_wallet_credit', 'roi_payout') THEN
    RETURN NEW;
  END IF;
  IF NEW.direction <> 'cash_in' THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NULL OR NEW.linked_party IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_lp := NEW.linked_party::uuid;
  EXCEPTION WHEN others THEN
    RETURN NEW;
  END;

  SELECT agent_id INTO v_agent
  FROM public.proxy_agent_assignments
  WHERE beneficiary_id = v_lp
    AND is_active = true
    AND is_managed_account = true
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_agent IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id = v_agent THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id = v_lp THEN
    INSERT INTO public.managed_proxy_roi_routing_violations(
      attempted_user_id, expected_agent_id, linked_party,
      amount, category, direction, reference, description
    ) VALUES (
      NEW.user_id, v_agent, v_lp,
      NEW.amount, NEW.category, NEW.direction, NEW.reference_id, NEW.description
    );

    RAISE EXCEPTION
      'Managed-proxy ROI routing violation: partner % is under managed proxy agent %; ROI must land 100%% on agent wallet, not partner wallet. (category=%, amount=%)',
      v_lp, v_agent, NEW.category, NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;
