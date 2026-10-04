CREATE OR REPLACE FUNCTION public.block_proxy_custody_writes()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_cutoff timestamptz;
  v_lp_uuid uuid;
  v_bypass text;
BEGIN
  -- Explicit bypass for one-off legacy reversals
  BEGIN v_bypass := current_setting('wallet.legacy_proxy_reversal', true); EXCEPTION WHEN OTHERS THEN v_bypass := NULL; END;
  IF v_bypass = 'true' THEN RETURN NEW; END IF;

  -- Only police wallet-scope legs that have a counterparty
  IF NEW.ledger_scope <> 'wallet' THEN RETURN NEW; END IF;
  IF NEW.linked_party IS NULL OR NEW.user_id IS NULL THEN RETURN NEW; END IF;

  -- *** CRITICAL FIX (2026-05-12) ***
  -- The guard's purpose is to stop partner funds from being PARKED in agent
  -- wallets going forward. Parking = a CREDIT (cash_in) lands on the agent.
  -- Spends out of an agent's wallet (cash_out) are exactly how legacy
  -- custody is drained and how agents pay tenant rent / landlords from
  -- their operational float. Those must always be allowed.
  IF NEW.direction <> 'cash_in' THEN RETURN NEW; END IF;

  -- Cutoff gate
  SELECT (value #>> '{}')::timestamptz INTO v_cutoff
    FROM public.system_config WHERE key = 'proxy_custody_cutoff_at';
  IF v_cutoff IS NULL OR NEW.created_at < v_cutoff THEN RETURN NEW; END IF;

  BEGIN v_lp_uuid := NEW.linked_party::uuid; EXCEPTION WHEN OTHERS THEN RETURN NEW; END;

  -- Self-reference is never custody
  IF v_lp_uuid = NEW.user_id THEN RETURN NEW; END IF;

  -- Only block when the counterparty is a supporter (i.e. partner funds being parked)
  IF public.is_supporter(v_lp_uuid) THEN
    RAISE EXCEPTION 'PROXY_CUSTODY_BLOCKED: ledger writes that park partner % funds in agent % wallet are forbidden after %. Credit the partner directly.',
      v_lp_uuid, NEW.user_id, v_cutoff
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;