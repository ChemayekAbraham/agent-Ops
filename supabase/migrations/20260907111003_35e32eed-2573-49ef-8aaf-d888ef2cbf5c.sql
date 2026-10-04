CREATE OR REPLACE FUNCTION public.guard_investor_portfolio_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- Trusted server-side path (partner completion RPC) is exempt.
  IF coalesce(current_setting('welile.portfolio_trusted', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  IF public.is_welile_staff(v_uid) THEN RETURN NEW; END IF;
  IF v_uid IS DISTINCT FROM OLD.investor_id AND v_uid IS DISTINCT FROM OLD.agent_id THEN
    RETURN NEW;
  END IF;

  IF NEW.investment_amount IS DISTINCT FROM OLD.investment_amount
     OR NEW.roi_percentage IS DISTINCT FROM OLD.roi_percentage
     OR NEW.roi_mode IS DISTINCT FROM OLD.roi_mode
     OR NEW.duration_months IS DISTINCT FROM OLD.duration_months
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.maturity_date IS DISTINCT FROM OLD.maturity_date
     OR NEW.next_roi_date IS DISTINCT FROM OLD.next_roi_date
     OR NEW.total_roi_earned IS DISTINCT FROM OLD.total_roi_earned
     OR NEW.payout_day IS DISTINCT FROM OLD.payout_day
     OR NEW.cfo_verified IS DISTINCT FROM OLD.cfo_verified
     OR NEW.cfo_verified_at IS DISTINCT FROM OLD.cfo_verified_at
     OR NEW.cfo_verified_by IS DISTINCT FROM OLD.cfo_verified_by
     OR NEW.cfo_rejection_reason IS DISTINCT FROM OLD.cfo_rejection_reason
     OR NEW.investor_id IS DISTINCT FROM OLD.investor_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.invite_id IS DISTINCT FROM OLD.invite_id
     OR NEW.portfolio_code IS DISTINCT FROM OLD.portfolio_code
     OR NEW.activation_token IS DISTINCT FROM OLD.activation_token
     OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
     OR NEW.locked_by IS DISTINCT FROM OLD.locked_by
     OR NEW.lock_reason IS DISTINCT FROM OLD.lock_reason
     OR NEW.locked_from_portfolio_id IS DISTINCT FROM OLD.locked_from_portfolio_id
     OR NEW.pending_renewal_effective_date IS DISTINCT FROM OLD.pending_renewal_effective_date
     OR NEW.pending_renewal_duration_months IS DISTINCT FROM OLD.pending_renewal_duration_months
     OR NEW.pending_renewal_request_id IS DISTINCT FROM OLD.pending_renewal_request_id
     OR NEW.investment_reference IS DISTINCT FROM OLD.investment_reference
     OR NEW.receipt_file_url IS DISTINCT FROM OLD.receipt_file_url
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Only display and payout contact details can be changed on your own portfolio. Investment terms, returns and verification are set by Welile.';
  END IF;

  RETURN NEW;
END;
$$;