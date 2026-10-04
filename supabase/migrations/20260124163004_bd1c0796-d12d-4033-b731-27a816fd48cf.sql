-- Add last_interest_applied_at column to track monthly compound interest
ALTER TABLE public.welile_homes_subscriptions 
ADD COLUMN IF NOT EXISTS last_interest_applied_at TIMESTAMP WITH TIME ZONE DEFAULT now();

-- Create function to update Welile Homes savings when tenant makes a repayment
CREATE OR REPLACE FUNCTION public.update_welile_homes_savings()
RETURNS TRIGGER AS $$
DECLARE
  v_subscription RECORD;
  v_landlord_fee_rate NUMERIC := 0.10; -- 10% from landlord fee
  v_contribution NUMERIC;
  v_rent_request RECORD;
BEGIN
  -- Get the rent request to find the landlord and check if they're registered
  SELECT * INTO v_rent_request 
  FROM public.rent_requests 
  WHERE id = NEW.rent_request_id;
  
  IF v_rent_request IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Check if tenant has an active Welile Homes subscription
  SELECT * INTO v_subscription 
  FROM public.welile_homes_subscriptions 
  WHERE tenant_id = NEW.tenant_id 
  AND subscription_status = 'active';
  
  IF v_subscription IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Only add savings if landlord is registered
  IF NOT v_subscription.landlord_registered THEN
    RETURN NEW;
  END IF;
  
  -- Calculate contribution: 10% of the repayment amount (simulating landlord fee portion)
  v_contribution := NEW.amount * v_landlord_fee_rate;
  
  -- Update the subscription with new savings
  UPDATE public.welile_homes_subscriptions
  SET 
    total_savings = total_savings + v_contribution,
    updated_at = now()
  WHERE id = v_subscription.id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger on repayments table
DROP TRIGGER IF EXISTS trigger_update_welile_homes_savings ON public.repayments;
CREATE TRIGGER trigger_update_welile_homes_savings
AFTER INSERT ON public.repayments
FOR EACH ROW
EXECUTE FUNCTION public.update_welile_homes_savings();

-- Create function to apply monthly compound interest (5%)
CREATE OR REPLACE FUNCTION public.apply_welile_homes_monthly_interest()
RETURNS INTEGER AS $$
DECLARE
  v_monthly_rate NUMERIC := 0.05; -- 5% monthly compound
  v_updated_count INTEGER := 0;
BEGIN
  -- Apply 5% interest to all active subscriptions that haven't had interest applied this month
  UPDATE public.welile_homes_subscriptions
  SET 
    total_savings = total_savings * (1 + v_monthly_rate),
    months_enrolled = months_enrolled + 1,
    last_interest_applied_at = now(),
    updated_at = now()
  WHERE subscription_status = 'active'
  AND landlord_registered = true
  AND total_savings > 0
  AND (
    last_interest_applied_at IS NULL 
    OR last_interest_applied_at < date_trunc('month', now())
  );
  
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create a log table for tracking savings contributions
CREATE TABLE IF NOT EXISTS public.welile_homes_contributions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES public.welile_homes_subscriptions(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  repayment_id UUID REFERENCES public.repayments(id) ON DELETE SET NULL,
  contribution_type TEXT NOT NULL CHECK (contribution_type IN ('repayment', 'interest', 'manual_adjustment')),
  amount NUMERIC NOT NULL,
  balance_after NUMERIC NOT NULL,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.welile_homes_contributions ENABLE ROW LEVEL SECURITY;

-- RLS policies for contributions
CREATE POLICY "Tenants can view their own contributions"
ON public.welile_homes_contributions
FOR SELECT
USING (auth.uid() = tenant_id);

CREATE POLICY "Managers can view all contributions"
ON public.welile_homes_contributions
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = 'manager'
  )
);

-- Updated function that also logs contributions
CREATE OR REPLACE FUNCTION public.update_welile_homes_savings_with_log()
RETURNS TRIGGER AS $$
DECLARE
  v_subscription RECORD;
  v_landlord_fee_rate NUMERIC := 0.10;
  v_contribution NUMERIC;
  v_new_balance NUMERIC;
  v_rent_request RECORD;
BEGIN
  -- Get the rent request
  SELECT * INTO v_rent_request 
  FROM public.rent_requests 
  WHERE id = NEW.rent_request_id;
  
  IF v_rent_request IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Check if tenant has an active subscription
  SELECT * INTO v_subscription 
  FROM public.welile_homes_subscriptions 
  WHERE tenant_id = NEW.tenant_id 
  AND subscription_status = 'active';
  
  IF v_subscription IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Only add savings if landlord is registered
  IF NOT v_subscription.landlord_registered THEN
    RETURN NEW;
  END IF;
  
  -- Calculate contribution
  v_contribution := NEW.amount * v_landlord_fee_rate;
  v_new_balance := v_subscription.total_savings + v_contribution;
  
  -- Update subscription
  UPDATE public.welile_homes_subscriptions
  SET 
    total_savings = v_new_balance,
    updated_at = now()
  WHERE id = v_subscription.id;
  
  -- Log the contribution
  INSERT INTO public.welile_homes_contributions (
    subscription_id,
    tenant_id,
    repayment_id,
    contribution_type,
    amount,
    balance_after,
    notes
  ) VALUES (
    v_subscription.id,
    NEW.tenant_id,
    NEW.id,
    'repayment',
    v_contribution,
    v_new_balance,
    'Auto-calculated from rent repayment of ' || NEW.amount
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Replace the trigger with the logging version
DROP TRIGGER IF EXISTS trigger_update_welile_homes_savings ON public.repayments;
CREATE TRIGGER trigger_update_welile_homes_savings
AFTER INSERT ON public.repayments
FOR EACH ROW
EXECUTE FUNCTION public.update_welile_homes_savings_with_log();