
-- Add fund routing tracking columns to rent_requests
ALTER TABLE public.rent_requests 
ADD COLUMN IF NOT EXISTS fund_recipient_type TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS fund_recipient_id UUID DEFAULT NULL,
ADD COLUMN IF NOT EXISTS fund_recipient_name TEXT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS fund_routed_at TIMESTAMPTZ DEFAULT NULL;

-- Create a function that auto-routes funds when a payment proof is verified
CREATE OR REPLACE FUNCTION public.auto_route_rent_funds()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rent_request RECORD;
  v_landlord RECORD;
  v_recipient_user_id UUID;
  v_recipient_type TEXT;
  v_recipient_name TEXT;
  v_caretaker_profile RECORD;
  v_landlord_profile RECORD;
  v_agent_profile RECORD;
BEGIN
  -- Only trigger when status changes to 'verified'
  IF NEW.status = 'verified' AND (OLD.status IS DISTINCT FROM 'verified') THEN
    
    -- Get the rent request
    SELECT * INTO v_rent_request FROM public.rent_requests WHERE id = NEW.rent_request_id;
    IF v_rent_request IS NULL THEN RETURN NEW; END IF;
    
    -- Get the landlord record
    SELECT * INTO v_landlord FROM public.landlords WHERE id = NEW.landlord_id;
    IF v_landlord IS NULL THEN RETURN NEW; END IF;
    
    -- Strategy 1: Check if landlord has a user account (match by phone)
    SELECT id, full_name INTO v_landlord_profile
    FROM public.profiles
    WHERE normalize_phone_last9(phone) = normalize_phone_last9(v_landlord.phone)
    LIMIT 1;
    
    IF v_landlord_profile.id IS NOT NULL AND v_landlord.has_smartphone IS NOT FALSE THEN
      v_recipient_user_id := v_landlord_profile.id;
      v_recipient_type := 'landlord';
      v_recipient_name := v_landlord.name;
    
    -- Strategy 2: Check if caretaker has a user account
    ELSIF v_landlord.caretaker_phone IS NOT NULL THEN
      SELECT id, full_name INTO v_caretaker_profile
      FROM public.profiles
      WHERE normalize_phone_last9(phone) = normalize_phone_last9(v_landlord.caretaker_phone)
      LIMIT 1;
      
      IF v_caretaker_profile.id IS NOT NULL THEN
        v_recipient_user_id := v_caretaker_profile.id;
        v_recipient_type := 'caretaker';
        v_recipient_name := COALESCE(v_landlord.caretaker_name, v_caretaker_profile.full_name);
      END IF;
    END IF;
    
    -- Strategy 3: Fall back to the agent who verified/registered
    IF v_recipient_user_id IS NULL THEN
      -- Try the agent from the rent request first
      IF v_rent_request.agent_id IS NOT NULL THEN
        SELECT full_name INTO v_agent_profile FROM public.profiles WHERE id = v_rent_request.agent_id;
        v_recipient_user_id := v_rent_request.agent_id;
        v_recipient_type := 'agent';
        v_recipient_name := COALESCE(v_agent_profile.full_name, 'Agent');
      -- Then try the landlord's registered_by
      ELSIF v_landlord.registered_by IS NOT NULL THEN
        SELECT full_name INTO v_agent_profile FROM public.profiles WHERE id = v_landlord.registered_by;
        v_recipient_user_id := v_landlord.registered_by;
        v_recipient_type := 'agent';
        v_recipient_name := COALESCE(v_agent_profile.full_name, 'Agent');
      END IF;
    END IF;
    
    -- If we found a recipient, credit their wallet
    IF v_recipient_user_id IS NOT NULL THEN
      -- Ensure wallet exists
      INSERT INTO public.wallets (user_id, balance)
      VALUES (v_recipient_user_id, 0)
      ON CONFLICT (user_id) DO NOTHING;
      
      -- Credit the wallet
      UPDATE public.wallets
      SET balance = balance + NEW.amount, updated_at = now()
      WHERE user_id = v_recipient_user_id;
      
      -- Update rent request with routing info
      UPDATE public.rent_requests
      SET fund_recipient_type = v_recipient_type,
          fund_recipient_id = v_recipient_user_id,
          fund_recipient_name = v_recipient_name,
          fund_routed_at = now()
      WHERE id = NEW.rent_request_id;
      
      -- Notify the recipient
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        v_recipient_user_id,
        '💰 Rent Funds Received!',
        'UGX ' || NEW.amount::text || ' rent payment for ' || 
          CASE v_recipient_type
            WHEN 'landlord' THEN 'your property'
            WHEN 'caretaker' THEN 'the property you manage'
            WHEN 'agent' THEN 'your landlord''s property (landlord not on platform)'
          END || ' has been deposited to your wallet.',
        'success',
        jsonb_build_object(
          'amount', NEW.amount,
          'rent_request_id', NEW.rent_request_id,
          'recipient_type', v_recipient_type
        )
      );
      
      -- Notify tenant about fund routing
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        v_rent_request.tenant_id,
        '🏠 Rent Payment Routed!',
        'Your rent of UGX ' || NEW.amount::text || ' has been sent to ' || v_recipient_name || 
          ' (' || v_recipient_type || ').',
        'success',
        jsonb_build_object(
          'recipient_type', v_recipient_type,
          'recipient_name', v_recipient_name,
          'amount', NEW.amount
        )
      );
      
      -- Notify all managers
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      SELECT 
        ur.user_id,
        '📋 Funds Routed: ' || v_recipient_type,
        'UGX ' || NEW.amount::text || ' routed to ' || v_recipient_name || ' (' || v_recipient_type || ') for rent request.',
        'info',
        jsonb_build_object(
          'rent_request_id', NEW.rent_request_id,
          'recipient_type', v_recipient_type,
          'recipient_id', v_recipient_user_id,
          'amount', NEW.amount
        )
      FROM public.user_roles ur
      WHERE ur.role = 'manager' AND ur.enabled = true;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger on landlord_payment_proofs
DROP TRIGGER IF EXISTS on_payment_proof_verified ON public.landlord_payment_proofs;
CREATE TRIGGER on_payment_proof_verified
  AFTER UPDATE ON public.landlord_payment_proofs
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_route_rent_funds();
