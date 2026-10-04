
-- Column-level immutability for investor_portfolios
CREATE OR REPLACE FUNCTION public.enforce_investor_portfolio_field_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_privileged boolean;
BEGIN
  -- Backend/definer contexts (postgres, service_role) bypass entirely
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  v_privileged := public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'partner_ops');

  IF v_privileged THEN
    RETURN NEW;
  END IF;

  -- Financial / verification / identity fields are immutable for investors & agents
  NEW.investor_id                       := OLD.investor_id;
  NEW.agent_id                          := OLD.agent_id;
  NEW.invite_id                         := OLD.invite_id;
  NEW.portfolio_code                    := OLD.portfolio_code;
  NEW.investment_amount                 := OLD.investment_amount;
  NEW.duration_months                   := OLD.duration_months;
  NEW.roi_percentage                    := OLD.roi_percentage;
  NEW.roi_mode                          := OLD.roi_mode;
  NEW.status                            := OLD.status;
  NEW.maturity_date                     := OLD.maturity_date;
  NEW.next_roi_date                     := OLD.next_roi_date;
  NEW.total_roi_earned                  := OLD.total_roi_earned;
  NEW.payout_day                        := OLD.payout_day;
  NEW.auto_reinvest                     := OLD.auto_reinvest;
  NEW.cfo_verified                      := OLD.cfo_verified;
  NEW.cfo_verified_at                   := OLD.cfo_verified_at;
  NEW.cfo_verified_by                   := OLD.cfo_verified_by;
  NEW.cfo_rejection_reason              := OLD.cfo_rejection_reason;
  NEW.pending_renewal_effective_date    := OLD.pending_renewal_effective_date;
  NEW.pending_renewal_duration_months   := OLD.pending_renewal_duration_months;
  NEW.pending_renewal_request_id        := OLD.pending_renewal_request_id;
  NEW.activation_token                  := OLD.activation_token;
  NEW.portfolio_pin                     := OLD.portfolio_pin;
  NEW.investment_reference              := OLD.investment_reference;
  NEW.created_at                        := OLD.created_at;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_investor_portfolio_field_immutability ON public.investor_portfolios;
CREATE TRIGGER trg_enforce_investor_portfolio_field_immutability
BEFORE UPDATE ON public.investor_portfolios
FOR EACH ROW EXECUTE FUNCTION public.enforce_investor_portfolio_field_immutability();


-- Column-level immutability for welile_homes_subscriptions (tenant self-updates)
CREATE OR REPLACE FUNCTION public.enforce_welile_home_subscription_field_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_privileged boolean;
BEGIN
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  v_privileged := public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'tenant_ops')
    OR public.has_role(auth.uid(), 'financial_ops');

  IF v_privileged THEN
    RETURN NEW;
  END IF;

  -- Tenant may only change notification/statement preferences
  IF auth.uid() = OLD.tenant_id THEN
    NEW.tenant_id             := OLD.tenant_id;
    NEW.landlord_id           := OLD.landlord_id;
    NEW.agent_id              := OLD.agent_id;
    NEW.enrolled_by           := OLD.enrolled_by;
    NEW.monthly_rent          := OLD.monthly_rent;
    NEW.subscription_status   := OLD.subscription_status;
    NEW.landlord_registered   := OLD.landlord_registered;
    NEW.total_savings         := OLD.total_savings;
    NEW.months_enrolled       := OLD.months_enrolled;
    NEW.last_interest_applied_at := OLD.last_interest_applied_at;
    NEW.payout_day            := OLD.payout_day;
    NEW.monthly_landlord_fee  := OLD.monthly_landlord_fee;
    NEW.receivable_total      := OLD.receivable_total;
    NEW.outstanding_balance   := OLD.outstanding_balance;
    NEW.next_due_date         := OLD.next_due_date;
    NEW.mode                  := OLD.mode;
    NEW.landlord_name         := OLD.landlord_name;
    NEW.landlord_phone        := OLD.landlord_phone;
    NEW.landlord_uses_wallet  := OLD.landlord_uses_wallet;
    NEW.created_at            := OLD.created_at;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_welile_home_subscription_field_immutability ON public.welile_homes_subscriptions;
CREATE TRIGGER trg_enforce_welile_home_subscription_field_immutability
BEFORE UPDATE ON public.welile_homes_subscriptions
FOR EACH ROW EXECUTE FUNCTION public.enforce_welile_home_subscription_field_immutability();
