CREATE TABLE public.tenant_rent_intake_notices (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES public.tenant_rent_intake_requests(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  stage text NOT NULL,
  phone text,
  sms_text text NOT NULL,
  sms_status text NOT NULL DEFAULT 'pending' CHECK (sms_status IN ('pending','sent','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.tenant_rent_intake_notices TO authenticated;
GRANT ALL ON public.tenant_rent_intake_notices TO service_role;

ALTER TABLE public.tenant_rent_intake_notices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenants read own rent intake notices"
ON public.tenant_rent_intake_notices FOR SELECT TO authenticated
USING (tenant_id = auth.uid());

CREATE UNIQUE INDEX idx_trin_request_stage ON public.tenant_rent_intake_notices (request_id, stage);
CREATE INDEX idx_trin_pending ON public.tenant_rent_intake_notices (sms_status, created_at) WHERE sms_status = 'pending';

CREATE TRIGGER update_tenant_rent_intake_notices_updated_at
BEFORE UPDATE ON public.tenant_rent_intake_notices
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Queue one in-app notification + one SMS per (request, stage).
CREATE OR REPLACE FUNCTION public.queue_tenant_rent_intake_notice(
  p_request_id uuid,
  p_stage text,
  p_title text,
  p_message text,
  p_sms text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_req record;
  v_phone text;
BEGIN
  SELECT r.*, p.phone AS profile_phone
    INTO v_req
    FROM public.tenant_rent_intake_requests r
    LEFT JOIN public.profiles p ON p.id = r.tenant_id
   WHERE r.id = p_request_id;
  IF v_req.id IS NULL THEN
    RETURN;
  END IF;

  v_phone := COALESCE(NULLIF(trim(v_req.tenant_phone), ''), NULLIF(trim(v_req.profile_phone), ''));

  INSERT INTO public.tenant_rent_intake_notices (request_id, tenant_id, stage, phone, sms_text, sms_status)
  VALUES (p_request_id, v_req.tenant_id, p_stage, v_phone, p_sms,
          CASE WHEN v_phone IS NULL THEN 'skipped' ELSE 'pending' END)
  ON CONFLICT (request_id, stage) DO NOTHING;

  IF NOT FOUND THEN
    RETURN; -- already queued for this stage; never notify twice
  END IF;

  BEGIN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (v_req.tenant_id, p_title, p_message, 'rent_request_progress',
            jsonb_build_object('request_id', p_request_id, 'stage', p_stage,
                               'service_centre', v_req.service_centre_name));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_tenant_rent_intake_notice(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_tenant_rent_intake_notice(uuid, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.tenant_rent_intake_notify_progress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_centre text := COALESCE(NEW.service_centre_name, 'your nearest Welile Service Centre');
  v_agent text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('claimed','visit_verified','approved') THEN
    SELECT full_name INTO v_agent FROM public.profiles
     WHERE id = COALESCE(NEW.claimed_by, NEW.assigned_agent_id);
  END IF;

  IF NEW.status = 'submitted' THEN
    PERFORM public.queue_tenant_rent_intake_notice(
      NEW.id, 'submitted',
      'Rent request received',
      'Your rent request was sent to ' || v_centre || '. An agent will review you and visit your house to verify it.',
      'Welile: We received your rent request of UGX ' || to_char(round(NEW.rent_amount), 'FM999,999,999')
        || '. It is with ' || v_centre || '. An agent will visit to verify your house. We will keep you posted.');
  ELSIF NEW.status = 'claimed' THEN
    PERFORM public.queue_tenant_rent_intake_notice(
      NEW.id, 'claimed',
      'Agent assigned',
      COALESCE(v_agent, 'An agent') || ' picked up your rent request and will visit your house to verify it.',
      'Welile: ' || COALESCE(v_agent, 'An agent') || ' is now handling your rent request and will visit your house to verify it.');
  ELSIF NEW.status = 'visit_verified' THEN
    PERFORM public.queue_tenant_rent_intake_notice(
      NEW.id, 'visit_verified',
      'House verified',
      'Your house was verified by the agent. Your request is now in final review.',
      'Welile: Your house has been verified. Your rent request is now in final review.');
  ELSIF NEW.status = 'approved' THEN
    PERFORM public.queue_tenant_rent_intake_notice(
      NEW.id, 'approved',
      'Rent request approved',
      'You were approved. Your agent will now raise your rent plan.',
      'Welile: Good news - your rent request is approved. Your agent will now raise your rent plan.');
  ELSIF NEW.status = 'rent_requested' THEN
    PERFORM public.queue_tenant_rent_intake_notice(
      NEW.id, 'rent_requested',
      'Rent plan raised',
      'Your rent plan has been raised. Follow it from your rent plan card in the app.',
      'Welile: Your rent plan has been raised. Open the Welile app to follow its progress.');
  ELSIF NEW.status = 'declined' THEN
    PERFORM public.queue_tenant_rent_intake_notice(
      NEW.id, 'declined',
      'Rent request not approved',
      'Your rent request was not approved.'
        || COALESCE(' Reason: ' || NULLIF(trim(NEW.decline_reason), ''), '')
        || ' You can apply again.',
      'Welile: Your rent request was not approved.'
        || COALESCE(' Reason: ' || NULLIF(trim(NEW.decline_reason), ''), '')
        || ' You may apply again from the app.');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tenant_rent_intake_notify_progress
AFTER INSERT OR UPDATE OF status ON public.tenant_rent_intake_requests
FOR EACH ROW EXECUTE FUNCTION public.tenant_rent_intake_notify_progress();

-- Occasional "still in progress" nudge when a request sits at the same stage.
CREATE OR REPLACE FUNCTION public.queue_tenant_rent_intake_stall_notices()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_stage text;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT id, status, updated_at, service_centre_name,
           floor(extract(epoch FROM (now() - updated_at)) / 172800)::int AS periods
      FROM public.tenant_rent_intake_requests
     WHERE status IN ('submitted','claimed','visit_verified','approved')
       AND updated_at < now() - interval '2 days'
  LOOP
    v_stage := 'reminder_' || r.status || '_' || r.periods::text;
    PERFORM public.queue_tenant_rent_intake_notice(
      r.id, v_stage,
      'Rent request still in progress',
      'Your rent request is still being worked on ('
        || CASE r.status
             WHEN 'submitted' THEN 'with ' || COALESCE(r.service_centre_name, 'the Service Centre')
             WHEN 'claimed' THEN 'agent review'
             WHEN 'visit_verified' THEN 'final review'
             ELSE 'rent plan being raised' END
        || '). We will update you as soon as it moves.',
      'Welile: Your rent request is still in progress ('
        || CASE r.status
             WHEN 'submitted' THEN 'with ' || COALESCE(r.service_centre_name, 'the Service Centre')
             WHEN 'claimed' THEN 'agent review'
             WHEN 'visit_verified' THEN 'final review'
             ELSE 'rent plan being raised' END
        || '). We will update you as soon as it moves.');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_tenant_rent_intake_stall_notices() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_tenant_rent_intake_stall_notices() TO service_role;