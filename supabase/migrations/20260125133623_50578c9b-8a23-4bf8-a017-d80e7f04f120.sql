-- Create function to notify agents when rent requests get funded
CREATE OR REPLACE FUNCTION public.notify_agent_on_rent_funded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  agent_id_to_notify UUID;
  tenant_name TEXT;
  supporter_name TEXT;
BEGIN
  -- Only trigger when payment proof is verified (status changes to 'verified')
  IF NEW.status = 'verified' AND (OLD.status IS NULL OR OLD.status != 'verified') THEN
    
    -- Get the agent_id from the rent request
    SELECT rr.agent_id, p.full_name INTO agent_id_to_notify, tenant_name
    FROM public.rent_requests rr
    LEFT JOIN public.profiles p ON p.id = rr.tenant_id
    WHERE rr.id = NEW.rent_request_id;
    
    -- Get supporter name
    SELECT full_name INTO supporter_name FROM public.profiles WHERE id = NEW.supporter_id;
    
    -- If agent exists, send notification
    IF agent_id_to_notify IS NOT NULL THEN
      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        agent_id_to_notify,
        '🎉 Rent Request Funded!',
        'Great news! ' || COALESCE(supporter_name, 'A supporter') || ' has funded UGX ' || NEW.amount::text || ' for ' || COALESCE(tenant_name, 'your tenant') || '''s rent request.',
        'success',
        jsonb_build_object(
          'rent_request_id', NEW.rent_request_id,
          'payment_proof_id', NEW.id,
          'supporter_id', NEW.supporter_id,
          'amount', NEW.amount,
          'tenant_name', tenant_name,
          'send_push', true
        )
      );
      
      -- Send push notification via pg_net
      PERFORM net.http_post(
        url := current_setting('app.settings.supabase_url', true) || '/functions/v1/send-push-notification',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
        ),
        body := jsonb_build_object(
          'userIds', ARRAY[agent_id_to_notify::text],
          'payload', jsonb_build_object(
            'title', '🎉 Rent Request Funded!',
            'body', COALESCE(supporter_name, 'A supporter') || ' funded UGX ' || NEW.amount::text || ' for ' || COALESCE(tenant_name, 'your tenant'),
            'url', '/dashboard',
            'type', 'funding'
          )
        )
      );
    END IF;
  END IF;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'notify_agent_on_rent_funded error: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- Create trigger on landlord_payment_proofs
DROP TRIGGER IF EXISTS on_rent_funded_notify_agent ON public.landlord_payment_proofs;
CREATE TRIGGER on_rent_funded_notify_agent
  AFTER UPDATE ON public.landlord_payment_proofs
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_agent_on_rent_funded();