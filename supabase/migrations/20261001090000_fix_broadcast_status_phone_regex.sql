-- Doc 181: get_sms_broadcast_status never counted a single delivery.
--
-- The 2026-07-08 versions (20260708173134, 20260708185222) wrote the phone filter as
--   l.phone ~ '^\\+256[0-9]{9}$'
-- JS-style escaping. With standard_conforming_strings = on (live: on) that regex wants a
-- literal backslash before "256", so no "+256..." phone ever matched. sent = 0 and
-- failed = 0 for every campaign, which the CTO Broadcast Status page renders as:
--   processed 0, queued = total_recipients, badge "Sending",
--   button "Retry failed (<total_recipients>)" ENABLED.
-- Live 2026-10-01 that showed 13,883 and 725 "outstanding" while the log holds
-- 13,758 + 724 valid sent rows. The page invites a retry of a campaign that is finished.
--
-- Fix: '^\+256[0-9]{9}$'. Everything else is the same body as the live function.
-- Corrected live counts (verified with the single-backslash regex before writing this):
--   welileapp-move-2026-07  total 13,883 = sent 13,758 + failed 125   -> outstanding 125
--   rent-access-30m-...-26  total   725 = sent   724 + failed   1   -> outstanding 1
-- The 474 rows in sms_broadcast_log that are not +256 format (foreign / stale numbers)
-- stay excluded, which is what the filter was written to do.
--
-- Not in critical_function_baselines (checked live). Signature and return type unchanged.

CREATE OR REPLACE FUNCTION public.get_sms_broadcast_status()
 RETURNS TABLE(campaign_key text, message text, audiences text[], total_recipients integer, run_count integer, status text, sent bigint, failed bigint, last_activity timestamp with time zone, last_run_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    c.campaign_key,
    c.message,
    c.audiences,
    c.total_recipients,
    c.run_count,
    c.status,
    COALESCE(s.sent, 0) AS sent,
    COALESCE(s.failed, 0) AS failed,
    s.last_activity,
    c.last_run_at,
    c.created_at,
    c.updated_at
  FROM public.sms_broadcast_campaigns c
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE l.status = 'sent' AND l.phone ~ '^\+256[0-9]{9}$') AS sent,
      count(*) FILTER (WHERE l.status = 'failed' AND l.phone ~ '^\+256[0-9]{9}$') AS failed,
      max(l.created_at) FILTER (WHERE l.status IN ('sent', 'failed') AND l.phone ~ '^\+256[0-9]{9}$') AS last_activity
    FROM public.sms_broadcast_log l
    WHERE l.campaign_key = c.campaign_key
  ) s ON true
  WHERE
    has_role(auth.uid(), 'manager'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
    OR has_role(auth.uid(), 'ceo'::app_role)
    OR has_role(auth.uid(), 'coo'::app_role)
    OR has_role(auth.uid(), 'cto'::app_role)
    OR has_role(auth.uid(), 'cmo'::app_role)
    OR has_role(auth.uid(), 'crm'::app_role)
  ORDER BY c.updated_at DESC;
$function$;
