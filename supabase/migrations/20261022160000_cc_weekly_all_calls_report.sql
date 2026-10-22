-- Tenant Ops Calling Center, Weekly Forwarding report: "All calls made and taken this week".
-- Read-only. One row per caller, Kampala day, who was called, where the call was recorded and whether it was answered.
-- "All calls" = the calls made in the Rent Plan pipeline (at landlords and at tenants), the calls made and taken in the Calling Centers, and the
-- awareness calls, each counted ONCE. The same phone call is often written in more than one place, so a call is dropped when a record of higher
-- priority already shows the same caller phoning the same person (same user, or the same Rent Plan) within 15 minutes.
-- Sources (each verified against the live schema), highest priority first:
--   calling_center      cc_call_attempts (+ cc_cycle_rows for who was called); voided attempts excluded; answered = outcome 'engaged'
--   received            cc_received_calls (calls that came in; every one was taken)
--   awareness           rent_pipeline_awareness_calls (calls made from the Rent Plan pipeline to the tenant, landlord or agent)
--   pipeline_landlord   Landlord Ops landlord verification calls on a Rent Plan (rent_requests.landlord_verification_method = 'phone_call',
--                       landlord_called = true; dated landlord_ops_reviewed_at, by landlord_ops_reviewed_by; answered = landlord_acknowledged)
--   crm_voice           crm_call_sessions (app voice calls), answered = answered_at is set
--   legacy_tenant / legacy_landlord   tenant_call_reports / landlord_call_reports (kept for history; the Calling Center also records these as attempts)
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
  WITH raw AS (
    SELECT a.caller_id, NULL::text AS fallback_name, coalesce(a.recorded_at, a.created_at) AS ts,
           CASE WHEN r.subject_type::text IN ('tenant', 'landlord', 'agent') THEN r.subject_type::text ELSE 'other' END AS kind,
           'calling_center'::text AS source, 1 AS prio, (a.outcome::text = 'engaged') AS answered,
           r.subject_id AS person_id, NULL::uuid AS rr_id
      FROM public.cc_call_attempts a
      JOIN public.cc_cycle_rows r ON r.id = a.cycle_row_id
     WHERE a.void_reason IS NULL
    UNION ALL
    SELECT c.recorded_by, c.recorded_by_name, c.called_at,
           CASE WHEN c.linked_kind IN ('tenant', 'landlord', 'agent') THEN c.linked_kind ELSE 'other' END,
           'received', 1, true, NULL::uuid, NULL::uuid
      FROM public.cc_received_calls c
    UNION ALL
    SELECT w.caller_id, NULL, coalesce(w.recorded_at, w.dial_started_at),
           CASE WHEN w.subject_type IN ('tenant', 'landlord', 'agent') THEN w.subject_type ELSE 'other' END,
           'awareness', 2, (w.call_result = 'answered'), w.subject_user_id, w.rent_request_id
      FROM public.rent_pipeline_awareness_calls w
    UNION ALL
    SELECT q.landlord_ops_reviewed_by, NULL, q.landlord_ops_reviewed_at, 'landlord',
           'pipeline_landlord', 3, coalesce(q.landlord_acknowledged, false), NULL::uuid, q.id
      FROM public.rent_requests q
     WHERE q.landlord_called IS TRUE
       AND q.landlord_verification_method = 'phone_call'
       AND q.landlord_ops_reviewed_by IS NOT NULL
    UNION ALL
    SELECT s.staff_id, NULL, s.created_at,
           CASE s.target_role WHEN 'tenant' THEN 'tenant' WHEN 'agent' THEN 'agent' WHEN 'landlord' THEN 'landlord' ELSE 'other' END,
           'crm_voice', 4, (s.answered_at IS NOT NULL), s.target_user_id, NULL::uuid
      FROM public.crm_call_sessions s
    UNION ALL
    SELECT l.called_by, NULL, l.called_at, 'tenant', 'legacy_tenant', 5, (l.outcome = 'picked_up'), l.tenant_id, l.rent_request_id
      FROM public.tenant_call_reports l
    UNION ALL
    SELECT l.called_by, NULL, l.called_at, 'landlord', 'legacy_landlord', 5, (l.status = 'picked_up'), NULL::uuid, NULL::uuid
      FROM public.landlord_call_reports l
  ), in_week AS (
    SELECT row_number() OVER () AS uid, x.*
      FROM raw x
     WHERE x.ts IS NOT NULL AND x.ts >= p_from AND x.ts < p_to
  ), kept AS (
    -- one phone call is often written in more than one place: keep the highest-priority record only
    SELECT m.*
      FROM in_week m
     WHERE NOT EXISTS (
       SELECT 1 FROM in_week h
        WHERE h.prio < m.prio
          AND m.caller_id IS NOT NULL
          AND h.caller_id = m.caller_id
          AND abs(extract(epoch FROM (h.ts - m.ts))) <= 15 * 60
          AND (
            (h.person_id IS NOT NULL AND h.person_id = m.person_id)
            OR (h.rr_id IS NOT NULL AND h.rr_id = m.rr_id)
          )
     )
  )
  SELECT k.caller_id,
         coalesce(p.full_name, max(k.fallback_name), 'Call centre officer') AS caller_name,
         (k.ts AT TIME ZONE 'Africa/Kampala')::date AS kampala_day,
         k.kind AS subject_kind,
         k.source,
         coalesce(k.answered, false) AS answered,
         count(*)::integer AS calls
    FROM kept k
    LEFT JOIN public.profiles p ON p.id = k.caller_id
   WHERE auth.uid() IS NOT NULL
     AND (
       public.is_welile_staff(auth.uid())
       OR public.is_cc_concern_overseer(auth.uid())
       OR public.has_role(auth.uid(), 'super_admin'::app_role)
     )
   GROUP BY k.caller_id, p.full_name, (k.ts AT TIME ZONE 'Africa/Kampala')::date, k.kind, k.source, coalesce(k.answered, false)
   ORDER BY 3, 2, 4, 5
$function$;

REVOKE ALL ON FUNCTION public.cc_weekly_all_calls_report(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cc_weekly_all_calls_report(timestamptz, timestamptz) TO authenticated;
