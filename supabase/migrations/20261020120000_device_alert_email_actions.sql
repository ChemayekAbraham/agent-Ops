-- New-device alert: answer from the email (2026-10-20).
--
-- The alert email now carries two links, "Yes, this was me" and "No, sign it out",
-- for an owner who can't reach one of their trusted devices. Each link holds a
-- random single-use token (only its SHA-256 is stored), tied to one account and
-- one device, valid 7 days. Opening a link shows a confirm page; nothing happens
-- until the person presses confirm, because mail security scanners open links
-- by themselves. Using either link spends both.
--
-- Also fixes: block_all_notification_inserts silently dropped every notification
-- whose type was not on its allowlist, so the 'security' notifications from
-- 20261020100000 were never stored (emails and the dialog were unaffected).
-- Body below is the live definition with 'security' added.

CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(NEW.type, '') IN (
    'merchandise_recovery','director_requisition','advance_arrears','budget',
    'staff_requisition','hr_birthday','rd_alert','lending_repayment',
    'float','bike_lease_reminder','wallet_transfer_reversal',
    'security'
  ) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.metadata->>'action','') IN ('listing_rejected','subagent_listing_rejected') THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.metadata->>'kind','') = 'landlord_payout_rejected' THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE TABLE IF NOT EXISTS public.device_alert_action_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_fp text NOT NULL,
  action text NOT NULL CHECK (action IN ('trust', 'reject')),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_device_alert_action_tokens_device
  ON public.device_alert_action_tokens (user_id, device_fp);
ALTER TABLE public.device_alert_action_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.device_alert_action_tokens FROM anon, authenticated;

-- p_peek = true: say what the link would do, without doing it (the confirm page).
-- p_peek = false: do it. The device must still be awaiting an answer.
CREATE OR REPLACE FUNCTION public.use_device_alert_token(p_token_hash text, p_peek boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tok public.device_alert_action_tokens;
  v_dev public.login_devices;
  v_sessions integer := 0;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;

  SELECT * INTO v_tok FROM public.device_alert_action_tokens WHERE token_hash = p_token_hash
   FOR UPDATE;
  IF v_tok.token_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid');
  END IF;
  IF v_tok.used_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'used');
  END IF;
  IF v_tok.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;

  SELECT * INTO v_dev FROM public.login_devices
   WHERE user_id = v_tok.user_id AND device_fp = v_tok.device_fp
   FOR UPDATE;
  IF v_dev.device_fp IS NULL OR v_dev.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'answered',
                              'status', COALESCE(v_dev.status, 'gone'));
  END IF;

  IF p_peek THEN
    RETURN jsonb_build_object(
      'ok', true, 'action', v_tok.action,
      'os', v_dev.os, 'browser', v_dev.browser, 'user_agent', v_dev.user_agent,
      'city', v_dev.ip_city, 'country', v_dev.ip_country,
      'signed_in_at', COALESCE(v_dev.alerted_at, v_dev.first_seen_at)
    );
  END IF;

  -- Spend both links for this device, then apply the answer.
  UPDATE public.device_alert_action_tokens SET used_at = now()
   WHERE user_id = v_tok.user_id AND device_fp = v_tok.device_fp AND used_at IS NULL;

  IF v_tok.action = 'trust' THEN
    UPDATE public.login_devices
       SET status = 'trusted', decided_at = now(), decided_from_device_fp = 'email'
     WHERE user_id = v_tok.user_id AND device_fp = v_tok.device_fp;
  ELSE
    UPDATE public.login_devices
       SET status = 'rejected', decided_at = now(), decided_from_device_fp = 'email'
     WHERE user_id = v_tok.user_id AND device_fp = v_tok.device_fp;
    IF v_dev.auth_session_id IS NOT NULL THEN
      DELETE FROM auth.sessions WHERE id = v_dev.auth_session_id AND user_id = v_tok.user_id;
      GET DIAGNOSTICS v_sessions = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'action', v_tok.action, 'user_id', v_tok.user_id, 'device_fp', v_tok.device_fp,
    'os', v_dev.os, 'browser', v_dev.browser, 'user_agent', v_dev.user_agent,
    'city', v_dev.ip_city, 'country', v_dev.ip_country, 'sessions_ended', v_sessions
  );
END
$$;
REVOKE ALL ON FUNCTION public.use_device_alert_token(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.use_device_alert_token(text, boolean) TO service_role;

-- Spent and expired links are useless after 90 days; clear them with the other device data.
CREATE OR REPLACE FUNCTION public.purge_login_device_network_data()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.login_devices
     SET last_ip = NULL, ip_city = NULL, ip_country = NULL
   WHERE last_seen_at < now() - interval '90 days'
     AND (last_ip IS NOT NULL OR ip_city IS NOT NULL OR ip_country IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM public.device_step_up_challenges WHERE created_at < now() - interval '90 days';
  DELETE FROM public.device_alert_action_tokens WHERE created_at < now() - interval '90 days';
  RETURN v_n;
END
$$;
