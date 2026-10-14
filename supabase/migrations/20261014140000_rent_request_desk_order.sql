-- Rent-request desks: one server-side ordering RPC with the tenant payment score joined in.
--
-- Read-only. One new function and nothing else. Not edited: any status transition, approval or review function
-- (service_center_review_rent_request, return_rent_request_for_correction, the stage approvals), get_service_center_rent_queue,
-- tenant_payment_score and its helpers, rent_requests and every other table. The function is STABLE and writes nothing.
--
--   rent_request_desk_order(p_request_ids uuid[], p_sort text DEFAULT 'best_payers')
--     For the requests a desk already loaded (so the desk's own limit and pagination are untouched) it returns, per request,
--     the 1-based rank the desk should show it at, plus the tenant's payment score, label, reason and basis.
--       best_payers (default)  score high to low, then created_at oldest first, then id
--       newest                 created_at newest first, then id
--       oldest                 created_at oldest first, then id
--     A request whose tenant has no score (no tenant) sorts last under best_payers. NULL or blank p_sort means best_payers.
--     Scores are computed here, on the shared tenant payment-score rules, as at today in Kampala; the client never computes one.
--     Ids that are not rent requests are ignored. Up to 20000 ids per call.
--
-- Access: signed-in users with a rent-desk role (the ten staff roles of _am_staff_ok(), plus landlord_ops and partner_ops, who
-- work these desks) may rank any request. Anyone else may rank only requests routed to them as Service Center manager
-- (rent_requests.service_center_manager_id = their id); one request outside that refuses the whole call. Signed-out and anon: no access.

CREATE OR REPLACE FUNCTION public.rent_request_desk_order(p_request_ids uuid[], p_sort text DEFAULT 'best_payers')
RETURNS TABLE (
  request_id uuid,
  tenant_id  uuid,
  rank       integer,
  score      integer,
  label      text,
  reason     text,
  basis      text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_sort text := COALESCE(NULLIF(btrim(p_sort), ''), 'best_payers');
  v_desk boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_sort NOT IN ('best_payers', 'newest', 'oldest') THEN
    RAISE EXCEPTION 'p_sort must be best_payers, newest or oldest' USING ERRCODE = '22023';
  END IF;

  v_desk := public._am_staff_ok()
         OR EXISTS (SELECT 1 FROM public.user_roles ur
                     WHERE ur.user_id = v_uid AND ur.enabled = true
                       AND ur.role::text IN ('landlord_ops', 'partner_ops'));

  IF NOT v_desk THEN
    -- a Service Center manager may rank only what is routed to them; one request outside that refuses the call
    IF p_request_ids IS NULL OR cardinality(p_request_ids) = 0
       OR EXISTS (SELECT 1 FROM unnest(p_request_ids) AS i(id)
                   WHERE i.id IS NULL
                      OR NOT EXISTS (SELECT 1 FROM public.rent_requests rr
                                      WHERE rr.id = i.id AND rr.service_center_manager_id = v_uid)) THEN
      RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_request_ids IS NULL OR cardinality(p_request_ids) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(p_request_ids) > 20000 THEN
    RAISE EXCEPTION 'Too many requests in one call (max 20000)' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH req AS (
    SELECT rr.id AS rid, rr.tenant_id AS tid, rr.created_at AS created
      FROM public.rent_requests rr
     WHERE rr.id = ANY (p_request_ids)
  ),
  sc AS (
    SELECT s.tenant_id AS tid, s.score AS score, s.label AS label, s.reason AS reason, s.basis AS basis
      FROM public._tenant_payment_score_core(
             ARRAY(SELECT DISTINCT q.tid FROM req q WHERE q.tid IS NOT NULL),
             (now() AT TIME ZONE 'Africa/Kampala')::date) s
  )
  SELECT r.rid,
         r.tid,
         (row_number() OVER (
            ORDER BY CASE WHEN v_sort = 'best_payers' THEN sc.score END DESC NULLS LAST,
                     CASE WHEN v_sort = 'newest' THEN r.created END DESC NULLS LAST,
                     CASE WHEN v_sort IN ('best_payers', 'oldest') THEN r.created END ASC NULLS LAST,
                     r.rid))::integer,
         sc.score, sc.label, sc.reason, sc.basis
    FROM req r
    LEFT JOIN sc ON sc.tid = r.tid
   ORDER BY 3;
END;
$function$;

REVOKE ALL ON FUNCTION public.rent_request_desk_order(uuid[], text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.rent_request_desk_order(uuid[], text) TO authenticated;
