-- Rollback for 20261014180000_rent_desk_filters.sql
-- Puts back the ordering RPC as 20261014140000 left it (two arguments, no filters or counts) and the old "plan" / "plans"
-- wording in the payment-score reason. Nothing else was edited by the migration, so nothing else needs restoring. Roll the app
-- back with it (the filters, the label chip and the URL state in src/hooks/useRentDeskOrder.ts and the three desks): a desk
-- whose ordering call fails simply keeps the order it already had and shows every row.
DROP FUNCTION IF EXISTS public.rent_request_desk_order(uuid[], text, text[], text, date, date);

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

-- the old reason wording (rows already stored keep whatever they were written with)
DO $rb$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public._tenant_payment_score_core(uuid[],date)'::regprocedure);
  IF position('of %s Rent Plan%s completed' IN v_def) > 0 THEN
    EXECUTE replace(v_def, 'of %s Rent Plan%s completed', 'of %s plan%s completed');
  END IF;
END
$rb$;
REVOKE ALL ON FUNCTION public._tenant_payment_score_core(uuid[], date) FROM PUBLIC, anon, authenticated, service_role;
