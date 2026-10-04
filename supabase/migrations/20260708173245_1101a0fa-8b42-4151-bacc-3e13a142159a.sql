CREATE OR REPLACE FUNCTION public.increment_broadcast_run(p_campaign_key text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.sms_broadcast_campaigns
  SET run_count = run_count + 1,
      updated_at = now()
  WHERE campaign_key = p_campaign_key;
$$;

GRANT EXECUTE ON FUNCTION public.increment_broadcast_run(text) TO service_role;