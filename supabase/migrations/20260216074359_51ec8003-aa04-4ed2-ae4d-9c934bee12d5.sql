
-- Fix 1: Change target_month from TEXT to DATE to match the trigger's comparison
ALTER TABLE public.onboarding_targets ALTER COLUMN target_month TYPE DATE USING target_month::DATE;

-- Fix 2: The notify_landlord_registration trigger uses 'read' but the column is 'is_read'
CREATE OR REPLACE FUNCTION public.notify_landlord_registration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_landlord_profile RECORD;
  v_tenant_subscription RECORD;
  v_manager_id UUID;
  v_tenant_profile RECORD;
  v_notification_title TEXT;
  v_notification_message TEXT;
BEGIN
  IF NEW.role != 'landlord' OR NEW.enabled != true THEN
    RETURN NEW;
  END IF;
  
  SELECT full_name, phone INTO v_landlord_profile
  FROM public.profiles WHERE id = NEW.user_id;
  
  FOR v_tenant_subscription IN
    SELECT DISTINCT whs.id AS subscription_id, whs.tenant_id, whs.landlord_registered
    FROM public.welile_homes_subscriptions whs
    INNER JOIN public.rent_requests rr ON rr.tenant_id = whs.tenant_id
    WHERE rr.landlord_id = NEW.user_id
    AND whs.subscription_status = 'active'
    AND whs.landlord_registered = false
  LOOP
    SELECT full_name, phone INTO v_tenant_profile
    FROM public.profiles WHERE id = v_tenant_subscription.tenant_id;
    
    UPDATE public.welile_homes_subscriptions
    SET landlord_registered = true, landlord_id = NEW.user_id, updated_at = now()
    WHERE id = v_tenant_subscription.subscription_id;
    
    FOR v_manager_id IN
      SELECT user_id FROM public.user_roles WHERE role = 'manager' AND enabled = true
    LOOP
      v_notification_title := 'Landlord Registered - Welile Homes';
      v_notification_message := COALESCE(v_landlord_profile.full_name, 'A landlord') || 
        ' has registered on Welile. Tenant ' || 
        COALESCE(v_tenant_profile.full_name, 'Unknown') || 
        '''s Welile Homes savings are now active!';
      
      INSERT INTO public.notifications (user_id, title, message, type, is_read, metadata)
      VALUES (
        v_manager_id, v_notification_title, v_notification_message,
        'landlord_registered', false,
        jsonb_build_object(
          'landlord_id', NEW.user_id,
          'landlord_name', COALESCE(v_landlord_profile.full_name, 'Unknown'),
          'landlord_phone', v_landlord_profile.phone,
          'tenant_id', v_tenant_subscription.tenant_id,
          'tenant_name', COALESCE(v_tenant_profile.full_name, 'Unknown'),
          'tenant_phone', v_tenant_profile.phone,
          'subscription_id', v_tenant_subscription.subscription_id,
          'action_type', 'landlord_registered'
        )
      );
    END LOOP;
    
    INSERT INTO public.notifications (user_id, title, message, type, is_read, metadata)
    VALUES (
      v_tenant_subscription.tenant_id,
      '🎉 Your Landlord Registered!',
      'Great news! Your landlord ' || COALESCE(v_landlord_profile.full_name, '') || 
      ' has joined Welile. Your Welile Homes savings will now grow with every rent payment!',
      'welile_homes_activated', false,
      jsonb_build_object(
        'landlord_id', NEW.user_id,
        'landlord_name', COALESCE(v_landlord_profile.full_name, 'Unknown'),
        'subscription_id', v_tenant_subscription.subscription_id
      )
    );
  END LOOP;
  
  RETURN NEW;
END;
$$;

-- Fix 3: Also fix notify_landlord_role_enabled to use is_read
CREATE OR REPLACE FUNCTION public.notify_landlord_role_enabled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role = 'landlord' AND NEW.enabled = true AND (OLD.enabled = false OR OLD.enabled IS NULL) THEN
    PERFORM public.notify_landlord_registration_helper(NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;
