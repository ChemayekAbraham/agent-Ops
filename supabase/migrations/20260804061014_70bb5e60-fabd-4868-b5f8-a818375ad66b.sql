CREATE OR REPLACE FUNCTION public.reactivate_rent_payment_status_on_collection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rr public.rent_requests;
BEGIN
  IF NEW.rent_request_id IS NULL OR COALESCE(NEW.amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_rr
    FROM public.rent_requests
   WHERE id = NEW.rent_request_id;

  IF v_rr.id IS NULL OR v_rr.agent_payment_status <> 'not_paying' THEN
    RETURN NEW;
  END IF;

  UPDATE public.rent_requests
     SET agent_payment_status = 'paying',
         agent_payment_status_reason = 'auto_reactivated_on_collection',
         agent_payment_status_set_at = now(),
         agent_payment_status_set_by = NEW.agent_id
   WHERE id = NEW.rent_request_id;

  INSERT INTO public.audit_logs (
    user_id,
    action_type,
    table_name,
    record_id,
    action,
    metadata
  )
  VALUES (
    NEW.agent_id,
    'rent.payment_status_changed',
    'rent_requests',
    NEW.rent_request_id::text,
    'Automatically reactivated tenant payment status after a verified collection',
    jsonb_build_object(
      'reason', 'auto_reactivated_on_collection',
      'new_status', 'paying',
      'trigger', 'agent_collection',
      'collection_amount', NEW.amount
    )
  );

  RETURN NEW;
END;
$$;