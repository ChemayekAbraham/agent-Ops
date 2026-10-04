-- Send funder progress notices the moment they are queued (wake-on-enqueue),
-- with an hourly backstop that only retries rows still unsent.
CREATE OR REPLACE FUNCTION public.enqueue_funder_house_notice(
  p_dedupe_key text,
  p_kind text,
  p_partner_id uuid,
  p_supported_house_id uuid,
  p_house_id uuid,
  p_commitment_id uuid,
  p_house_title text,
  p_district text,
  p_house_count integer,
  p_monthly_rent numeric,
  p_principal numeric,
  p_agent_name text,
  p_placed_at timestamptz,
  p_earning_started_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile record;
  v_monthly_return numeric := round(COALESCE(p_principal, 0) * 0.15);
  v_title text;
  v_message text;
  v_house text := COALESCE(NULLIF(p_house_title, ''), 'your funded house');
  v_id uuid;
BEGIN
  IF p_partner_id IS NULL THEN RETURN; END IF;

  SELECT full_name, email, phone INTO v_profile
  FROM public.profiles WHERE id = p_partner_id;

  INSERT INTO public.funder_house_progress_notices (
    dedupe_key, kind, partner_id, supported_house_id, house_id, commitment_id,
    partner_name, email, phone, house_title, district, house_count,
    monthly_rent, principal, monthly_return, agent_name, placed_at, earning_started_at
  ) VALUES (
    p_dedupe_key, p_kind, p_partner_id, p_supported_house_id, p_house_id, p_commitment_id,
    v_profile.full_name, v_profile.email, v_profile.phone, p_house_title, p_district,
    GREATEST(COALESCE(p_house_count, 1), 1), COALESCE(p_monthly_rent, 0),
    COALESCE(p_principal, 0), v_monthly_return, p_agent_name, p_placed_at, p_earning_started_at
  )
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RETURN; END IF;

  IF p_kind = 'agent_assigned' THEN
    v_title := 'A Welile agent is on your house';
    v_message := COALESCE(NULLIF(p_agent_name, ''), 'A Welile agent')
      || ' has been assigned to ' || v_house
      || ' and is sourcing a tenant. Tenants are placed within 7 days of funding.';
  ELSIF p_kind = 'tenant_placed' THEN
    v_title := 'Tenant placed in your house';
    v_message := 'A tenant has moved into ' || v_house
      || '. Your Returns start as soon as the tenant begins paying rent.';
  ELSE
    v_title := 'Your Returns have started';
    v_message := 'Your money is now working. You are earning about UGX '
      || to_char(v_monthly_return, 'FM999,999,999,999')
      || ' a month in Returns, paid into your Welile wallet.';
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, event_key, link_path, metadata)
  VALUES (
    p_partner_id, v_title, v_message, 'success', p_dedupe_key, '/dashboard/funder',
    jsonb_build_object('kind', p_kind, 'house_id', p_house_id, 'supported_house_id', p_supported_house_id)
  )
  ON CONFLICT DO NOTHING;

  -- Wake the worker for this row only. Never fatal to the caller.
  BEGIN
    PERFORM net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/notify-funder-house-progress',
      headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
      body := jsonb_build_object('notice_id', v_id)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_funder_house_notice(text,text,uuid,uuid,uuid,uuid,text,text,integer,numeric,numeric,text,timestamptz,timestamptz) FROM PUBLIC;

-- Hourly retry backstop: only fires when unsent rows remain.
CREATE OR REPLACE FUNCTION public.retry_funder_house_progress_notices()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.funder_house_progress_notices
    WHERE (sms_sent_at IS NULL OR email_sent_at IS NULL)
      AND created_at > now() - interval '7 days'
  ) THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/notify-funder-house-progress',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
    body := '{"limit":50}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.retry_funder_house_progress_notices() FROM PUBLIC;

DO $cron$
BEGIN
  BEGIN
    PERFORM cron.unschedule('notify-funder-house-progress-hourly-retry');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  PERFORM cron.schedule(
    'notify-funder-house-progress-hourly-retry',
    '15 * * * *',
    $$select public.retry_funder_house_progress_notices();$$
  );
END
$cron$;
