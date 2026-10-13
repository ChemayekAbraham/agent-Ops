-- Tenant Ops: tenant classification (Active / Waiting for landlord payment / Dormant / Inactive + "Needs review").
--
-- Read-only. New functions only; nothing existing is edited (no existing function, view, table, trigger,
-- policy or ledger object). Plan starts are never recomputed here: the Active / Waiting split comes from the
-- shared payout clock (_am_plan_clock_core, the same logic as am_plan_clock).
--
-- Population: users with the enabled 'tenant' role whose profile is not deleted.
-- One category per tenant, first match wins:
--   1 active   : a live Rent Plan (funded / disbursed / repaying) whose clock bucket is counting or
--                outstanding_balance and that still owes money (total_repayment - amount_repaid > 0)
--   2 waiting  : a live Rent Plan whose clock bucket is tenant_paying_no_landlord or awaiting_landlord
--   3 dormant  : none of the above, and at least one Rent Plan that is completed or fully repaid
--                (total_repayment > 0 and amount_repaid >= total_repayment). completed_on is the Kampala date of
--                the plan's last payment (there is no completion timestamp on rent_requests), falling back to the
--                date it was last updated. sub-label renewal_in_progress: a later request is in an open pipeline
--                status (anything not funded / disbursed / repaying / completed / rejected / cancelled / deleted_by_agent)
--   4 inactive : everything else (never had a funded / repaying / completed Rent Plan). sub-label:
--                never_requested | request_in_review | only_rejected_cancelled | other
-- "Needs review" is a flag on top of the category: a plan marked funded / repaying that is fully repaid, a plan
-- marked completed that still owes, a running plan with no repayment amount (total_repayment = 0; such a tenant
-- sits in Inactive / other because no amount was ever due), or more than one running Rent Plan.
--
-- Access: _am_staff_ok(), the staff check Agent Monitoring uses (a superset of the roles that can open the Top-Up
-- Eligibility peer function, and it includes tenant_ops).

-- 1. The classification, one row per tenant (internal) ---------------------------------------------------
CREATE OR REPLACE FUNCTION public._tops_tenant_classification_core()
RETURNS TABLE (
  tenant_id             uuid,
  tenant_name           text,
  tenant_phone          text,
  district              text,
  category              text,
  sub_label             text,
  needs_review          boolean,
  review_reasons        text,
  total_requests        integer,
  running_plans         integer,
  completed_plans       integer,
  outstanding_ugx       numeric,
  completed_on          date,
  days_since_completion integer,
  latest_status         text,
  latest_request_at     timestamptz,
  latest_agent_name     text,
  as_of                 date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH today AS (
    SELECT (now() AT TIME ZONE 'Africa/Kampala')::date AS d
  ),
  pop AS (
    SELECT p.id AS tenant_id, p.full_name, p.phone, p.district
      FROM public.profiles p
     WHERE p.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM public.user_roles ur
                    WHERE ur.user_id = p.id AND ur.role::text = 'tenant' AND ur.enabled)
  ),
  rr AS (
    SELECT r.id, r.tenant_id, r.status, r.created_at, r.updated_at, r.agent_id,
           COALESCE(r.total_repayment, 0) AS total, COALESCE(r.amount_repaid, 0) AS repaid
      FROM public.rent_requests r
     WHERE r.tenant_id IN (SELECT tenant_id FROM pop)
  ),
  clk AS (
    SELECT c.rent_request_id, c.bucket
      FROM public._am_plan_clock_core(ARRAY(
             SELECT id FROM rr WHERE status IN ('funded', 'disbursed', 'repaying'))) c
  ),
  plan AS (
    SELECT rr.*,
           c.bucket,
           (rr.status IN ('funded', 'disbursed', 'repaying'))                         AS is_running,
           (rr.status IN ('funded', 'disbursed', 'repaying') AND c.bucket IN ('counting', 'outstanding_balance')
              AND rr.total - rr.repaid > 0)                                           AS is_active_plan,
           (rr.status IN ('funded', 'disbursed', 'repaying')
              AND c.bucket IN ('tenant_paying_no_landlord', 'awaiting_landlord'))      AS is_waiting_plan,
           (rr.status = 'completed' OR (rr.total > 0 AND rr.repaid >= rr.total))      AS is_done_plan,
           (rr.status NOT IN ('funded', 'disbursed', 'repaying', 'completed', 'rejected', 'cancelled', 'deleted_by_agent')) AS is_open_request,
           (rr.status IN ('rejected', 'cancelled', 'deleted_by_agent'))               AS is_closed_request
      FROM rr
      LEFT JOIN clk c ON c.rent_request_id = rr.id
  ),
  last_pay AS (
    SELECT x.rid, max(x.d) AS d
      FROM (
        SELECT ac.rent_request_id AS rid, (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS d
          FROM public.agent_collections ac
         WHERE ac.reversed_at IS NULL
           AND ac.rent_request_id IN (SELECT id FROM plan WHERE is_done_plan)
        UNION ALL
        SELECT rp.rent_request_id, (rp.created_at AT TIME ZONE 'Africa/Kampala')::date
          FROM public.repayments rp
         WHERE rp.rent_request_id IN (SELECT id FROM plan WHERE is_done_plan)
      ) x
     GROUP BY x.rid
  ),
  done AS (
    SELECT p.tenant_id, p.id, p.created_at,
           COALESCE(lp.d, (p.updated_at AT TIME ZONE 'Africa/Kampala')::date) AS done_on
      FROM plan p
      LEFT JOIN last_pay lp ON lp.rid = p.id
     WHERE p.is_done_plan
  ),
  done_agg AS (
    SELECT d.tenant_id,
           max(d.done_on)    AS completed_on,
           max(d.created_at) AS latest_done_created
      FROM done d
     GROUP BY d.tenant_id
  ),
  agg AS (
    SELECT p.tenant_id,
           count(*)::int                                                         AS total_requests,
           count(*) FILTER (WHERE p.is_running)::int                             AS running_plans,
           count(*) FILTER (WHERE p.is_done_plan)::int                           AS completed_plans,
           count(*) FILTER (WHERE p.is_active_plan)::int                         AS n_active,
           count(*) FILTER (WHERE p.is_waiting_plan)::int                        AS n_waiting,
           count(*) FILTER (WHERE p.is_open_request)::int                        AS n_open,
           count(*) FILTER (WHERE p.is_closed_request)::int                      AS n_closed,
           COALESCE(sum(GREATEST(p.total - p.repaid, 0)) FILTER (WHERE p.is_running), 0) AS outstanding,
           bool_or(p.is_running AND p.status IN ('funded', 'repaying') AND p.total > 0 AND p.repaid >= p.total) AS review_running_repaid,
           bool_or(p.status = 'completed' AND p.total > 0 AND p.repaid < p.total) AS review_completed_owing,
           bool_or(p.is_running AND p.total = 0)                                 AS review_running_no_amount
      FROM plan p
     GROUP BY p.tenant_id
  ),
  latest AS (
    SELECT DISTINCT ON (r.tenant_id) r.tenant_id, r.status, r.created_at, r.agent_id
      FROM rr r
     ORDER BY r.tenant_id, r.created_at DESC
  ),
  renewal AS (
    SELECT DISTINCT p.tenant_id
      FROM plan p
      JOIN done_agg da ON da.tenant_id = p.tenant_id
     WHERE p.is_open_request AND p.created_at > da.latest_done_created
  )
  SELECT po.tenant_id,
         po.full_name,
         po.phone,
         po.district,
         k.category,
         CASE k.category
           WHEN 'dormant'  THEN CASE WHEN rn.tenant_id IS NOT NULL THEN 'renewal_in_progress' END
           WHEN 'inactive' THEN CASE
                                  WHEN COALESCE(a.total_requests, 0) = 0 THEN 'never_requested'
                                  WHEN COALESCE(a.n_open, 0) > 0         THEN 'request_in_review'
                                  WHEN a.n_closed = a.total_requests     THEN 'only_rejected_cancelled'
                                  ELSE 'other' END
         END,
         (COALESCE(a.review_running_repaid, false) OR COALESCE(a.review_completed_owing, false)
            OR COALESCE(a.review_running_no_amount, false) OR COALESCE(a.running_plans, 0) > 1),
         NULLIF(concat_ws('; ',
           CASE WHEN COALESCE(a.review_running_repaid, false) THEN 'Rent Plan marked running but fully repaid' END,
           CASE WHEN COALESCE(a.review_completed_owing, false) THEN 'Rent Plan marked completed but still owing' END,
           CASE WHEN COALESCE(a.review_running_no_amount, false) THEN 'Running Rent Plan with no repayment amount' END,
           CASE WHEN COALESCE(a.running_plans, 0) > 1 THEN 'More than one running Rent Plan' END), ''),
         COALESCE(a.total_requests, 0),
         COALESCE(a.running_plans, 0),
         COALESCE(a.completed_plans, 0),
         COALESCE(a.outstanding, 0),
         CASE WHEN k.category = 'dormant' THEN da.completed_on END,
         CASE WHEN k.category = 'dormant' THEN GREATEST(0, t.d - da.completed_on) END,
         l.status,
         l.created_at,
         ap.full_name,
         t.d
    FROM pop po
    CROSS JOIN today t
    LEFT JOIN agg a ON a.tenant_id = po.tenant_id
    LEFT JOIN done_agg da ON da.tenant_id = po.tenant_id
    LEFT JOIN renewal rn ON rn.tenant_id = po.tenant_id
    LEFT JOIN latest l ON l.tenant_id = po.tenant_id
    LEFT JOIN public.profiles ap ON ap.id = l.agent_id
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN COALESCE(a.n_active, 0)    > 0 THEN 'active'
               WHEN COALESCE(a.n_waiting, 0)   > 0 THEN 'waiting'
               WHEN COALESCE(a.completed_plans, 0) > 0 THEN 'dormant'
               ELSE 'inactive' END AS category
    ) k;
$function$;

-- 2. Summary cards ----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_tenant_classification_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public._am_staff_ok() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  WITH c AS (SELECT * FROM public._tops_tenant_classification_core())
  SELECT jsonb_build_object(
    'as_of', (SELECT max(as_of) FROM c),
    'population', (SELECT count(*) FROM c),
    'active', (SELECT count(*) FROM c WHERE category = 'active'),
    'waiting', (SELECT count(*) FROM c WHERE category = 'waiting'),
    'dormant', (SELECT count(*) FROM c WHERE category = 'dormant'),
    'dormant_renewal_in_progress', (SELECT count(*) FROM c WHERE category = 'dormant' AND sub_label = 'renewal_in_progress'),
    'inactive', (SELECT count(*) FROM c WHERE category = 'inactive'),
    'inactive_never_requested', (SELECT count(*) FROM c WHERE category = 'inactive' AND sub_label = 'never_requested'),
    'inactive_request_in_review', (SELECT count(*) FROM c WHERE category = 'inactive' AND sub_label = 'request_in_review'),
    'inactive_only_rejected_cancelled', (SELECT count(*) FROM c WHERE category = 'inactive' AND sub_label = 'only_rejected_cancelled'),
    'inactive_other', (SELECT count(*) FROM c WHERE category = 'inactive' AND sub_label = 'other'),
    'needs_review', (SELECT count(*) FROM c WHERE needs_review)
  ) INTO v_out;

  RETURN v_out;
END;
$function$;

-- 3. The paged list ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_tenant_classification_list(
  p_category     text    DEFAULT NULL,
  p_sub          text    DEFAULT NULL,
  p_search       text    DEFAULT NULL,
  p_limit        integer DEFAULT 50,
  p_offset       integer DEFAULT 0,
  p_needs_review boolean DEFAULT false
)
RETURNS TABLE (
  tenant_id             uuid,
  tenant_name           text,
  tenant_phone          text,
  district              text,
  category              text,
  sub_label             text,
  needs_review          boolean,
  review_reasons        text,
  total_requests        integer,
  running_plans         integer,
  completed_plans       integer,
  outstanding_ugx       numeric,
  completed_on          date,
  days_since_completion integer,
  latest_status         text,
  latest_request_at     timestamptz,
  latest_agent_name     text,
  total_rows            bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
#variable_conflict use_column
DECLARE
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 1000);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_digits text;
BEGIN
  IF auth.uid() IS NULL OR NOT public._am_staff_ok() THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_category IS NOT NULL AND p_category NOT IN ('active', 'waiting', 'dormant', 'inactive') THEN
    RAISE EXCEPTION 'unknown category %', p_category USING ERRCODE = '22023';
  END IF;
  v_digits := regexp_replace(COALESCE(v_search, ''), '\D', '', 'g');

  RETURN QUERY
  SELECT c.tenant_id, c.tenant_name, c.tenant_phone, c.district, c.category, c.sub_label, c.needs_review,
         c.review_reasons, c.total_requests, c.running_plans, c.completed_plans, c.outstanding_ugx,
         c.completed_on, c.days_since_completion, c.latest_status, c.latest_request_at, c.latest_agent_name,
         count(*) OVER ()
    FROM public._tops_tenant_classification_core() c
   WHERE (p_category IS NULL OR c.category = p_category)
     AND (p_sub IS NULL OR c.sub_label = p_sub)
     AND (NOT COALESCE(p_needs_review, false) OR c.needs_review)
     AND (v_search IS NULL
          OR c.tenant_name ILIKE '%' || v_search || '%'
          OR (v_digits <> '' AND regexp_replace(COALESCE(c.tenant_phone, ''), '\D', '', 'g') LIKE '%' || v_digits || '%'))
   ORDER BY
     CASE WHEN c.category = 'dormant' THEN c.days_since_completion END ASC NULLS LAST,
     c.latest_request_at DESC NULLS LAST,
     c.tenant_id
   LIMIT v_limit OFFSET v_offset;
END;
$function$;

-- 4. Grants: internal helper not callable from the API; the two public functions as the Top-Up peer
REVOKE ALL ON FUNCTION public._tops_tenant_classification_core() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.tops_tenant_classification_summary() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tops_tenant_classification_list(text, text, text, integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_tenant_classification_summary() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tops_tenant_classification_list(text, text, text, integer, integer, boolean) TO authenticated, service_role;
