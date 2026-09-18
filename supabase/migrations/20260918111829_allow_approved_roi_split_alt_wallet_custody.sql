-- Narrow, audited exception to block_proxy_custody_writes() for a
-- COO+CFO two-person-approved "split ROI to a different person's wallet"
-- redirect (operation_type = 'roi_split_alt_wallet', see
-- src/components/coo/COOPartnersPage.tsx handleSplitPayout and
-- docs/HANDOVER/70-split-roi-payout-to-a-different-wallet.md).
--
-- Discovered live 2026-09-18: crediting a redirected split's cash portion
-- (or fixing the Keep-as-Returns leg to actually land in the wallet) hit
-- PROXY_CUSTODY_BLOCKED, because the trigger only ever allowed a partner's
-- own wallet or an approved MANAGED proxy agent's wallet. A one-off
-- staff-approved redirect to an arbitrary recipient is neither.
--
-- This does not weaken the guard for anything else: the exception only
-- fires for category 'roi_wallet_credit' AND an actual, matching
-- pending_wallet_operations row (same reference_id, same recipient as
-- target_wallet_user_id, not rejected/cancelled, coo_approved_by already
-- recorded) -- i.e. a write that already passed the same two-person
-- approval chain every other ROI payout goes through. It is a database
-- check against a real approved record, not a session flag that could be
-- left "on" or forged from elsewhere.

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
  BEGIN v_bypass := current_setting('wallet.legacy_proxy_reversal', true); EXCEPTION WHEN OTHERS THEN v_bypass := NULL; END;
  IF v_bypass = 'true' THEN RETURN NEW; END IF;

  IF NEW.ledger_scope <> 'wallet' THEN RETURN NEW; END IF;
  IF NEW.linked_party IS NULL OR NEW.user_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.direction <> 'cash_in' THEN RETURN NEW; END IF;

  IF NEW.category IN ('agent_commission_earned', 'agent_commission_payable', 'agent_commission') THEN
    RETURN NEW;
  END IF;

  SELECT (value #>> '{}')::timestamptz INTO v_cutoff
    FROM public.system_config WHERE key = 'proxy_custody_cutoff_at';
  IF v_cutoff IS NULL OR NEW.created_at < v_cutoff THEN RETURN NEW; END IF;

  BEGIN v_lp_uuid := NEW.linked_party::uuid; EXCEPTION WHEN OTHERS THEN RETURN NEW; END;
  IF v_lp_uuid = NEW.user_id THEN RETURN NEW; END IF;

  IF NEW.category IN ('roi_wallet_credit', 'roi_payout', 'partner_commission') THEN
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

    IF NEW.category = 'roi_wallet_credit' AND EXISTS (
      SELECT 1 FROM public.pending_wallet_operations pwo
      WHERE pwo.reference_id = NEW.reference_id
        AND pwo.operation_type = 'roi_split_alt_wallet'
        AND pwo.target_wallet_user_id = NEW.user_id
        AND pwo.status NOT IN ('rejected', 'cancelled')
        AND pwo.metadata ->> 'coo_approved_by' IS NOT NULL
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF public.is_supporter(v_lp_uuid) THEN
    RAISE EXCEPTION 'PROXY_CUSTODY_BLOCKED: ledger writes that park partner % funds in agent % wallet are forbidden after %. Credit only the approved managed proxy agent route or the partner directly.',
      v_lp_uuid, NEW.user_id, v_cutoff
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;
