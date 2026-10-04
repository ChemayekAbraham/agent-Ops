CREATE OR REPLACE FUNCTION public.block_proxy_custody_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cutoff timestamptz;
  v_lp_uuid uuid;
  v_bypass text;
  v_is_approved_managed_proxy boolean := false;
BEGIN
  -- Explicit bypass for one-off legacy reversals
  BEGIN v_bypass := current_setting('wallet.legacy_proxy_reversal', true); EXCEPTION WHEN OTHERS THEN v_bypass := NULL; END;
  IF v_bypass = 'true' THEN RETURN NEW; END IF;

  -- Only police wallet-scope legs that have a counterparty
  IF NEW.ledger_scope <> 'wallet' THEN RETURN NEW; END IF;
  IF NEW.linked_party IS NULL OR NEW.user_id IS NULL THEN RETURN NEW; END IF;

  -- The guard's purpose is to stop partner funds from being parked in random
  -- agent wallets. Spends out of an agent wallet remain allowed.
  IF NEW.direction <> 'cash_in' THEN RETURN NEW; END IF;

  -- Cutoff gate
  SELECT (value #>> '{}')::timestamptz INTO v_cutoff
    FROM public.system_config WHERE key = 'proxy_custody_cutoff_at';
  IF v_cutoff IS NULL OR NEW.created_at < v_cutoff THEN RETURN NEW; END IF;

  BEGIN v_lp_uuid := NEW.linked_party::uuid; EXCEPTION WHEN OTHERS THEN RETURN NEW; END;

  -- Self-reference is never custody
  IF v_lp_uuid = NEW.user_id THEN RETURN NEW; END IF;

  -- Managed-proxy exception: ROI/Returns money is allowed to land on the
  -- approved proxy agent wallet when the ledger leg is explicitly tagged to
  -- the beneficiary partner. This is the production route for partner accounts
  -- managed by a proxy agent; FinOps later debits this same agent wallet.
  IF NEW.category IN ('roi_wallet_credit', 'roi_payout') THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.proxy_agent_assignments paa
      WHERE paa.agent_id = NEW.user_id
        AND paa.beneficiary_id = v_lp_uuid
        AND paa.is_active = true
        AND paa.approval_status = 'approved'
        AND paa.is_managed_account = true
    ) INTO v_is_approved_managed_proxy;

    IF v_is_approved_managed_proxy THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Otherwise block when the counterparty is a supporter.
  IF public.is_supporter(v_lp_uuid) THEN
    RAISE EXCEPTION 'PROXY_CUSTODY_BLOCKED: ledger writes that park partner % funds in agent % wallet are forbidden after %. Credit only the approved managed proxy agent route or the partner directly.',
      v_lp_uuid, NEW.user_id, v_cutoff
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;