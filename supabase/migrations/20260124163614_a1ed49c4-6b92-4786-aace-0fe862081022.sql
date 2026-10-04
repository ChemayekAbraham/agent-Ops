-- Create Welile Homes withdrawal requests table
CREATE TABLE public.welile_homes_withdrawals (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES public.welile_homes_subscriptions(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL CHECK (amount > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('buying_land', 'buying_home', 'building_house', 'mortgage_down_payment', 'other_after_24_months')),
  purpose_details TEXT,
  supporting_documents TEXT[], -- URLs to uploaded documents
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'disbursed')),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  rejection_reason TEXT,
  disbursed_at TIMESTAMP WITH TIME ZONE,
  disbursement_method TEXT,
  disbursement_reference TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.welile_homes_withdrawals ENABLE ROW LEVEL SECURITY;

-- Tenants can view their own withdrawal requests
CREATE POLICY "Tenants can view their own withdrawals"
ON public.welile_homes_withdrawals
FOR SELECT
USING (auth.uid() = tenant_id);

-- Tenants can create withdrawal requests
CREATE POLICY "Tenants can create withdrawal requests"
ON public.welile_homes_withdrawals
FOR INSERT
WITH CHECK (auth.uid() = tenant_id);

-- Managers can view all withdrawal requests
CREATE POLICY "Managers can view all withdrawals"
ON public.welile_homes_withdrawals
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = 'manager'
  )
);

-- Managers can update withdrawal requests
CREATE POLICY "Managers can update withdrawals"
ON public.welile_homes_withdrawals
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid()
    AND user_roles.role = 'manager'
  )
);

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_welile_homes_withdrawals_updated_at
BEFORE UPDATE ON public.welile_homes_withdrawals
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Function to handle withdrawal approval - deducts from savings
CREATE OR REPLACE FUNCTION public.process_welile_homes_withdrawal()
RETURNS TRIGGER AS $$
DECLARE
  v_subscription RECORD;
  v_manager_profile RECORD;
  v_tenant_profile RECORD;
BEGIN
  -- Only process when status changes to 'approved' or 'disbursed'
  IF NEW.status = 'approved' AND OLD.status = 'pending' THEN
    -- Get subscription
    SELECT * INTO v_subscription
    FROM public.welile_homes_subscriptions
    WHERE id = NEW.subscription_id;
    
    -- Check if sufficient balance
    IF v_subscription.total_savings < NEW.amount THEN
      RAISE EXCEPTION 'Insufficient savings balance';
    END IF;
    
    -- Deduct from savings
    UPDATE public.welile_homes_subscriptions
    SET 
      total_savings = total_savings - NEW.amount,
      updated_at = now()
    WHERE id = NEW.subscription_id;
    
    -- Log the contribution (negative for withdrawal)
    INSERT INTO public.welile_homes_contributions (
      subscription_id,
      tenant_id,
      contribution_type,
      amount,
      balance_after,
      notes
    ) VALUES (
      NEW.subscription_id,
      NEW.tenant_id,
      'manual_adjustment',
      -NEW.amount,
      v_subscription.total_savings - NEW.amount,
      'Withdrawal approved for: ' || NEW.purpose
    );
    
    -- Get tenant profile for notification
    SELECT full_name INTO v_tenant_profile
    FROM public.profiles
    WHERE id = NEW.tenant_id;
    
    -- Notify tenant of approval
    INSERT INTO public.notifications (
      user_id,
      title,
      message,
      type,
      read,
      metadata
    ) VALUES (
      NEW.tenant_id,
      '✅ Withdrawal Approved!',
      'Your Welile Homes withdrawal request of ' || NEW.amount || ' has been approved for ' || 
      REPLACE(NEW.purpose, '_', ' ') || '. Disbursement will follow shortly.',
      'welile_homes_withdrawal',
      false,
      jsonb_build_object(
        'withdrawal_id', NEW.id,
        'amount', NEW.amount,
        'purpose', NEW.purpose,
        'status', 'approved'
      )
    );
  
  ELSIF NEW.status = 'rejected' AND OLD.status = 'pending' THEN
    -- Notify tenant of rejection
    INSERT INTO public.notifications (
      user_id,
      title,
      message,
      type,
      read,
      metadata
    ) VALUES (
      NEW.tenant_id,
      '❌ Withdrawal Request Rejected',
      'Your Welile Homes withdrawal request has been rejected. Reason: ' || COALESCE(NEW.rejection_reason, 'Not specified'),
      'welile_homes_withdrawal',
      false,
      jsonb_build_object(
        'withdrawal_id', NEW.id,
        'amount', NEW.amount,
        'purpose', NEW.purpose,
        'status', 'rejected',
        'reason', NEW.rejection_reason
      )
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger for withdrawal processing
DROP TRIGGER IF EXISTS trigger_process_welile_homes_withdrawal ON public.welile_homes_withdrawals;
CREATE TRIGGER trigger_process_welile_homes_withdrawal
AFTER UPDATE ON public.welile_homes_withdrawals
FOR EACH ROW
EXECUTE FUNCTION public.process_welile_homes_withdrawal();

-- Function to notify managers of new withdrawal requests
CREATE OR REPLACE FUNCTION public.notify_new_welile_homes_withdrawal()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_profile RECORD;
  v_manager_id UUID;
BEGIN
  -- Get tenant profile
  SELECT full_name, phone INTO v_tenant_profile
  FROM public.profiles
  WHERE id = NEW.tenant_id;
  
  -- Notify all managers
  FOR v_manager_id IN
    SELECT user_id FROM public.user_roles 
    WHERE role = 'manager' AND enabled = true
  LOOP
    INSERT INTO public.notifications (
      user_id,
      title,
      message,
      type,
      read,
      metadata
    ) VALUES (
      v_manager_id,
      '🏠 New Welile Homes Withdrawal Request',
      COALESCE(v_tenant_profile.full_name, 'A tenant') || ' has requested a withdrawal of ' || 
      NEW.amount || ' for ' || REPLACE(NEW.purpose, '_', ' '),
      'welile_homes_withdrawal_request',
      false,
      jsonb_build_object(
        'withdrawal_id', NEW.id,
        'tenant_id', NEW.tenant_id,
        'tenant_name', COALESCE(v_tenant_profile.full_name, 'Unknown'),
        'tenant_phone', v_tenant_profile.phone,
        'amount', NEW.amount,
        'purpose', NEW.purpose,
        'action_type', 'withdrawal_request'
      )
    );
  END LOOP;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger for new withdrawal notification
DROP TRIGGER IF EXISTS trigger_notify_new_welile_homes_withdrawal ON public.welile_homes_withdrawals;
CREATE TRIGGER trigger_notify_new_welile_homes_withdrawal
AFTER INSERT ON public.welile_homes_withdrawals
FOR EACH ROW
EXECUTE FUNCTION public.notify_new_welile_homes_withdrawal();

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.welile_homes_withdrawals;