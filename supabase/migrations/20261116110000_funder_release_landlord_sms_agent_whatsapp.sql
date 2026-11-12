-- Landlord SMS and Zoe's WhatsApp when partner rent lands on landlord float.
--
-- Landlord SMS with no email was only logged against partner_float_landlord_notices.
-- Nothing drains that queue. This queues the SMS on funder_release_sms (audience
-- landlord, channel sms) so the existing notify-funder-release-sms cron sends it.
-- The funder is never named.
--
-- The agent also gets one WhatsApp from Zoe (audience agent, channel whatsapp),
-- with the same words stored as the SMS fallback. Idempotency stays
-- (rent_request_id, audience, channel) on funder_release_notice_log and on the
-- queue. A notice failure still does not roll back the float.
--
-- Filename is 20261116110000. 20261115130000 is already used on lovable, and the
-- earlier copy of this migration rolled back on live (23505) so it is not in
-- schema_migrations. Apply this version.
-- funder_release_sms already has several sent rows per plan, and live uniqueness
-- is funder_release_sms_request_phone_key on (rent_request_id, phone), not
-- funder_release_sms_rent_request_id_key. Existing phone, message, and status
-- values are left as they are. Those rows are marked audience legacy_tenant and
-- sit outside the new unique index.

CREATE OR REPLACE FUNCTION public._funder_release_mask_phone(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN p_phone IS NULL OR length(regexp_replace(p_phone, '\D', '', 'g')) < 8 THEN NULL
    ELSE left(regexp_replace(p_phone, '\D', '', 'g'), 4)
         || '***'
         || right(regexp_replace(p_phone, '\D', '', 'g'), 3)
  END;
$$;
REVOKE ALL ON FUNCTION public._funder_release_mask_phone(text) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.funder_release_sms
  ADD COLUMN IF NOT EXISTS audience text,
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS fallback_message text,
  ADD COLUMN IF NOT EXISTS template_params jsonb;

-- New columns only. Sent phone, message, and status stay untouched.
UPDATE public.funder_release_sms
   SET audience = 'legacy_tenant'
 WHERE audience IS NULL;

UPDATE public.funder_release_sms
   SET channel = 'sms'
 WHERE channel IS NULL;

ALTER TABLE public.funder_release_sms
  ALTER COLUMN audience SET DEFAULT 'tenant',
  ALTER COLUMN channel SET DEFAULT 'sms',
  ALTER COLUMN audience SET NOT NULL,
  ALTER COLUMN channel SET NOT NULL;

-- Repo builds used a rent_request_id key. Live uses the phone key. Drop either if present.
ALTER TABLE public.funder_release_sms DROP CONSTRAINT IF EXISTS funder_release_sms_rent_request_id_key;
DROP INDEX IF EXISTS public.funder_release_sms_rent_request_id_key;
ALTER TABLE public.funder_release_sms DROP CONSTRAINT IF EXISTS funder_release_sms_request_phone_key;
DROP INDEX IF EXISTS public.funder_release_sms_request_phone_key;

ALTER TABLE public.funder_release_sms DROP CONSTRAINT IF EXISTS funder_release_sms_audience_chk;
ALTER TABLE public.funder_release_sms
  ADD CONSTRAINT funder_release_sms_audience_chk
  CHECK (audience IN ('tenant', 'landlord', 'agent', 'legacy_tenant'));

ALTER TABLE public.funder_release_sms DROP CONSTRAINT IF EXISTS funder_release_sms_channel_chk;
ALTER TABLE public.funder_release_sms
  ADD CONSTRAINT funder_release_sms_channel_chk
  CHECK (channel IN ('sms', 'whatsapp'));

-- One new notice per plan, audience, and channel. The already-sent rows are outside this index.
CREATE UNIQUE INDEX IF NOT EXISTS funder_release_sms_once
  ON public.funder_release_sms (rent_request_id, audience, channel)
  WHERE audience <> 'legacy_tenant';

COMMENT ON TABLE public.funder_release_sms IS
  'Tenant SMS, landlord SMS, and agent WhatsApp after a partner release. Drained by notify-funder-release-sms.';

ALTER TABLE public.funder_release_notice_log DROP CONSTRAINT IF EXISTS funder_release_notice_log_channel_chk;
ALTER TABLE public.funder_release_notice_log
  ADD CONSTRAINT funder_release_notice_log_channel_chk
  CHECK (channel IN ('email', 'in_app', 'sms', 'whatsapp'));

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
  v_agent_phone text;
  v_tenant_first text;
  v_agent_first text;
  v_rent_amt text;
  v_msg text;
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
         NULLIF(btrim(ap.phone), ''),
         COALESCE(NULLIF(initcap(split_part(btrim(COALESCE(tp.full_name, '')), ' ', 1)), ''), 'your tenant'),
         COALESCE(NULLIF(initcap(split_part(btrim(COALESCE(ap.full_name, '')), ' ', 1)), ''), 'your agent'),
         NULLIF(btrim(tp.email), ''),
         NULLIF(btrim(tp.phone), ''),
         NULLIF(btrim(lp.email), ''),
         COALESCE(NULLIF(btrim(ld.phone), ''), NULLIF(btrim(lp.phone), ''))
    INTO v_tenant, v_landlord, v_tenant_name, v_agent_name, v_landlord_name,
         v_agent_email, v_agent_phone, v_tenant_first, v_agent_first,
         v_tenant_email, v_tenant_phone, v_landlord_email, v_landlord_phone
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

  v_rent_amt := to_char(COALESCE(p_amount, 0), 'FM999,999,999,990');
  v_rent := 'UGX ' || v_rent_amt;
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
        ON CONFLICT (rent_request_id, audience, channel) WHERE audience <> 'legacy_tenant' DO NOTHING;
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

  -- Landlord email. SMS, when there is no email, waits on funder_release_sms.
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
      PERFORM public._funder_release_finish(p_rent_request_id, 'landlord', 'sms', 'skipped', public._funder_release_mask_phone(v_landlord_phone), 'no_phone');
    ELSE
      BEGIN
        v_msg := 'WELILE: UGX ' || v_rent_amt || ' rent for ' || v_tenant_first
              || ' is with your Welile agent ' || v_agent_first
              || '. They will pay you within 24 hours. Keep your phone on.';
        INSERT INTO public.funder_release_sms (rent_request_id, audience, channel, phone, message)
        VALUES (p_rent_request_id, 'landlord', 'sms', v_landlord_phone, v_msg)
        ON CONFLICT (rent_request_id, audience, channel) WHERE audience <> 'legacy_tenant' DO NOTHING;
        v_wake := true;
        IF v_commitment IS NOT NULL THEN
          UPDATE public.partner_float_landlord_notices
             SET status = 'failed',
                 last_error = 'routed_to_funder_release_sms',
                 updated_at = now()
           WHERE commitment_id = v_commitment
             AND landlord_id IS NOT DISTINCT FROM v_landlord
             AND status = 'pending';
        END IF;
        PERFORM public._funder_release_finish(
          p_rent_request_id, 'landlord', 'sms', 'queued',
          public._funder_release_mask_phone(v_landlord_phone), 'funder_release_sms'
        );
      EXCEPTION WHEN OTHERS THEN
        PERFORM public._funder_release_finish(
          p_rent_request_id, 'landlord', 'sms', 'failed',
          public._funder_release_mask_phone(v_landlord_phone), SQLERRM
        );
      END;
    END IF;
  END IF;

  -- Zoe tells the agent on WhatsApp. SMS is the fallback when WhatsApp cannot send.
  IF public._funder_release_claim(p_rent_request_id, 'agent', 'whatsapp') THEN
    IF p_agent_id IS NULL THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'agent', 'whatsapp', 'skipped', NULL, 'no_user');
    ELSIF v_agent_phone IS NULL OR length(regexp_replace(v_agent_phone, '[^0-9]', '', 'g')) < 9 THEN
      PERFORM public._funder_release_finish(p_rent_request_id, 'agent', 'whatsapp', 'skipped', NULL, 'no_phone');
    ELSE
      BEGIN
        v_msg := 'Hi ' || v_agent_first || ', this is Zoe from Welile. UGX ' || v_rent_amt
              || ' landlord float for ' || v_tenant_name
              || ' is on your dashboard now. Please go and pay landlord ' || v_landlord_name
              || ' today, within 24 hours, then record the payment with the TID and receipt photo in your dashboard. Thank you for keeping your tenants housed.';
        INSERT INTO public.funder_release_sms (
          rent_request_id, audience, channel, phone, message, fallback_message, template_params
        ) VALUES (
          p_rent_request_id, 'agent', 'whatsapp', v_agent_phone, v_msg, v_msg,
          jsonb_build_array(v_agent_first, 'UGX ' || v_rent_amt, v_tenant_name, v_landlord_name)
        )
        ON CONFLICT (rent_request_id, audience, channel) WHERE audience <> 'legacy_tenant' DO NOTHING;
        v_wake := true;
        PERFORM public._funder_release_finish(
          p_rent_request_id, 'agent', 'whatsapp', 'queued',
          public._funder_release_mask_phone(v_agent_phone), 'funder_release_sms'
        );
      EXCEPTION WHEN OTHERS THEN
        PERFORM public._funder_release_finish(
          p_rent_request_id, 'agent', 'whatsapp', 'failed',
          public._funder_release_mask_phone(v_agent_phone), SQLERRM
        );
      END;
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


COMMENT ON FUNCTION public._funder_release_notify_plan(uuid, uuid, uuid, uuid, uuid, numeric) IS
  'Queues partner, agent, tenant, and landlord notices after partner rent reaches landlord float. Landlord SMS and agent WhatsApp wait on funder_release_sms. Failures are recorded and do not move money.';
