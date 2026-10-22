-- Tenant Ops Calling Center, Weekly Forwarding report: "All calls made and taken this week".
-- Read-only. One row per caller, Kampala day, who was called, where the call was recorded and whether it was answered.
-- Sources (each verified against the live schema):
--   calling_center  cc_call_attempts (+ cc_cycle_rows for who was called); voided attempts excluded; answered = outcome 'engaged'
--   received        cc_received_calls (calls that came in; every one was taken)
--   crm_voice       crm_call_sessions (app voice calls); a session is dropped when the same caller already has a Calling Center attempt to the
--                   same person within 15 minutes, so one call is never counted twice
--   awareness       rent_pipeline_awareness_calls
--   legacy_tenant / legacy_landlord   tenant_call_reports / landlord_call_reports (kept for history)
-- Authorised exactly like cc_concern_handling_report. No writes anywhere.

CREATE OR REPLACE FUNCTION public.cc_weekly_all_calls_report(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(
  caller_id    uuid,
  caller_name  text,
  kampala_day  date,
  subject_kind text,
  source       text,
  answered     boolean,
  calls        integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH attempts AS (
    SELECT a.caller_id,
           coalesce(a.recorded_at, a.created_at) AS ts,
           r.subject_type::text AS kind,
           r.subject_id,
           (a.outcome::text = 'engaged') AS answered
      FROM public.cc_call_attempts a
      JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
     WHERE a.void_reason IS NULL
       AND coalesce(a.recorded_at, a.created_at) >= p_from
       AND coalesce(a.recorded_at, a.created_at) <  p_to
  ), all_calls AS (
    SELECT t.caller_id, NULL::text AS fallback_name, t.ts,
           CASE WHEN t.kind IN ('tenant', 'landlord', 'agent') THEN t.kind ELSE 'other' END AS kind,
           'calling_center'::text AS source, t.answered
      FROM attempts t
    UNION ALL
    SELECT c.recorded_by, c.recorded_by_name, c.called_at,
           CASE WHEN c.linked_kind IN ('tenant', 'landlord', 'agent') THEN c.linked_kind ELSE 'other' END,
           'received', true
      FROM public.cc_received_calls c
     WHERE c.called_at >= p_from AND c.called_at < p_to
    UNION ALL
    SELECT s.staff_id, NULL, s.created_at,
           CASE s.target_role WHEN 'tenant' THEN 'tenant' WHEN 'agent' THEN 'agent' WHEN 'landlord' THEN 'landlord' ELSE 'other' END,
           'crm_voice', (s.answered_at IS NOT NULL)
      FROM public.crm_call_sessions s
     WHERE s.created_at >= p_from AND s.created_at < p_to
       AND NOT EXISTS (
         SELECT 1 FROM attempts t
          WHERE t.caller_id = s.staff_id
            AND t.subject_id = s.target_user_id
            AND abs(extract(epoch FROM (t.ts - s.created_at))) <= 15 * 60
       )
    UNION ALL
    SELECT w.caller_id, NULL, coalesce(w.recorded_at, w.dial_started_at),
           CASE WHEN w.subject_type IN ('tenant', 'landlord', 'agent') THEN w.subject_type ELSE 'other' END,
           'awareness', (w.call_result = 'answered')
      FROM public.rent_pipeline_awareness_calls w
     WHERE coalesce(w.recorded_at, w.dial_started_at) >= p_from
       AND coalesce(w.recorded_at, w.dial_started_at) <  p_to
    UNION ALL
    SELECT l.called_by, NULL, l.called_at, 'tenant', 'legacy_tenant', (l.outcome = 'picked_up')
      FROM public.tenant_call_reports l
     WHERE l.called_at >= p_from AND l.called_at < p_to
    UNION ALL
    SELECT l.called_by, NULL, l.called_at, 'landlord', 'legacy_landlord', (l.status = 'picked_up')
      FROM public.landlord_call_reports l
     WHERE l.called_at >= p_from AND l.called_at < p_to
  )
  SELECT x.caller_id,
         coalesce(p.full_name, max(x.fallback_name), 'Call centre officer') AS caller_name,
         (x.ts AT TIME ZONE 'Africa/Kampala')::date AS kampala_day,
         x.kind AS subject_kind,
         x.source,
         coalesce(x.answered, false) AS answered,
         count(*)::integer AS calls
    FROM all_calls x
    LEFT JOIN public.profiles p ON p.id = x.caller_id
   WHERE x.ts IS NOT NULL
     AND auth.uid() IS NOT NULL
     AND (
       public.is_welile_staff(auth.uid())
       OR public.is_cc_concern_overseer(auth.uid())
       OR public.has_role(auth.uid(), 'super_admin'::app_role)
     )
   GROUP BY x.caller_id, p.full_name, (x.ts AT TIME ZONE 'Africa/Kampala')::date, x.kind, x.source, coalesce(x.answered, false)
   ORDER BY 3, 2, 4, 5
$function$;

REVOKE ALL ON FUNCTION public.cc_weekly_all_calls_report(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cc_weekly_all_calls_report(timestamptz, timestamptz) TO authenticated;
