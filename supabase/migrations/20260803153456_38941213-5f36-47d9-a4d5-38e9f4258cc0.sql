-- Helper: staff editor check
CREATE OR REPLACE FUNCTION public.is_sensitive_field_editor(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _uid
      AND role IN ('manager','super_admin','cto','ceo','coo','cfo','hr','operations',
                   'tenant_ops','landlord_ops','agent_ops','financial_ops','admin','access_admin')
  )
$$;

-- 1. profiles: block self-escalation of privileged columns
CREATE OR REPLACE FUNCTION public.guard_profile_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW; -- service role / cron / trigger context
  END IF;
  IF auth.uid() = NEW.id AND NOT public.is_sensitive_field_editor(auth.uid()) THEN
    NEW.verified := OLD.verified;
    NEW.is_frozen := OLD.is_frozen;
    NEW.frozen_reason := OLD.frozen_reason;
    NEW.agent_tier := OLD.agent_tier;
    NEW.rent_discount_active := OLD.rent_discount_active;
    NEW.managed_by_agent := OLD.managed_by_agent;
    NEW.managing_agent_id := OLD.managing_agent_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_profile_sensitive_columns ON public.profiles;
CREATE TRIGGER trg_guard_profile_sensitive_columns
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_profile_sensitive_columns();

-- 2. landlords: tenants cannot change verification / financial / payout fields
CREATE OR REPLACE FUNCTION public.guard_landlord_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF public.is_sensitive_field_editor(auth.uid())
     OR public.has_role(auth.uid(), 'agent'::app_role)
     OR public.has_role(auth.uid(), 'senior_agent'::app_role) THEN
    RETURN NEW;
  END IF;
  NEW.verified := OLD.verified;
  NEW.verified_at := OLD.verified_at;
  NEW.verified_by := OLD.verified_by;
  NEW.verification_status := OLD.verification_status;
  NEW.verification_reason := OLD.verification_reason;
  NEW.verification_pin_1 := OLD.verification_pin_1;
  NEW.verification_pin_2 := OLD.verification_pin_2;
  NEW.rent_balance_due := OLD.rent_balance_due;
  NEW.rent_last_paid_at := OLD.rent_last_paid_at;
  NEW.rent_last_paid_amount := OLD.rent_last_paid_amount;
  NEW.bank_name := OLD.bank_name;
  NEW.account_number := OLD.account_number;
  NEW.registration_bonus_paid := OLD.registration_bonus_paid;
  NEW.registration_bonus_paid_at := OLD.registration_bonus_paid_at;
  NEW.registration_verification_bonus_paid := OLD.registration_verification_bonus_paid;
  NEW.registration_verification_bonus_paid_at := OLD.registration_verification_bonus_paid_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_landlord_sensitive_columns ON public.landlords;
CREATE TRIGGER trg_guard_landlord_sensitive_columns
BEFORE UPDATE ON public.landlords
FOR EACH ROW EXECUTE FUNCTION public.guard_landlord_sensitive_columns();

-- 3. welile_homes_subscriptions: tenants cannot edit balances
CREATE OR REPLACE FUNCTION public.guard_subscription_financial_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF public.is_sensitive_field_editor(auth.uid()) THEN
    RETURN NEW;
  END IF;
  IF auth.uid() = OLD.tenant_id THEN
    NEW.monthly_rent := OLD.monthly_rent;
    NEW.monthly_landlord_fee := OLD.monthly_landlord_fee;
    NEW.receivable_total := OLD.receivable_total;
    NEW.outstanding_balance := OLD.outstanding_balance;
    NEW.total_savings := OLD.total_savings;
    NEW.next_due_date := OLD.next_due_date;
    NEW.months_enrolled := OLD.months_enrolled;
    NEW.mode := OLD.mode;
    NEW.subscription_status := OLD.subscription_status;
    NEW.last_interest_applied_at := OLD.last_interest_applied_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_subscription_financial_columns ON public.welile_homes_subscriptions;
CREATE TRIGGER trg_guard_subscription_financial_columns
BEFORE UPDATE ON public.welile_homes_subscriptions
FOR EACH ROW EXECUTE FUNCTION public.guard_subscription_financial_columns();

-- 4. credit_access_limits: self-insert must use default starter values only
DROP POLICY IF EXISTS "Users can insert own credit limit" ON public.credit_access_limits;
CREATE POLICY "Users can insert own starter credit limit"
ON public.credit_access_limits
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  AND COALESCE(base_limit, 30000) = 30000
  AND COALESCE(bonus_from_ratings, 0) = 0
  AND COALESCE(bonus_from_receipts, 0) = 0
  AND COALESCE(bonus_from_rent_history, 0) = 0
  AND COALESCE(bonus_from_landlord_rent, 0) = 0
  AND COALESCE(bonus_from_houses_listed, 0) = 0
  AND COALESCE(bonus_from_partners_onboarded, 0) = 0
  AND COALESCE(bonus_from_agent_allocations, 0) = 0
  AND COALESCE(bonus_from_subagents, 0) = 0
  AND COALESCE(total_limit, 30000) = 30000
);

-- 5. internal config tables: signed-in reads only
DROP POLICY IF EXISTS "kyc_level_config readable by anyone" ON public.kyc_level_config;
CREATE POLICY "kyc_level_config readable by authenticated"
ON public.kyc_level_config
FOR SELECT
TO authenticated
USING (true);

DROP POLICY IF EXISTS "Anyone can read tier mapping" ON public.agent_tier_capabilities;
CREATE POLICY "Authenticated can read tier mapping"
ON public.agent_tier_capabilities
FOR SELECT
TO authenticated
USING (true);

REVOKE SELECT ON public.kyc_level_config FROM anon;
REVOKE SELECT ON public.agent_tier_capabilities FROM anon;