CREATE OR REPLACE FUNCTION public.get_my_usage_report_notices()
 RETURNS TABLE(requisition_id uuid, requisition_code text, title text, amount numeric, approved_amount numeric, reason text, category text, cfo_decided_at timestamp with time zone, grace_ends_at timestamp with time zone, deferral_count integer, max_deferrals integer, mandatory boolean, acknowledged boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT r.id, r.requisition_code, r.title, r.amount, r.approved_amount, r.reason, r.category::text,
    r.cfo_decided_at, r.cfo_decided_at + interval '36 hours',
    d.n, 2, d.n >= 2,
    EXISTS (SELECT 1 FROM public.staff_requisition_usage_report_events e WHERE e.requisition_id = r.id AND e.event = 'acknowledged')
  FROM public.staff_requisitions r
  CROSS JOIN LATERAL (SELECT count(*)::int n FROM public.staff_requisition_usage_report_deferrals x WHERE x.requisition_id = r.id) d
  WHERE auth.uid() IS NOT NULL AND r.requester_id = auth.uid() AND r.stage = 'approved'
    AND r.cfo_decided_at IS NOT NULL AND r.cfo_decided_at + interval '36 hours' <= now()
    AND (r.request_kind IS NULL OR r.request_kind <> 'facilitation')
    AND NOT EXISTS (SELECT 1 FROM public.staff_requisition_usage_reports u WHERE u.requisition_id = r.id)
    -- Payment reversed back to the company (structured record written by requisition-reverse): nothing to account for
    AND NOT EXISTS (
      SELECT 1 FROM public.requisition_wallet_credits c
      WHERE c.source_table = 'staff_requisitions' AND c.requisition_id = r.id AND c.status = 'reversed'
    )
  ORDER BY r.cfo_decided_at ASC LIMIT 50
$function$;