-- Agent bonus for posting a rent request: UGX 5,000, once per request, paid when
-- the landlord has actually been paid, and only if Tenant Operations approved it.
--
-- Enforced here, in the database, so it holds whatever path moves the payout
-- (merchant payout, FinOps disbursement, receipt confirmation, a manual fix).
--
-- When it fires
--   The same moment the repaying gate and the 1% payout commission already use:
--   a landlord_payouts row moving INTO awaiting_agent_receipt / disbursed /
--   completed. It fires on the transition into that set, not on every status
--   write, so the ~930 payouts already at awaiting_agent_receipt do not pay
--   when they later move on to completed. Nothing is back-paid; plans that are
--   approved but not yet paid out at deploy time do qualify when their payout
--   is made.
--
-- Who gets it
--   rent_requests.agent_id, the agent who posted the request. That is not always
--   the agent who raised the payout (they differ on ~3% of paid payouts).
--
-- What must be true
--   * Tenant Ops reviewed it (tenant_ops_reviewed_at and _by set).
--   * The poster is not the tenant (self-requests earn nothing).
--   * The plan is not rejected, cancelled or deleted by the agent.
--   * No earlier bonus exists: this one's own key, or the retired flat funding
--     bonus (fund-agent-landlord-float:<id>:bonus, last written 2026-09-24), so
--     a plan funded before the cut-over is not paid twice.
--
-- Ledger shape: the same balanced pair used by the other agent bonuses,
-- agent_commission_earned cash_in to the agent's wallet and agent_commission_earned
-- cash_out on the platform side (X3 Agent Commission Expense). Both legs are equal
-- so no skip_balance_check is needed.
--
-- This sits alongside the existing 1% commission on the same payout; it does not
-- replace it.
--
-- A failure here must never block a landlord payout, so errors are caught and
-- recorded in system_events (wallet_transfer / agent_posted_rent_bonus_failure).

CREATE OR REPLACE FUNCTION public.pay_agent_posted_rent_bonus_on_landlord_paid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c_bonus CONSTANT numeric := 5000;
  c_paid_states CONSTANT text[] := ARRAY['awaiting_agent_receipt', 'disbursed', 'completed'];
  v_rr record;
  v_key text;
  v_group uuid;
BEGIN
  -- Only the moment the landlord is first paid, never a later status change
  -- between two paid states.
  IF OLD.status = ANY (c_paid_states) THEN
    RETURN NEW;
  END IF;

  IF NEW.rent_request_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT rr.id, rr.agent_id, rr.tenant_id, rr.status,
           rr.tenant_ops_reviewed_at, rr.tenant_ops_reviewed_by
      INTO v_rr
      FROM public.rent_requests rr
     WHERE rr.id = NEW.rent_request_id;

    IF NOT FOUND THEN
      RETURN NEW;
    END IF;

    IF v_rr.agent_id IS NULL
       OR v_rr.agent_id = v_rr.tenant_id
       OR v_rr.tenant_ops_reviewed_at IS NULL
       OR v_rr.tenant_ops_reviewed_by IS NULL
       OR v_rr.status IN ('rejected', 'cancelled', 'deleted_by_agent') THEN
      RETURN NEW;
    END IF;

    v_key := 'agent-posted-rent-bonus-' || v_rr.id::text;

    -- The retired flat funding bonus already paid this plan's agent 5,000.
    IF EXISTS (
      SELECT 1 FROM public.general_ledger g
       WHERE g.idempotency_key = 'fund-agent-landlord-float:' || v_rr.id::text || ':bonus'
    ) THEN
      RETURN NEW;
    END IF;

    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_rr.agent_id,
          'amount', c_bonus,
          'direction', 'cash_in',
          'category', 'agent_commission_earned',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'source_table', 'rent_requests',
          'source_id', v_rr.id,
          'reference_id', v_key,
          'description', 'Bonus: rent request approved by Tenant Operations and the landlord paid',
          'currency', 'UGX',
          'transaction_date', now()
        ),
        jsonb_build_object(
          'amount', c_bonus,
          'direction', 'cash_out',
          'category', 'agent_commission_earned',
          'ledger_scope', 'platform',
          'source_table', 'rent_requests',
          'source_id', v_rr.id,
          'reference_id', v_key,
          'description', 'Platform expense: agent bonus for a rent request, paid after the landlord payout',
          'currency', 'UGX',
          'transaction_date', now()
        )
      ),
      v_key
    );

    INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
    VALUES (
      'funds_added'::public.system_event_type,
      v_rr.agent_id,
      'rent_request',
      v_rr.id,
      jsonb_build_object(
        'amount', c_bonus,
        'currency', 'UGX',
        'source', 'agent_posted_rent_bonus',
        'landlord_payout_id', NEW.id,
        'landlord_payout_status', NEW.status,
        'transaction_group_id', v_group
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pay_agent_posted_rent_bonus_on_landlord_paid failed for payout %: %', NEW.id, SQLERRM;
    BEGIN
      INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
      VALUES (
        'wallet_transfer'::public.system_event_type,
        NULL,
        'agent_posted_rent_bonus_failure',
        NEW.id,
        jsonb_build_object(
          'rent_request_id', NEW.rent_request_id,
          'landlord_payout_id', NEW.id,
          'error_code', SQLSTATE,
          'error_message', SQLERRM
        )
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.pay_agent_posted_rent_bonus_on_landlord_paid() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pay_agent_posted_rent_bonus ON public.landlord_payouts;
CREATE TRIGGER trg_pay_agent_posted_rent_bonus
  AFTER UPDATE OF status ON public.landlord_payouts
  FOR EACH ROW
  WHEN (NEW.status IN ('awaiting_agent_receipt', 'disbursed', 'completed'))
  EXECUTE FUNCTION public.pay_agent_posted_rent_bonus_on_landlord_paid();
