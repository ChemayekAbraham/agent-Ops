-- Scope the merchant-landlord-payout gate on 'repaying' to NEW plans only.
-- (Josh, 2026-09-24: "for the existing already repaying plans don't tamper
-- with them, it should be only for the new plans that have been paid for and
-- the merchant agent confirms".)
--
-- 20260924100000 applied the rule to every plan and backfilled 31 existing
-- 'funded' plans to 'repaying'. This migration:
--   1. reverts those 31 to 'funded' (none had a collection in between, so
--      this restores their exact prior status; updated_at is not restorable);
--   2. makes the gate and the promotion apply only to plans funded at/after
--      the rollout (2026-09-24 06:22:48 UTC, the first application of
--      20260924100000). Plans funded before that keep the old behaviour
--      (first collection moves them to repaying) and are never auto-promoted.

CREATE OR REPLACE FUNCTION public.repaying_gate_applies(p_rent_request_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (SELECT COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) >= timestamptz '2026-09-24 06:22:48+00'
       AND COALESCE(rr.registration_type, 'normal') <> 'outstanding_balance'
     FROM public.rent_requests rr WHERE rr.id = p_rent_request_id),
    false);
$$;

COMMENT ON FUNCTION public.repaying_gate_applies(uuid) IS
  'True for plans governed by the merchant-landlord-payout repaying rule: funded (or created, if not yet funded) at/after the 2026-09-24 rollout, and not outstanding_balance. Plans older than the rollout are deliberately left on the old behaviour.';

CREATE OR REPLACE FUNCTION public.gate_repaying_on_merchant_landlord_payout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Evaluate cutover/exemption on NEW (funded_at may be set in this same
  -- statement), not via a re-read of the row.
  IF OLD.status IN ('repaying', 'completed')
     OR COALESCE(NEW.registration_type, 'normal') = 'outstanding_balance'
     OR COALESCE(NEW.funded_at, NEW.disbursed_at, NEW.created_at) < timestamptz '2026-09-24 06:22:48+00'
     OR public.rent_request_landlord_paid_by_merchant(NEW.id) THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'rejected' THEN
    RAISE EXCEPTION 'This Rent Plan cannot be set to repaying: the landlord payout has not yet been paid out by the merchant agent.'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.status := OLD.status;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (auth.uid(), 'repaying_held_no_merchant_landlord_payout', 'rent_requests', NEW.id::text,
            'lp_not_paid', jsonb_build_object('held_status', OLD.status));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.promote_rent_request_on_merchant_landlord_payout(p_rent_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_rent_request_id IS NULL
     OR NOT public.repaying_gate_applies(p_rent_request_id)
     OR NOT public.rent_request_landlord_paid_by_merchant(p_rent_request_id) THEN
    RETURN;
  END IF;

  BEGIN
    UPDATE public.rent_requests
       SET status = 'repaying', updated_at = now()
     WHERE id = p_rent_request_id
       AND status IN ('funded', 'disbursed', 'approved');
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
      VALUES (auth.uid(), 'repaying_promotion_failed', 'rent_requests', p_rent_request_id::text,
              'promo_err', jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
END;
$$;

-- Revert the 31-plan backfill from 20260924100000.
WITH reverted AS (
  UPDATE public.rent_requests rr
     SET status = 'funded', updated_at = now()
   WHERE rr.status = 'repaying'
     AND rr.id IN (SELECT a.record_id::uuid FROM public.audit_logs a
                    WHERE a.action_type = 'repaying_backfill_merchant_landlord_paid')
     AND NOT EXISTS (SELECT 1 FROM public.agent_collections ac
                      WHERE ac.rent_request_id = rr.id AND ac.created_at >= timestamptz '2026-09-24 06:22:48+00')
     AND NOT EXISTS (SELECT 1 FROM public.repayments r
                      WHERE r.rent_request_id = rr.id AND r.created_at >= timestamptz '2026-09-24 06:22:48+00')
  RETURNING rr.id
)
INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata)
SELECT 'repaying_backfill_reverted', 'rent_requests', r.id::text, 'revert',
       jsonb_build_object('migration', '20260924110000', 'restored_status', 'funded')
FROM reverted r;
