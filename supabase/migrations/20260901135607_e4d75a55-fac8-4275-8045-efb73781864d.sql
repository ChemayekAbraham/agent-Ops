CREATE OR REPLACE FUNCTION public.enforce_partner_ops_proxy_attachment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'partner_ops_approved'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    -- Requests Tenant Ops excluded from the Funder dashboard skip Partner Ops
    -- entirely (no proxy partner can ever be attached to them).
    IF COALESCE(NEW.funder_visible, true) = false THEN
      RETURN NEW;
    END IF;
    IF NEW.proxy_agent_id IS NULL THEN
      RAISE EXCEPTION 'A verified proxy agent must be attached before Partner Operations can forward this rent request'
        USING ERRCODE = '42501';
    END IF;
    IF NOT public.is_approved_proxy_agent(NEW.proxy_agent_id) THEN
      RAISE EXCEPTION 'Proxy agent % is not an approved (verified) proxy agent', NEW.proxy_agent_id
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;