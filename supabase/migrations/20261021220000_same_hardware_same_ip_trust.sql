-- Stop re-alerting for a device the owner already approved (2026-10-21).
--
-- The same Chrome on the same Windows PC was raising "New sign-in" again and
-- again for an owner who had approved it: its device fingerprint changed 5 times
-- in 3 days while its hardware fingerprint and IP stayed identical. The device id
-- is built from a per-browser seed, so it changes when that seed is wiped or when
-- the same browser uses another origin (welileapp.com, the Lovable preview,
-- localhost each have their own storage). 18 accounts had the same hardware show
-- up as extra devices (28 extra rows).
--
-- Rule now: a "new" device is trusted silently when the account already trusts a
-- device with the same hardware fingerprint, seen from the same IP in the last 30
-- days. Anything else still alerts. IP is recorded on every check (it was only
-- stored when an alert fired); it is cleared after 90 days by the existing purge.
--
-- Signature changes (new p_ip), so DROP + CREATE; grants are reset by that and
-- re-granted below. Body otherwise identical to 20261020100000 (checked against
-- the live definition).

DROP FUNCTION IF EXISTS public.register_login_device(uuid, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.register_login_device(
  p_user_id uuid,
  p_device_fp text,
  p_hw_fp text DEFAULT NULL,
  p_user_agent text DEFAULT NULL,
  p_session_id uuid DEFAULT NULL,
  p_ip text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.login_devices;
  v_had_any boolean;
  v_same_hw_ip boolean := false;
  v_staff boolean;
  v_earlier integer := 0;
  v_required boolean;
BEGIN
  IF p_user_id IS NULL OR p_device_fp IS NULL
     OR NOT (p_device_fp ~ '^[a-f0-9]{64}$' OR p_device_fp ~ '^fb_[a-f0-9]{1,64}$') THEN
    RETURN jsonb_build_object('step_up_required', false, 'new_device_alert', false, 'revoked', false, 'reason', 'no_fingerprint');
  END IF;
  IF p_hw_fp IS NOT NULL AND NOT (p_hw_fp ~ '^[a-f0-9]{64}$' OR p_hw_fp ~ '^fb_[a-f0-9]{1,64}$') THEN
    p_hw_fp := NULL;
  END IF;

  p_ip := NULLIF(left(btrim(COALESCE(p_ip, '')), 64), '');
  v_had_any := EXISTS (SELECT 1 FROM public.login_devices WHERE user_id = p_user_id);

  -- The same browser can arrive with a fresh device id (its per-browser seed was
  -- wiped, or it is the same browser on another origin: welileapp.com, the
  -- Lovable preview, localhost). If this account already trusts a device with the
  -- same hardware fingerprint, seen from the same IP in the last 30 days, it is
  -- that device: trust it silently instead of alerting the owner again.
  -- Hardware alone is not enough (identical phones collide), and a changed IP
  -- alone never raises an alert by itself.
  IF v_had_any AND p_hw_fp IS NOT NULL AND p_ip IS NOT NULL THEN
    v_same_hw_ip := EXISTS (
      SELECT 1 FROM public.login_devices o
       WHERE o.user_id = p_user_id
         AND o.device_fp <> p_device_fp
         AND o.status = 'trusted'
         AND o.hw_fp = p_hw_fp
         AND o.last_ip = p_ip
         AND o.last_seen_at > now() - interval '30 days'
    );
  END IF;

  INSERT INTO public.login_devices (device_fp, user_id, hw_fp, user_agent, auth_session_id, last_ip, status,
                                    decided_at, decided_from_device_fp)
  VALUES (p_device_fp, p_user_id, p_hw_fp, left(p_user_agent, 300), p_session_id, p_ip,
          CASE WHEN v_had_any AND NOT v_same_hw_ip THEN 'pending' ELSE 'trusted' END,
          CASE WHEN v_same_hw_ip THEN now() END,
          CASE WHEN v_same_hw_ip THEN 'same_hardware_and_ip' END)
  ON CONFLICT (device_fp, user_id) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.device_fp IS NULL THEN
    SELECT * INTO v_row FROM public.login_devices
     WHERE device_fp = p_device_fp AND user_id = p_user_id
     FOR UPDATE;

    IF v_row.status = 'rejected' AND p_session_id IS NOT NULL
       AND p_session_id IS DISTINCT FROM v_row.auth_session_id THEN
      -- A fresh sign-in on a device the owner rejected: ask the owner again.
      UPDATE public.login_devices
         SET status = 'pending', alerted_at = NULL, decided_at = NULL, decided_from_device_fp = NULL,
             auth_session_id = p_session_id, last_seen_at = now(), login_count = login_count + 1,
             last_ip = COALESCE(p_ip, last_ip),
             hw_fp = COALESCE(p_hw_fp, hw_fp), user_agent = COALESCE(left(p_user_agent, 300), user_agent)
       WHERE device_fp = p_device_fp AND user_id = p_user_id
      RETURNING * INTO v_row;
    ELSE
      UPDATE public.login_devices
         SET last_seen_at = now(), login_count = login_count + 1,
             last_ip = COALESCE(p_ip, last_ip),
             hw_fp = COALESCE(p_hw_fp, hw_fp), user_agent = COALESCE(left(p_user_agent, 300), user_agent),
             -- Keep pointing at the rejected session so the check below can still see it.
             auth_session_id = CASE WHEN status = 'rejected' THEN auth_session_id
                                    ELSE COALESCE(p_session_id, auth_session_id) END
       WHERE device_fp = p_device_fp AND user_id = p_user_id
      RETURNING * INTO v_row;
    END IF;
  END IF;

  -- Shared-device step-up (unchanged rule): 3rd+ public account on this device.
  v_staff := public.is_staff_account(p_user_id);
  SELECT count(*) INTO v_earlier
    FROM public.login_devices o
   WHERE o.device_fp = p_device_fp
     AND o.user_id <> p_user_id
     AND o.first_seen_at < v_row.first_seen_at
     AND NOT public.is_staff_account(o.user_id);
  v_required := NOT v_staff AND v_earlier >= 2 AND v_row.step_up_verified_at IS NULL;
  IF v_required AND v_row.step_up_required_at IS NULL THEN
    UPDATE public.login_devices SET step_up_required_at = now()
     WHERE device_fp = p_device_fp AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'step_up_required', v_required,
    'earlier_accounts', v_earlier,
    'verified', v_row.step_up_verified_at IS NOT NULL,
    'is_staff', v_staff,
    'device_status', v_row.status,
    'new_device_alert', v_row.status = 'pending' AND v_row.alerted_at IS NULL,
    'revoked', v_row.status = 'rejected'
  );
END
$$;
REVOKE ALL ON FUNCTION public.register_login_device(uuid, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_login_device(uuid, text, text, text, uuid, text) TO service_role;
