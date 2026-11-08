-- Tell the owner when anyone else touches the controls that are locked to him (20261024110000), including a bot or script using someone's access.
--
-- WHAT HAPPENS NOW
--   * Someone else (HR, super admin, CFO, a script holding their token...) tries to change a protected setting or open the Financial Ops restrictions:
--     the change does NOT happen, it is written to owner_security_alerts, and the owner gets (a) a "security" notification in the app and (b) an email to
--     the approver mailbox (exception_approver_email, joshua.wanda@welile.com). Email is limited to one per person per setting every 10 minutes; every attempt
--     is still recorded.
--   * A protected setting is changed with NO signed-in user (the service key, a cron job or the SQL editor, i.e. a bot that bypasses sign-in): the change
--     is allowed, because the database cannot tell the owner at his SQL editor from a script, but it is recorded and he is alerted the same way.
--   * The owner's own changes (his id with his email) raise no alert.
--
-- IMPORTANT BEHAVIOUR CHANGE: before, a blocked change raised an error. An error undoes everything in the same transaction, including the alert, so a
-- blocked change is now IGNORED QUIETLY (the update does nothing; the call appears to succeed). The person trying is not told it was blocked.
-- The owner sees every attempt through list_owner_security_alerts() and the emails.
-- Needs 20261024110000_owner_only_settings.sql. Roll back with 20261024120000_owner_tamper_alerts.rollback.sql.

CREATE TABLE IF NOT EXISTS public.owner_security_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  actor_name  text,
  actor_phone text,
  actor_roles text[],
  attempted   text NOT NULL,
  target      text,
  detail      jsonb,
  blocked     boolean NOT NULL,
  emailed     boolean NOT NULL DEFAULT false,
  ip_address  text,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS owner_security_alerts_recent_idx ON public.owner_security_alerts (occurred_at DESC);
ALTER TABLE public.owner_security_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.owner_security_alerts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.owner_security_alerts TO service_role;

-- Records the attempt and alerts the owner (in the app and by email).
CREATE OR REPLACE FUNCTION public.log_owner_tamper(p_attempted text, p_target text, p_detail jsonb, p_blocked boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_name text; v_phone text; v_roles text[]; v_hdr jsonb; v_ip text; v_ua text;
  v_to text; v_recent boolean; v_who text; v_msg text; v_html text; v_owner uuid;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT full_name, phone INTO v_name, v_phone FROM public.profiles WHERE id = v_uid;
    SELECT array_agg(role::text ORDER BY role::text) INTO v_roles FROM public.user_roles WHERE user_id = v_uid;
  END IF;
  BEGIN v_hdr := NULLIF(current_setting('request.headers', true), '')::jsonb; EXCEPTION WHEN others THEN v_hdr := NULL; END;
  v_ip := COALESCE(v_hdr ->> 'x-forwarded-for', v_hdr ->> 'x-real-ip'); v_ua := v_hdr ->> 'user-agent';

  v_recent := EXISTS (SELECT 1 FROM public.owner_security_alerts a WHERE a.actor_id IS NOT DISTINCT FROM v_uid AND a.attempted = p_attempted
                         AND a.target IS NOT DISTINCT FROM p_target AND a.emailed AND a.occurred_at > now() - interval '10 minutes');

  INSERT INTO public.owner_security_alerts (actor_id, actor_name, actor_phone, actor_roles, attempted, target, detail, blocked, emailed, ip_address, user_agent)
  VALUES (v_uid, v_name, v_phone, v_roles, p_attempted, p_target, p_detail, p_blocked, NOT v_recent, v_ip, v_ua);
  IF v_recent THEN RETURN; END IF;

  v_who := CASE WHEN v_uid IS NULL THEN 'No signed-in user (the service key, a script or the SQL editor)'
                ELSE COALESCE(v_name, 'Unknown') || COALESCE(' (' || v_phone || ')', '') || COALESCE(', roles: ' || array_to_string(v_roles, ', '), '') END;
  v_msg := v_who || ' ' || p_attempted || ' (' || COALESCE(p_target, '') || '). ' || CASE WHEN p_blocked THEN 'It was blocked: nothing changed.' ELSE 'It was allowed because no user was signed in. Check it was you.' END;

  FOR v_owner IN SELECT DISTINCT user_id FROM public.platform_owner LOOP
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (v_owner, 'Security alert: protected setting', v_msg, 'security', jsonb_build_object('kind', 'owner_tamper_alert', 'target', p_target, 'blocked', p_blocked));
  END LOOP;

  SELECT COALESCE(NULLIF(btrim(c.value), ''), 'joshua.wanda@welile.com') INTO v_to FROM public.treasury_controls c WHERE c.control_key = 'exception_approver_email';
  v_to := COALESCE(v_to, 'joshua.wanda@welile.com');
  v_html := '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px"><h2 style="color:#b91c1c;margin:0 0 12px">Security alert</h2><p>'
         || replace(replace(replace(v_msg, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p><p style="color:#64748b;font-size:12px">When: ' || to_char(now() AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI')
         || ' (Kampala)' || COALESCE('<br>From: ' || replace(v_ip, '<', ''), '') || '</p></div>';
  PERFORM public.enqueue_email('transactional_emails', jsonb_build_object(
    'message_id', gen_random_uuid()::text, 'to', v_to, 'from', 'Welile <noreply@welile.com>', 'sender_domain', 'notify.welile.com',
    'subject', CASE WHEN p_blocked THEN 'SECURITY: blocked an attempt to change ' ELSE 'SECURITY: changed without a signed-in user: ' END || COALESCE(p_target, 'a protected setting'),
    'html', v_html, 'text', v_msg, 'purpose', 'transactional', 'label', 'owner-tamper-alert', 'idempotency_key', 'owner-tamper:' || gen_random_uuid()::text, 'queued_at', now()));
EXCEPTION WHEN others THEN
  RAISE WARNING 'log_owner_tamper failed: %', SQLERRM;   -- never let a logging problem break the caller
END;
$function$;
REVOKE ALL ON FUNCTION public.log_owner_tamper(text, text, jsonb, boolean) FROM PUBLIC, anon, authenticated;

-- The setting guard: owner passes; others are blocked quietly and alerted; a change with no signed-in user is allowed but alerted.
CREATE OR REPLACE FUNCTION public.guard_owner_only_settings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  k_old text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.control_key END;
  k_new text := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.control_key END;
  v_key text := COALESCE(k_new, k_old);
  v_detail jsonb;
BEGIN
  IF NOT (COALESCE(k_old, '') IN ('exception_approver_email', 'landlord_gate_weekly_mode', 'landlord_payouts_blocked') OR COALESCE(k_old, '') LIKE 'landlord\_payout\_%'
       OR COALESCE(k_new, '') IN ('exception_approver_email', 'landlord_gate_weekly_mode', 'landlord_payouts_blocked') OR COALESCE(k_new, '') LIKE 'landlord\_payout\_%') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.control_key = OLD.control_key AND NEW.enabled IS NOT DISTINCT FROM OLD.enabled
     AND NEW.value IS NOT DISTINCT FROM OLD.value AND NEW.strict_mode IS NOT DISTINCT FROM OLD.strict_mode THEN
    RETURN NEW;   -- nothing actually changes
  END IF;
  IF auth.uid() IS NOT NULL AND public.is_platform_owner() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_detail := jsonb_build_object('operation', TG_OP,
    'old', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object('enabled', OLD.enabled, 'value', OLD.value) END,
    'new', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE jsonb_build_object('enabled', NEW.enabled, 'value', NEW.value) END);
  IF auth.uid() IS NULL THEN
    PERFORM public.log_owner_tamper('changed a protected setting with no signed-in user', v_key, v_detail, false);
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  PERFORM public.log_owner_tamper('tried to change a protected setting', v_key, v_detail, true);
  IF TG_OP = 'UPDATE' THEN RETURN OLD; END IF;
  RETURN NULL;
END;
$function$;

-- The owner reads the alerts.
CREATE OR REPLACE FUNCTION public.list_owner_security_alerts(p_limit integer DEFAULT 50)
RETURNS TABLE(occurred_at timestamptz, actor_name text, actor_phone text, actor_roles text[], attempted text, target text, blocked boolean, detail jsonb, ip_address text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_platform_owner() THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT a.occurred_at, a.actor_name, a.actor_phone, a.actor_roles, a.attempted, a.target, a.blocked, a.detail, a.ip_address
                 FROM public.owner_security_alerts a ORDER BY a.occurred_at DESC LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 500));
END;
$function$;
REVOKE ALL ON FUNCTION public.list_owner_security_alerts(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_owner_security_alerts(integer) TO authenticated;

-- The Financial Ops restriction functions: a non-owner is alerted and gets nothing (instead of an error that would erase the alert).
DO $patch$
DECLARE f text; v_oid oid; v_def text; v_new text; v_ret text; v_detail text;
BEGIN
  FOREACH f IN ARRAY ARRAY['list_financial_ops_restrictions', 'set_financial_ops_restriction', 'list_financial_ops_features'] LOOP
    SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f LIMIT 1;
    IF v_oid IS NULL THEN RAISE NOTICE 'SKIPPED % (not created yet)', f; CONTINUE; END IF;
    v_def := pg_get_functiondef(v_oid);
    IF v_def LIKE '%log_owner_tamper%' THEN CONTINUE; END IF;
    v_ret := CASE f WHEN 'set_financial_ops_restriction' THEN 'RETURN ARRAY[]::text[];' ELSE 'RETURN;' END;
    v_detail := CASE f WHEN 'set_financial_ops_restriction' THEN 'jsonb_build_object(''user'', p_user_id, ''areas'', p_areas)' ELSE '''{}''::jsonb' END;
    v_new := regexp_replace(v_def,
      'IF NOT public\.is_platform_owner\(\) THEN\s+RAISE EXCEPTION ''Not authorized'' USING ERRCODE = ''42501'';\s+END IF;',
      'IF NOT public.is_platform_owner() THEN PERFORM public.log_owner_tamper(''tried to use the Financial Ops restrictions'', ''' || f || ''', ' || v_detail || ', true); ' || v_ret || ' END IF;');
    IF v_new = v_def THEN RAISE EXCEPTION 'Could not patch %: owner check not found', f; END IF;
    EXECUTE v_new;
    RAISE NOTICE 'ALERTING %', f;
  END LOOP;
END
$patch$;
