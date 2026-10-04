-- 1. Shared dispatcher: in-app notification for both agents + SMS to the receiving agent
CREATE OR REPLACE FUNCTION public.dispatch_tenant_transfer_notice(
  p_tenant_id uuid,
  p_from_agent_id uuid,
  p_to_agent_id uuid,
  p_reason text,
  p_source text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_name text;
  v_tenant_phone text;
  v_from_name text;
  v_to_name text;
  v_supabase_url text := 'https://wirntoujqoyjobfhyelc.supabase.co';
  v_service_key text;
BEGIN
  SELECT full_name, phone INTO v_tenant_name, v_tenant_phone FROM public.profiles WHERE id = p_tenant_id;
  SELECT full_name INTO v_from_name FROM public.profiles WHERE id = p_from_agent_id;
  SELECT full_name INTO v_to_name FROM public.profiles WHERE id = p_to_agent_id;
  v_tenant_name := COALESCE(v_tenant_name, 'a tenant');

  IF p_to_agent_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      p_to_agent_id,
      'Tenant assigned to you',
      v_tenant_name || COALESCE(' (' || v_tenant_phone || ')', '') ||
        ' has been transferred to you' || COALESCE(' from ' || v_from_name, '') ||
        '. Reason: ' || COALESCE(NULLIF(btrim(p_reason), ''), 'not stated'),
      'info',
      jsonb_build_object('tenant_id', p_tenant_id, 'from_agent_id', p_from_agent_id, 'to_agent_id', p_to_agent_id, 'source', p_source)
    );
  END IF;

  IF p_from_agent_id IS NOT NULL AND p_from_agent_id IS DISTINCT FROM p_to_agent_id THEN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      p_from_agent_id,
      'Tenant moved off your list',
      v_tenant_name || ' is no longer assigned to you' || COALESCE(' — moved to ' || v_to_name, '') ||
        '. Reason: ' || COALESCE(NULLIF(btrim(p_reason), ''), 'not stated'),
      'info',
      jsonb_build_object('tenant_id', p_tenant_id, 'from_agent_id', p_from_agent_id, 'to_agent_id', p_to_agent_id, 'source', p_source)
    );
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
    IF v_service_key IS NULL THEN
      SELECT decrypted_secret INTO v_service_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key' LIMIT 1;
    END IF;
    IF v_service_key IS NOT NULL AND p_to_agent_id IS NOT NULL THEN
      PERFORM net.http_post(
        url := v_supabase_url || '/functions/v1/tenant-transfer-sms',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_service_key),
        body := jsonb_build_object(
          'tenant_id', p_tenant_id,
          'from_agent_id', p_from_agent_id,
          'to_agent_id', p_to_agent_id,
          'reason', p_reason,
          'source', p_source
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[dispatch_tenant_transfer_notice] sms dispatch failed: %', SQLERRM;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_tenant_transfer_notice(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_tenant_transfer_notice(uuid, uuid, uuid, text, text) TO service_role;

-- 2. Fire on every recorded transfer
CREATE OR REPLACE FUNCTION public.trg_tenant_transfer_notice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.dispatch_tenant_transfer_notice(
    NEW.tenant_id, NEW.from_agent_id, NEW.to_agent_id, NEW.reason, COALESCE(NEW.flag_type, 'tenant_transfer')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_tenant_transfer ON public.tenant_transfers;
CREATE TRIGGER trg_notify_tenant_transfer
AFTER INSERT ON public.tenant_transfers
FOR EACH ROW EXECUTE FUNCTION public.trg_tenant_transfer_notice();

CREATE OR REPLACE FUNCTION public.trg_tenant_reassignment_notice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.dispatch_tenant_transfer_notice(
    NEW.tenant_id, NEW.old_agent_id, NEW.new_agent_id, NEW.reason, 'idle_reassignment'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_tenant_reassignment ON public.tenant_reassignment_audit;
CREATE TRIGGER trg_notify_tenant_reassignment
AFTER INSERT ON public.tenant_reassignment_audit
FOR EACH ROW EXECUTE FUNCTION public.trg_tenant_reassignment_notice();

-- 3. Manual rent-request reassignment must also land in the transfer history
CREATE OR REPLACE FUNCTION public.reassign_rent_request_agent(p_rent_request_id uuid, p_new_agent_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_caller uuid := auth.uid(); v_rr record;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.has_role(v_caller, 'landlord_ops') OR public.has_role(v_caller, 'manager')) THEN RAISE EXCEPTION 'Only Landlord Ops or Manager can reassign the rent request agent'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;
  IF NOT public.has_role(p_new_agent_id, 'agent') THEN RAISE EXCEPTION 'Target user is not an agent'; END IF;
  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rent request not found'; END IF;
  UPDATE public.rent_requests SET agent_id = p_new_agent_id, updated_at = now() WHERE id = p_rent_request_id;

  INSERT INTO public.tenant_transfers (tenant_id, from_agent_id, to_agent_id, transferred_by, reason, flag_type, rent_requests_updated, subscriptions_updated)
  VALUES (v_rr.tenant_id, v_rr.agent_id, p_new_agent_id, v_caller, trim(p_reason), 'manual_reassignment', 1, 0);

  INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
  VALUES (v_caller, 'rent_request_agent_reassigned', 'rent_request_agent_reassigned', 'rent_requests', p_rent_request_id::text,
          jsonb_build_object('reason', p_reason, 'previous_agent_id', v_rr.agent_id, 'new_agent_id', p_new_agent_id, 'tenant_id', v_rr.tenant_id));
  INSERT INTO public.system_events (event_type, payload, source)
  VALUES ('rent_request.agent_reassigned', jsonb_build_object('rent_request_id', p_rent_request_id, 'tenant_id', v_rr.tenant_id, 'previous_agent_id', v_rr.agent_id, 'new_agent_id', p_new_agent_id, 'actor_id', v_caller, 'reason', p_reason), 'reassign_rent_request_agent');
  RETURN jsonb_build_object('ok', true, 'rent_request_id', p_rent_request_id, 'agent_id', p_new_agent_id);
END;
$$;

-- 4. Migration history for the Tenant Ops tenant profile
CREATE OR REPLACE FUNCTION public.get_tenant_transfer_history(p_tenant_id uuid)
RETURNS TABLE (
  id uuid,
  occurred_at timestamptz,
  source text,
  from_agent_id uuid,
  from_agent_name text,
  to_agent_id uuid,
  to_agent_name text,
  actor_id uuid,
  actor_name text,
  reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id, t.created_at, COALESCE(t.flag_type, 'tenant_transfer'),
         t.from_agent_id, fp.full_name, t.to_agent_id, tp.full_name,
         t.transferred_by, ap.full_name, t.reason
    FROM public.tenant_transfers t
    LEFT JOIN public.profiles fp ON fp.id = t.from_agent_id
    LEFT JOIN public.profiles tp ON tp.id = t.to_agent_id
    LEFT JOIN public.profiles ap ON ap.id = t.transferred_by
   WHERE t.tenant_id = p_tenant_id
     AND (public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'))
  UNION ALL
  SELECT r.id, r.created_at, 'idle_reassignment',
         r.old_agent_id, fp.full_name, r.new_agent_id, tp.full_name,
         r.actor_id, ap.full_name, r.reason
    FROM public.tenant_reassignment_audit r
    LEFT JOIN public.profiles fp ON fp.id = r.old_agent_id
    LEFT JOIN public.profiles tp ON tp.id = r.new_agent_id
    LEFT JOIN public.profiles ap ON ap.id = r.actor_id
   WHERE r.tenant_id = p_tenant_id
     AND (public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'))
  ORDER BY 2 DESC;
$$;

REVOKE ALL ON FUNCTION public.get_tenant_transfer_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tenant_transfer_history(uuid) TO authenticated, service_role;