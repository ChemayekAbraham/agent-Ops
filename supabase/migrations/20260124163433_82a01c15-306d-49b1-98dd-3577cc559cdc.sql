-- Create function to notify managers when a landlord registers
-- This function is triggered when a new landlord role is assigned
CREATE OR REPLACE FUNCTION public.notify_landlord_registration()
RETURNS TRIGGER AS $$
DECLARE
  v_landlord_profile RECORD;
  v_tenant_subscription RECORD;
  v_manager_id UUID;
  v_tenant_profile RECORD;
  v_notification_title TEXT;
  v_notification_message TEXT;
BEGIN
  -- Only proceed if the new role is 'landlord' and is enabled
  IF NEW.role != 'landlord' OR NEW.enabled != true THEN
    RETURN NEW;
  END IF;
  
  -- Get landlord profile info
  SELECT full_name, phone INTO v_landlord_profile
  FROM public.profiles
  WHERE id = NEW.user_id;
  
  -- Find all tenants with Welile Homes subscriptions who have rent requests with this landlord
  FOR v_tenant_subscription IN
    SELECT DISTINCT 
      whs.id AS subscription_id,
      whs.tenant_id,
      whs.landlord_registered
    FROM public.welile_homes_subscriptions whs
    INNER JOIN public.rent_requests rr ON rr.tenant_id = whs.tenant_id
    WHERE rr.landlord_id = NEW.user_id
    AND whs.subscription_status = 'active'
    AND whs.landlord_registered = false
  LOOP
    -- Get tenant profile
    SELECT full_name, phone INTO v_tenant_profile
    FROM public.profiles
    WHERE id = v_tenant_subscription.tenant_id;
    
    -- Update the subscription to mark landlord as registered
    UPDATE public.welile_homes_subscriptions
    SET 
      landlord_registered = true,
      landlord_id = NEW.user_id,
      updated_at = now()
    WHERE id = v_tenant_subscription.subscription_id;
    
    -- Create notification for all managers
    FOR v_manager_id IN
      SELECT user_id FROM public.user_roles 
      WHERE role = 'manager' AND enabled = true
    LOOP
      v_notification_title := 'Landlord Registered - Welile Homes';
      v_notification_message := COALESCE(v_landlord_profile.full_name, 'A landlord') || 
        ' has registered on Welile. Tenant ' || 
        COALESCE(v_tenant_profile.full_name, 'Unknown') || 
        '''s Welile Homes savings are now active!';
      
      INSERT INTO public.notifications (
        user_id,
        title,
        message,
        type,
        read,
        metadata
      ) VALUES (
        v_manager_id,
        v_notification_title,
        v_notification_message,
        'landlord_registered',
        false,
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
    
    -- Also notify the tenant that their landlord registered
    INSERT INTO public.notifications (
      user_id,
      title,
      message,
      type,
      read,
      metadata
    ) VALUES (
      v_tenant_subscription.tenant_id,
      '🎉 Your Landlord Registered!',
      'Great news! Your landlord ' || COALESCE(v_landlord_profile.full_name, '') || 
      ' has joined Welile. Your Welile Homes savings will now grow with every rent payment!',
      'welile_homes_activated',
      false,
      jsonb_build_object(
        'landlord_id', NEW.user_id,
        'landlord_name', COALESCE(v_landlord_profile.full_name, 'Unknown'),
        'subscription_id', v_tenant_subscription.subscription_id
      )
    );
  END LOOP;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger on user_roles table for landlord registration
DROP TRIGGER IF EXISTS trigger_notify_landlord_registration ON public.user_roles;
CREATE TRIGGER trigger_notify_landlord_registration
AFTER INSERT ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.notify_landlord_registration();

-- Also handle when an existing user gets landlord role enabled
CREATE OR REPLACE FUNCTION public.notify_landlord_role_enabled()
RETURNS TRIGGER AS $$
BEGIN
  -- Only proceed if role is landlord and it's being enabled (was disabled, now enabled)
  IF NEW.role = 'landlord' AND NEW.enabled = true AND (OLD.enabled = false OR OLD.enabled IS NULL) THEN
    -- Reuse the same notification logic by calling the insert trigger function logic
    PERFORM public.notify_landlord_registration_helper(NEW.user_id);
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Helper function to handle notifications (used by both insert and update)
CREATE OR REPLACE FUNCTION public.notify_landlord_registration_helper(p_landlord_id UUID)
RETURNS void AS $$
DECLARE
  v_landlord_profile RECORD;
  v_tenant_subscription RECORD;
  v_manager_id UUID;
  v_tenant_profile RECORD;
  v_notification_title TEXT;
  v_notification_message TEXT;
BEGIN
  -- Get landlord profile info
  SELECT full_name, phone INTO v_landlord_profile
  FROM public.profiles
  WHERE id = p_landlord_id;
  
  -- Find all tenants with Welile Homes subscriptions who have rent requests with this landlord
  FOR v_tenant_subscription IN
    SELECT DISTINCT 
      whs.id AS subscription_id,
      whs.tenant_id,
      whs.landlord_registered
    FROM public.welile_homes_subscriptions whs
    INNER JOIN public.rent_requests rr ON rr.tenant_id = whs.tenant_id
    WHERE rr.landlord_id = p_landlord_id
    AND whs.subscription_status = 'active'
    AND whs.landlord_registered = false
  LOOP
    -- Get tenant profile
    SELECT full_name, phone INTO v_tenant_profile
    FROM public.profiles
    WHERE id = v_tenant_subscription.tenant_id;
    
    -- Update the subscription
    UPDATE public.welile_homes_subscriptions
    SET 
      landlord_registered = true,
      landlord_id = p_landlord_id,
      updated_at = now()
    WHERE id = v_tenant_subscription.subscription_id;
    
    -- Notify managers
    FOR v_manager_id IN
      SELECT user_id FROM public.user_roles 
      WHERE role = 'manager' AND enabled = true
    LOOP
      v_notification_title := 'Landlord Registered - Welile Homes';
      v_notification_message := COALESCE(v_landlord_profile.full_name, 'A landlord') || 
        ' has registered on Welile. Tenant ' || 
        COALESCE(v_tenant_profile.full_name, 'Unknown') || 
        '''s Welile Homes savings are now active!';
      
      INSERT INTO public.notifications (
        user_id,
        title,
        message,
        type,
        read,
        metadata
      ) VALUES (
        v_manager_id,
        v_notification_title,
        v_notification_message,
        'landlord_registered',
        false,
        jsonb_build_object(
          'landlord_id', p_landlord_id,
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
    
    -- Notify tenant
    INSERT INTO public.notifications (
      user_id,
      title,
      message,
      type,
      read,
      metadata
    ) VALUES (
      v_tenant_subscription.tenant_id,
      '🎉 Your Landlord Registered!',
      'Great news! Your landlord ' || COALESCE(v_landlord_profile.full_name, '') || 
      ' has joined Welile. Your Welile Homes savings will now grow with every rent payment!',
      'welile_homes_activated',
      false,
      jsonb_build_object(
        'landlord_id', p_landlord_id,
        'landlord_name', COALESCE(v_landlord_profile.full_name, 'Unknown'),
        'subscription_id', v_tenant_subscription.subscription_id
      )
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Create trigger for updating user_roles (enabling landlord role)
DROP TRIGGER IF EXISTS trigger_notify_landlord_role_enabled ON public.user_roles;
CREATE TRIGGER trigger_notify_landlord_role_enabled
AFTER UPDATE ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.notify_landlord_role_enabled();