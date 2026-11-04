-- Requisitions: a REFUND request does not ask for a usage report.
--
-- A refund request is a requisition raised with the category "Refund request" (the Ask for a refund button in My Requisitions): money the person paid
-- themselves and wants back. It goes through the same review chain and is paid the same way, but the proof is the receipt they attach when they ask,
-- so there is no money to account for afterwards and no usage report is due.
--   1. get_my_usage_report_notices() skips refund requests (everything else in it is unchanged).
--   2. A refund request cannot be approved with no receipt or proof attached, so the exemption cannot be used to take money with nothing to show for it.
-- Changes no existing row. Roll back with 20261103110000_refund_requests_skip_usage_report.rollback.sql.

CREATE OR REPLACE FUNCTION public.is_refund_requisition(p_category text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT lower(btrim(coalesce(p_category, ''))) = 'refund request'
$function$;

CREATE OR REPLACE FUNCTION public.get_my_usage_report_notices()
 RETURNS TABLE(requisition_id uuid, requisition_code text, title text, amount numeric, approved_amount numeric, reason text, category text, cfo_decided_at timestamp with time zone, grace_ends_at timestamp with time zone, deferral_count integer, max_deferrals integer, mandatory boolean, acknowledged boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT r.id, r.requisition_code, r.title, r.amount, r.approved_amount, r.reason, r.category::text,
    r.cfo_decided_at, r.cfo_decided_at + interval '1 day',
    d.n, 2, d.n >= 2,
    EXISTS (SELECT 1 FROM public.staff_requisition_usage_report_events e WHERE e.requisition_id = r.id AND e.event = 'acknowledged')
  FROM public.staff_requisitions r
  CROSS JOIN LATERAL (SELECT count(*)::int n FROM public.staff_requisition_usage_report_deferrals x WHERE x.requisition_id = r.id) d
  WHERE auth.uid() IS NOT NULL AND r.requester_id = auth.uid() AND r.stage = 'approved'
    AND r.cfo_decided_at IS NOT NULL AND r.cfo_decided_at + interval '1 day' <= now()
    AND (r.request_kind IS NULL OR r.request_kind <> 'facilitation')
    -- A refund request is proved by the receipt attached when it was raised: no usage report
    AND NOT public.is_refund_requisition(r.category)
    AND NOT EXISTS (SELECT 1 FROM public.staff_requisition_usage_reports u WHERE u.requisition_id = r.id)
    -- Payment reversed back to the company (structured record written by requisition-reverse): nothing to account for
    AND NOT EXISTS (
      SELECT 1 FROM public.requisition_wallet_credits c
      WHERE c.source_table = 'staff_requisitions' AND c.requisition_id = r.id AND c.status = 'reversed'
    )
  ORDER BY r.cfo_decided_at ASC LIMIT 50
$function$;

-- A refund request needs its receipt before it can be approved.
CREATE OR REPLACE FUNCTION public.guard_refund_requisition_proof()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.stage = 'approved' AND OLD.stage IS DISTINCT FROM 'approved'
     AND public.is_refund_requisition(NEW.category)
     AND coalesce(cardinality(NEW.attachment_urls), 0) = 0 THEN
    RAISE EXCEPTION 'A refund request needs at least one receipt or proof attached before it can be approved.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_refund_requisition_proof ON public.staff_requisitions;
CREATE TRIGGER trg_guard_refund_requisition_proof
  BEFORE UPDATE OF stage ON public.staff_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.guard_refund_requisition_proof();

GRANT EXECUTE ON FUNCTION public.is_refund_requisition(text) TO authenticated;
