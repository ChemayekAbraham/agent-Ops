-- A rent plan may only move INTO status 'repaying' once the agent's landlord
-- payout withdrawal has been marked completed and paid out by the merchant
-- agent. (Josh, 2026-09-24.)
--
-- Before this migration, three things put a plan on 'repaying' with no
-- landlord-payout check at all:
--   * agent_allocate_tenant_payment_internal  — first collection flips
--     funded/disbursed/approved -> repaying
--   * settle_tenant_rent_from_deposit         — same, from a tenant deposit
--   * guard_rent_request_agent_updates        — coerces an agent's trusted
--     allocation update into 'repaying'
--   * TenantProfileView.tsx restore button    — rejected -> repaying, direct
-- Live at time of writing: 1 'repaying' plan whose only landlord payout is
-- unpaid, and 31 'funded' plans whose landlord WAS paid by the merchant but
-- never moved to 'repaying' because no collection had landed yet.
--
-- Evidence ("paid out by the merchant agent") requires BOTH:
--   landlord_payouts.status IN ('awaiting_agent_receipt','completed')
--   AND the linked withdrawal_requests row (landlord_payout_id) is
--   'completed'/'paid'.
-- Either alone is unsafe: one live payout is 'failed' while its merchant
-- withdrawal says 'completed'. 'awaiting_agent_receipt' is exactly the state
-- advance_landlord_payout_on_withdrawal_completion sets when the merchant
-- marks the withdrawal completed; the agent's receipt upload (-> 'completed')
-- is paperwork after the money has moved, so it is not waited for.
--
-- Exempt: registration_type = 'outstanding_balance' — those plans never pay a
-- landlord on-platform (rent_requests_outstanding_pipeline_guard sends them
-- straight to 'repaying' after Landlord Ops approval).
--
-- Not gated: completed -> repaying (a reversal re-opening a plan that was
-- already repaying before it closed).
--
-- Existing 'repaying' plans without evidence are NOT demoted here — see
-- docs/HANDOVER/117 for the list and the decision left to Finance.

CREATE OR REPLACE FUNCTION public.rent_request_landlord_paid_by_merchant(p_rent_request_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.landlord_payouts lp
    JOIN public.withdrawal_requests w ON w.landlord_payout_id = lp.id
    WHERE lp.rent_request_id = p_rent_request_id
      AND lp.status IN ('awaiting_agent_receipt', 'completed')
      AND w.status IN ('completed', 'paid')
  );
$$;

COMMENT ON FUNCTION public.rent_request_landlord_paid_by_merchant(uuid) IS
  'True once a landlord payout for this rent plan has been paid out by the merchant agent (payout advanced to awaiting_agent_receipt/completed AND its withdrawal completed). The sole precondition for a plan entering status repaying.';

-- ── Gate: hold the status transition until the evidence exists ──────────
-- Runs as a plain BEFORE UPDATE (not UPDATE OF status) with a WHEN clause so
-- it also catches status changes made by earlier BEFORE triggers
-- (guard_rent_request_agent_updates, rent_requests_outstanding_pipeline_guard)
-- on statements that never named the status column. The zz_ prefix makes it
-- fire after them (BEFORE triggers run in name order).
CREATE OR REPLACE FUNCTION public.gate_repaying_on_merchant_landlord_payout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.status IN ('repaying', 'completed')
     OR COALESCE(NEW.registration_type, 'normal') = 'outstanding_balance'
     OR public.rent_request_landlord_paid_by_merchant(NEW.id) THEN
    RETURN NEW;
  END IF;

  -- A human explicitly restoring a rejected plan gets a clear error rather
  -- than a silent no-op that the UI would report as success.
  IF OLD.status = 'rejected' THEN
    RAISE EXCEPTION 'This Rent Plan cannot be set to repaying: the landlord payout has not yet been paid out by the merchant agent.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Automatic side-effect of a collection/deposit (funded/disbursed/approved
  -- -> repaying): keep the collection, keep the old status. The collection
  -- RPCs must not fail just because the landlord has not been paid yet.
  NEW.status := OLD.status;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (auth.uid(), 'repaying_held_no_merchant_landlord_payout', 'rent_requests', NEW.id::text,
            'lp_not_paid', jsonb_build_object('held_status', OLD.status));
  EXCEPTION WHEN OTHERS THEN
    NULL; -- audit is best-effort; never block the underlying write
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_gate_repaying_on_merchant_landlord_payout ON public.rent_requests;
CREATE TRIGGER zz_gate_repaying_on_merchant_landlord_payout
  BEFORE UPDATE ON public.rent_requests
  FOR EACH ROW
  WHEN (NEW.status = 'repaying' AND OLD.status IS DISTINCT FROM 'repaying')
  EXECUTE FUNCTION public.gate_repaying_on_merchant_landlord_payout();

-- ── Promotion: once the merchant pays the landlord, the plan is repaying ─
CREATE OR REPLACE FUNCTION public.promote_rent_request_on_merchant_landlord_payout(p_rent_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_rent_request_id IS NULL
     OR NOT public.rent_request_landlord_paid_by_merchant(p_rent_request_id) THEN
    RETURN;
  END IF;

  BEGIN
    UPDATE public.rent_requests
       SET status = 'repaying', updated_at = now()
     WHERE id = p_rent_request_id
       AND status IN ('funded', 'disbursed', 'approved');
  EXCEPTION WHEN OTHERS THEN
    -- Never roll back the merchant's payout completion because a downstream
    -- rent_requests guard objected; leave a trail instead.
    BEGIN
      INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
      VALUES (auth.uid(), 'repaying_promotion_failed', 'rent_requests', p_rent_request_id::text,
              'promo_err', jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.promote_rent_request_on_merchant_landlord_payout(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_promote_repaying_from_landlord_payout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.promote_rent_request_on_merchant_landlord_payout(NEW.rent_request_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_promote_repaying_from_landlord_payout ON public.landlord_payouts;
CREATE TRIGGER trg_promote_repaying_from_landlord_payout
  AFTER UPDATE OF status ON public.landlord_payouts
  FOR EACH ROW
  WHEN (NEW.status IN ('awaiting_agent_receipt', 'completed') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_promote_repaying_from_landlord_payout();

-- The payout may advance before or after its withdrawal is marked completed
-- (approve-withdrawal updates both, plus the existing AFTER trigger), so
-- watch both sides; whichever lands second sees full evidence.
CREATE OR REPLACE FUNCTION public.trg_promote_repaying_from_withdrawal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public.promote_rent_request_on_merchant_landlord_payout(
    (SELECT lp.rent_request_id FROM public.landlord_payouts lp WHERE lp.id = NEW.landlord_payout_id)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_zz_promote_repaying_from_withdrawal ON public.withdrawal_requests;
CREATE TRIGGER trg_zz_promote_repaying_from_withdrawal
  AFTER UPDATE OF status ON public.withdrawal_requests
  FOR EACH ROW
  WHEN (NEW.landlord_payout_id IS NOT NULL AND NEW.status IN ('completed', 'paid') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_promote_repaying_from_withdrawal();

-- ── Backfill: funded plans whose landlord the merchant already paid ─────
WITH promoted AS (
  UPDATE public.rent_requests rr
     SET status = 'repaying', updated_at = now()
   WHERE rr.status IN ('funded', 'disbursed', 'approved')
     AND COALESCE(rr.registration_type, 'normal') <> 'outstanding_balance'
     AND public.rent_request_landlord_paid_by_merchant(rr.id)
  RETURNING rr.id, rr.tenant_id
)
INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata)
SELECT 'repaying_backfill_merchant_landlord_paid', 'rent_requests', p.id::text, 'backfill',
       jsonb_build_object('tenant_id', p.tenant_id, 'migration', '20260924100000')
FROM promoted p;
