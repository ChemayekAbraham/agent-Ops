-- Tell the partner, agent, tenant, and landlord when partner rent lands on the
-- agent's landlord float. Both release paths insert agent_landlord_float_allocations
-- (source partner_self_funding): the immediate call inside
-- _approve_pending_portfolio_core, and the later float-credit trigger that calls
-- the same core. This trigger runs on that insert.
--
-- A notice failure is caught. It never rolls back the float.
-- Each plan is told once per person and channel. The unique key is the lock.
--
-- Emails go to the existing transactional queue. process-email-queue adds the
-- Welile letterhead and sends them. Landlord SMS stays on
-- partner_float_landlord_notices / notify-partner-float-landlords, and is
-- marked failed with last_error email_on_file when an email was queued, so
-- SMS is only the fallback. Tenant SMS, when there is no email, is queued in
-- funder_release_sms for notify-funder-release-sms.
--
-- This file is not applied by the pull request.

CREATE TABLE IF NOT EXISTS public.funder_release_notice_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL,
  audience text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL,
  recipient text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funder_release_notice_log_audience_chk
    CHECK (audience IN ('partner', 'agent', 'tenant', 'landlord')),
  CONSTRAINT funder_release_notice_log_channel_chk
    CHECK (channel IN ('email', 'in_app', 'sms')),
  CONSTRAINT funder_release_notice_log_status_chk
    CHECK (status IN ('queued', 'skipped', 'failed')),
  CONSTRAINT funder_release_notice_log_once
    UNIQUE (rent_request_id, audience, channel)
);

COMMENT ON TABLE public.funder_release_notice_log IS
  'One row per Rent Plan, person, and channel. The unique key stops a second release from sending the same notice again.';

CREATE TABLE IF NOT EXISTS public.funder_release_sms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL UNIQUE,
  phone text NOT NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funder_release_sms_status_chk
    CHECK (status IN ('pending', 'sent', 'failed'))
);

COMMENT ON TABLE public.funder_release_sms IS
  'Tenant SMS when no email is on file. Drained by notify-funder-release-sms.';

CREATE INDEX IF NOT EXISTS funder_release_sms_pending_idx
  ON public.funder_release_sms (created_at)
  WHERE status = 'pending';

ALTER TABLE public.funder_release_notice_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.funder_release_sms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS funder_release_notice_log_staff_read ON public.funder_release_notice_log;
CREATE POLICY funder_release_notice_log_staff_read
  ON public.funder_release_notice_log
  FOR SELECT TO authenticated
  USING ((SELECT public.has_internal_staff_role((SELECT auth.uid()))));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.funder_release_notice_log;
CREATE POLICY mfa_required_for_staff
  ON public.funder_release_notice_log
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS funder_release_sms_staff_read ON public.funder_release_sms;
CREATE POLICY funder_release_sms_staff_read
  ON public.funder_release_sms
  FOR SELECT TO authenticated
  USING ((SELECT public.has_internal_staff_role((SELECT auth.uid()))));

DROP POLICY IF EXISTS mfa_required_for_staff ON public.funder_release_sms;
CREATE POLICY mfa_required_for_staff
  ON public.funder_release_sms
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

REVOKE ALL ON public.funder_release_notice_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.funder_release_notice_log TO authenticated;
GRANT ALL ON public.funder_release_notice_log TO service_role;

REVOKE ALL ON public.funder_release_sms FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.funder_release_sms TO authenticated;
GRANT ALL ON public.funder_release_sms TO service_role;

CREATE OR REPLACE FUNCTION public._funder_release_claim(
  p_rent_request_id uuid,
  p_audience text,
  p_channel text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.funder_release_notice_log (rent_request_id, audience, channel, status)
  VALUES (p_rent_request_id, p_audience, p_channel, 'skipped');
  RETURN true;
EXCEPTION
  WHEN unique_violation THEN
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public._funder_release_finish(
  p_rent_request_id uuid,
  p_audience text,
  p_channel text,
  p_status text,
  p_recipient text,
  p_detail text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.funder_release_notice_log
     SET status = p_status,
         recipient = p_recipient,
         detail = left(p_detail, 500)
   WHERE rent_request_id = p_rent_request_id
     AND audience = p_audience
     AND channel = p_channel;
$$;

CREATE OR REPLACE FUNCTION public.funder_release_sms_dispatch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_key text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.funder_release_sms
     WHERE status = 'pending' AND attempts < 4
  ) THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
   WHERE name = 'email_queue_service_role_key'
   LIMIT 1;

  IF v_key IS NULL OR btrim(v_key) = '' THEN
    RAISE WARNING 'funder release sms dispatch skipped: email_queue_service_role_key is not in vault';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/notify-funder-release-sms',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{}'::jsonb
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'funder release sms dispatch failed: %', SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION public._funder_release_notify_plan(
  p_rent_request_id uuid,
  p_allocation_id uuid,
  p_agent_id uuid,
  p_partner_id uuid,
  p_landlord_id uuid,
  p_amount numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant uuid;
  v_landlord uuid;
  v_commitment uuid;
  v_cover numeric := 0;
  v_rent text;
  v_cover_text text;
  v_tenant_name text;
  v_agent_name text;
  v_landlord_name text;
  v_partner_email text;
  v_agent_email text;
  v_tenant_email text;
  v_tenant_phone text;
  v_landlord_email text;
  v_landlord_phone text;
  v_html text;
  v_text text;
  v_subject text;
  v_wake boolean := false;
BEGIN
  IF p_rent_request_id IS NULL OR NOT public._pipeline_switch_on('funder_direct_release') THEN
    RETURN;
  END IF;

  SELECT rr.tenant_id,
         COALESCE(p_landlord_id, rr.landlord_id),
         COALESCE(NULLIF(btrim(tp.full_name), ''), 'your tenant'),
         COALESCE(NULLIF(btrim(ap.full_name), ''), 'your agent'),
         COALESCE(NULLIF(btrim(ld.name), ''), NULLIF(btrim(lp.full_name), ''), 'your landlord'),
         NULLIF(btrim(ap.email), ''),
         NULLIF(btrim(tp.email), ''),
         NULLIF(btrim(tp.phone), ''),
         NULLIF(btrim(lp.email), ''),
         COALESCE(NULLIF(btrim(ld.phone), ''), NULLIF(btrim(lp.phone), ''))
    INTO v_tenant, v_landlord, v_tenant_name, v_agent_name, v_landlord_name,
         v_agent_email, v_tenant_email, v_tenant_phone, v_landlord_email, v_landlord_phone
    FROM public.rent_requests rr
    LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = COALESCE(p_agent_id, rr.assigned_agent_id, rr.agent_id)
    LEFT JOIN public.profiles lp ON lp.id = COALESCE(p_landlord_id, rr.landlord_id)
    LEFT JOIN public.landlords ld ON ld.id = COALESCE(p_landlord_id, rr.landlord_id)
   WHERE rr.id = p_rent_request_id;

  SELECT l.commitment_id, COALESCE(l.proxy_fee, 0)
    INTO v_commitment, v_cover
    FROM public.partner_self_funding_lines l
    JOIN public.partner_self_commitments c ON c.id = l.commitment_id
   WHERE l.rent_request_id = p_rent_request_id
     AND (p_partner_id IS NULL OR c.partner_id = p_partner_id)
   ORDER BY l.created_at DESC
   LIMIT 1;

  SELECT COALESCE(NULLIF(btrim(p.email), ''), NULLIF(btrim(u.email), ''))
    INTO v_partner_email
    FROM public.profiles p
    LEFT JOIN auth.users u ON u.id = p.id
   WHERE p.id = p_partner_id;

  v_rent := 'UGX ' || to_char(COALESCE(p_amount, 0), 'FM999,999,999,990');
  v_cover_text := CASE
    WHEN COALESCE(v_cover, 0) > 0
      THEN 'Welile Cover UGX ' || to_char(v_cover, 'FM999,999,999,990') || ' (2% of the rent).'
    ELSE 'Welile Cover was not charged.'
  END;

  -- Partner email receipt.
  IF public._funder_release_claim(p_rent_request_id, 'partner', 'email') THEN
    IF v_partner_email IS NULL OR v_partner_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'partner', 'email', 'skipped', v_partner_email, 'no_email');
    ELSE
      v_subject := 'Your rent is with the agent';
      v_text := 'You paid ' || v_rent || ' rent for ' || v_tenant_name || ' through Welile. '
             || v_cover_text || ' '
             || v_agent_name || ' will pay ' || v_landlord_name || ' within 24 hours. '
             || 'You earn Rent profit share on this rent.';
      v_html := '<p>' || replace(replace(replace(v_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p>';
      BEGIN
        PERFORM public.enqueue_email('transactional_emails', jsonb_build_object(
          'message_id', gen_random_uuid()::text,
          'to', v_partner_email,
          'from', 'Welile Partnerships <partnership@welile.com>',
          'sender_domain', 'notify.welile.com',
          'subject', v_subject,
          'html', v_html,
          'text', v_text,
          'purpose', 'transactional',
          'label', 'funder-release-partner',
          'idempotency_key', 'funder-release:' || p_rent_request_id::text || ':partner',
          'queued_at', now()
        ));
        PERFORM public._funder_release_finish(p_rent_request_id, 'partner', 'email', 'queued', v_partner_email, NULL);
      EXCEPTION WHEN OTHERS THEN
        PERFORM public._funder_release_finish(p_rent_request_id, 'partner', 'email', 'failed', v_partner_email, SQLERRM);
      END;
    END IF;
  END IF;

  IF public._funder_release_claim(p_rent_request_id, 'partner', 'in_app') THEN
    IF p_partner_id IS NULL THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'partner', 'in_app', 'skipped', NULL, 'no_user');
    ELSE
      BEGIN
        INSERT INTO public.notifications (user_id, title, message, type, event_key, metadata)
        SELECT p_partner_id,
               'Your rent is with the agent',
               'You paid ' || v_rent || ' for ' || v_tenant_name || ' through Welile. '
                 || v_agent_name || ' will pay the landlord within 24 hours. You earn Rent profit share on this rent.',
               'float',
               'funder-release:' || p_rent_request_id::text || ':partner',
               jsonb_build_object('rent_request_id', p_rent_request_id, 'allocation_id', p_allocation_id, 'amount', p_amount)
         WHERE NOT EXISTS (
           SELECT 1 FROM public.notifications n
            WHERE n.user_id = p_partner_id
              AND n.event_key = 'funder-release:' || p_rent_request_id::text || ':partner'
         );
        PERFORM public._funder_release_finish(p_rent_request_id, 'partner', 'in_app', 'queued', p_partner_id::text, NULL);
      EXCEPTION WHEN OTHERS THEN
        PERFORM public._funder_release_finish(p_rent_request_id, 'partner', 'in_app', 'failed', p_partner_id::text, SQLERRM);
      END;
    END IF;
  END IF;

  -- Agent email and in-app.
  IF public._funder_release_claim(p_rent_request_id, 'agent', 'email') THEN
    IF v_agent_email IS NULL OR v_agent_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'agent', 'email', 'skipped', v_agent_email, 'no_email');
    ELSE
      v_subject := 'Landlord float credited';
      v_text := 'Landlord float of ' || v_rent || ' is on your dashboard for ' || v_tenant_name
             || '. Pay the landlord within 24 hours.';
      v_html := '<p>' || replace(replace(replace(v_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p>';
      BEGIN
        PERFORM public.enqueue_email('transactional_emails', jsonb_build_object(
          'message_id', gen_random_uuid()::text,
          'to', v_agent_email,
          'from', 'Welile <noreply@welile.com>',
          'sender_domain', 'notify.welile.com',
          'subject', v_subject,
          'html', v_html,
          'text', v_text,
          'purpose', 'transactional',
          'label', 'funder-release-agent',
          'idempotency_key', 'funder-release:' || p_rent_request_id::text || ':agent',
          'queued_at', now()
        ));
        PERFORM public._funder_release_finish(p_rent_request_id, 'agent', 'email', 'queued', v_agent_email, NULL);
      EXCEPTION WHEN OTHERS THEN
        PERFORM public._funder_release_finish(p_rent_request_id, 'agent', 'email', 'failed', v_agent_email, SQLERRM);
      END;
    END IF;
  END IF;

  IF public._funder_release_claim(p_rent_request_id, 'agent', 'in_app') THEN
    IF p_agent_id IS NULL THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'agent', 'in_app', 'skipped', NULL, 'no_user');
    ELSE
      BEGIN
        INSERT INTO public.notifications (user_id, title, message, type, event_key, link_path, metadata)
        SELECT p_agent_id,
               'Landlord float credited',
               'Landlord float of ' || v_rent || ' is on your dashboard for ' || v_tenant_name
                 || '. Pay the landlord within 24 hours.',
               'float',
               'funder-release:' || p_rent_request_id::text || ':agent',
               '/dashboard/agent',
               jsonb_build_object('rent_request_id', p_rent_request_id, 'allocation_id', p_allocation_id, 'amount', p_amount)
         WHERE NOT EXISTS (
           SELECT 1 FROM public.notifications n
            WHERE n.user_id = p_agent_id
              AND n.event_key = 'funder-release:' || p_rent_request_id::text || ':agent'
         );
        PERFORM public._funder_release_finish(p_rent_request_id, 'agent', 'in_app', 'queued', p_agent_id::text, NULL);
      EXCEPTION WHEN OTHERS THEN
        PERFORM public._funder_release_finish(p_rent_request_id, 'agent', 'in_app', 'failed', p_agent_id::text, SQLERRM);
      END;
    END IF;
  END IF;

  -- Tenant email, or SMS when there is no email.
  IF public._funder_release_claim(p_rent_request_id, 'tenant', 'email') THEN
    IF v_tenant_email IS NULL OR v_tenant_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'tenant', 'email', 'skipped', v_tenant_email, 'no_email');
    ELSE
      v_subject := 'Your rent has been paid';
      v_text := 'Your rent of ' || v_rent || ' has been paid to your landlord through Welile. '
             || 'Keep going. Finishing this rent unlocks higher access, up to UGX 30,000,000.';
      v_html := '<p>' || replace(replace(replace(v_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p>';
      BEGIN
        PERFORM public.enqueue_email('transactional_emails', jsonb_build_object(
          'message_id', gen_random_uuid()::text,
          'to', v_tenant_email,
          'from', 'Welile <noreply@welile.com>',
          'sender_domain', 'notify.welile.com',
          'subject', v_subject,
          'html', v_html,
          'text', v_text,
          'purpose', 'transactional',
          'label', 'funder-release-tenant',
          'idempotency_key', 'funder-release:' || p_rent_request_id::text || ':tenant',
          'queued_at', now()
        ));
        PERFORM public._funder_release_finish(p_rent_request_id, 'tenant', 'email', 'queued', v_tenant_email, NULL);
      EXCEPTION WHEN OTHERS THEN
        PERFORM public._funder_release_finish(p_rent_request_id, 'tenant', 'email', 'failed', v_tenant_email, SQLERRM);
      END;
    END IF;
  END IF;

  IF public._funder_release_claim(p_rent_request_id, 'tenant', 'sms') THEN
    IF v_tenant_email IS NOT NULL AND v_tenant_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'tenant', 'sms', 'skipped', NULL, 'email_on_file');
    ELSIF v_tenant_phone IS NULL OR length(regexp_replace(v_tenant_phone, '[^0-9]', '', 'g')) < 9 THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'tenant', 'sms', 'skipped', v_tenant_phone, 'no_phone');
    ELSE
      BEGIN
        INSERT INTO public.funder_release_sms (rent_request_id, phone, message)
        VALUES (
          p_rent_request_id,
          v_tenant_phone,
          'WELILE: Your rent of ' || v_rent || ' is paid to your landlord through Welile. '
            || 'Finish this rent and you can access more, up to UGX 30,000,000.'
        )
        ON CONFLICT (rent_request_id) DO NOTHING;
        v_wake := true;
        PERFORM public._funder_release_finish(p_rent_request_id, 'tenant', 'sms', 'queued', v_tenant_phone, 'funder_release_sms');
      EXCEPTION WHEN OTHERS THEN
        PERFORM public._funder_release_finish(p_rent_request_id, 'tenant', 'sms', 'failed', v_tenant_phone, SQLERRM);
      END;
    END IF;
  END IF;

  IF public._funder_release_claim(p_rent_request_id, 'tenant', 'in_app') THEN
    IF v_tenant IS NULL THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'tenant', 'in_app', 'skipped', NULL, 'no_user');
    ELSE
      BEGIN
        INSERT INTO public.notifications (user_id, title, message, type, event_key, metadata)
        SELECT v_tenant,
               'Your rent has been paid',
               'Your rent of ' || v_rent || ' has been paid to your landlord through Welile. '
                 || 'Keep going. Finishing this rent unlocks higher access, up to UGX 30,000,000.',
               'float',
               'funder-release:' || p_rent_request_id::text || ':tenant',
               jsonb_build_object('rent_request_id', p_rent_request_id, 'amount', p_amount)
         WHERE NOT EXISTS (
           SELECT 1 FROM public.notifications n
            WHERE n.user_id = v_tenant
              AND n.event_key = 'funder-release:' || p_rent_request_id::text || ':tenant'
         );
        PERFORM public._funder_release_finish(p_rent_request_id, 'tenant', 'in_app', 'queued', v_tenant::text, NULL);
      EXCEPTION WHEN OTHERS THEN
        PERFORM public._funder_release_finish(p_rent_request_id, 'tenant', 'in_app', 'failed', v_tenant::text, SQLERRM);
      END;
    END IF;
  END IF;

  -- Landlord email. SMS fallback is the existing landlord notice queue.
  IF public._funder_release_claim(p_rent_request_id, 'landlord', 'email') THEN
    IF v_landlord_email IS NULL OR v_landlord_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'landlord', 'email', 'skipped', v_landlord_email, 'no_email');
    ELSE
      v_subject := 'Rent is on the way';
      v_text := 'Rent of ' || v_rent || ' for ' || split_part(v_tenant_name, ' ', 1)
             || ' is with your Welile agent. They will pay you within 24 hours.';
      v_html := '<p>' || replace(replace(replace(v_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p>';
      BEGIN
        PERFORM public.enqueue_email('transactional_emails', jsonb_build_object(
          'message_id', gen_random_uuid()::text,
          'to', v_landlord_email,
          'from', 'Welile <noreply@welile.com>',
          'sender_domain', 'notify.welile.com',
          'subject', v_subject,
          'html', v_html,
          'text', v_text,
          'purpose', 'transactional',
          'label', 'funder-release-landlord',
          'idempotency_key', 'funder-release:' || p_rent_request_id::text || ':landlord',
          'queued_at', now()
        ));
        PERFORM public._funder_release_finish(p_rent_request_id, 'landlord', 'email', 'queued', v_landlord_email, NULL);
        IF v_commitment IS NOT NULL THEN
          UPDATE public.partner_float_landlord_notices
             SET status = 'failed',
                 last_error = 'email_on_file',
                 updated_at = now()
           WHERE commitment_id = v_commitment
             AND landlord_id IS NOT DISTINCT FROM v_landlord
             AND status = 'pending';
        END IF;
      EXCEPTION WHEN OTHERS THEN
        PERFORM public._funder_release_finish(p_rent_request_id, 'landlord', 'email', 'failed', v_landlord_email, SQLERRM);
      END;
    END IF;
  END IF;

  IF public._funder_release_claim(p_rent_request_id, 'landlord', 'sms') THEN
    IF v_landlord_email IS NOT NULL AND v_landlord_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'landlord', 'sms', 'skipped', NULL, 'email_on_file');
    ELSIF v_landlord_phone IS NULL OR length(regexp_replace(v_landlord_phone, '[^0-9]', '', 'g')) < 9 THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'landlord', 'sms', 'skipped', v_landlord_phone, 'no_phone');
    ELSE
      PERFORM public._funder_release_finish(
        p_rent_request_id, 'landlord', 'sms', 'queued', v_landlord_phone, 'partner_float_landlord_notices'
      );
    END IF;
  END IF;

  IF v_wake THEN
    BEGIN
      PERFORM public.funder_release_sms_dispatch();
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'funder release sms wake failed for %: %', p_rent_request_id, SQLERRM;
    END;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_funder_release_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM 'partner_self_funding' OR NEW.rent_request_id IS NULL THEN
    RETURN NEW;
  END IF;
  BEGIN
    PERFORM public._funder_release_notify_plan(
      NEW.rent_request_id,
      NEW.id,
      NEW.agent_id,
      NEW.funded_by_partner_id,
      NEW.landlord_id,
      NEW.allocated_amount
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'funder release notice failed for plan %: %', NEW.rent_request_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_funder_release_notify ON public.agent_landlord_float_allocations;
CREATE TRIGGER trg_funder_release_notify
  AFTER INSERT ON public.agent_landlord_float_allocations
  FOR EACH ROW
  WHEN (NEW.source = 'partner_self_funding' AND NEW.rent_request_id IS NOT NULL)
  EXECUTE FUNCTION public.trg_funder_release_notify();

COMMENT ON FUNCTION public._funder_release_notify_plan(uuid, uuid, uuid, uuid, uuid, numeric) IS
  'Queues partner, agent, tenant, and landlord notices after partner rent reaches landlord float. Failures are recorded and do not move money.';

REVOKE ALL ON FUNCTION public._funder_release_claim(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._funder_release_finish(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._funder_release_notify_plan(uuid, uuid, uuid, uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_funder_release_notify() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.funder_release_sms_dispatch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.funder_release_sms_dispatch() TO service_role;

SELECT cron.schedule(
  'notify-funder-release-sms',
  '* * * * *',
  $cron$SELECT public.funder_release_sms_dispatch();$cron$
)
WHERE NOT EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'notify-funder-release-sms'
);
