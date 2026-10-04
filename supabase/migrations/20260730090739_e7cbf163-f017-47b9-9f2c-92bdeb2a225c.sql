CREATE OR REPLACE FUNCTION public.get_agent_tenants_overview(p_today_start timestamp with time zone DEFAULT date_trunc('day'::text, now()))
 RETURNS TABLE(id uuid, full_name text, phone text, email text, created_at timestamp with time zone, monthly_rent numeric, verified boolean, balance numeric, daily numeric, total_repayment numeric, amount_repaid numeric, statuses text[], landlord_name text, property_address text, latitude numeric, longitude numeric, completed_count integer, request_count integer, last_paid_at timestamp with time zone, last_paid_amount numeric, today_paid_amount numeric, today_paid_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH actor AS (
    SELECT auth.uid() AS uid
  ),
  linked_ids AS (
    SELECT p.id
    FROM public.profiles p, actor a
    WHERE a.uid IS NOT NULL AND p.referrer_id = a.uid

    UNION

    SELECT r.referred_id AS id
    FROM public.referrals r, actor a
    WHERE a.uid IS NOT NULL AND r.referrer_id = a.uid AND r.referred_id IS NOT NULL

    UNION

    SELECT rr.tenant_id AS id
    FROM public.rent_requests rr, actor a
    WHERE a.uid IS NOT NULL
      AND rr.tenant_id IS NOT NULL
      AND (rr.agent_id = a.uid OR rr.assigned_agent_id = a.uid)

    UNION

    SELECT p.id
    FROM public.profiles p, actor a
    WHERE a.uid IS NOT NULL AND p.managed_by_agent = true AND p.managing_agent_id = a.uid
  ),
  sub_agents AS (
    SELECT sa.sub_agent_id AS id
    FROM public.agent_subagents sa, actor a
    WHERE a.uid IS NOT NULL AND sa.parent_agent_id = a.uid AND sa.sub_agent_id IS NOT NULL
  ),
  tenants AS (
    SELECT DISTINCT p.id, p.full_name, p.phone, p.email, p.created_at, p.monthly_rent, p.verified
    FROM public.profiles p
    JOIN linked_ids li ON li.id = p.id
    WHERE (
      NOT EXISTS (SELECT 1 FROM sub_agents sa WHERE sa.id = p.id)
      OR EXISTS (
           SELECT 1 FROM public.rent_requests rr, actor a
           WHERE rr.tenant_id = p.id
             AND (rr.agent_id = a.uid OR rr.assigned_agent_id = a.uid)
         )
    )
    AND (
      EXISTS (
        SELECT 1 FROM public.rent_requests rr, actor a
        WHERE rr.tenant_id = p.id
          AND (rr.agent_id = a.uid OR rr.assigned_agent_id = a.uid)
      )
      OR EXISTS (
        SELECT 1 FROM actor a
        WHERE p.managed_by_agent = true AND p.managing_agent_id = a.uid
      )
      OR NOT EXISTS (
        SELECT 1 FROM public.rent_requests rr, actor a
        WHERE rr.tenant_id = p.id
          AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL
          AND COALESCE(rr.assigned_agent_id, rr.agent_id) <> a.uid
          AND COALESCE(rr.agent_id, rr.assigned_agent_id) <> a.uid
      )
    )
  ),
  request_base AS (
    SELECT
      rr.tenant_id,
      rr.status,
      rr.created_at,
      rr.registration_type,
      rr.amount_repaid,
      rr.duration_days,
      l.name AS landlord_name,
      l.property_address,
      l.latitude,
      l.longitude,
      CASE
        WHEN rr.registration_type = 'outstanding_balance' THEN
          COALESCE(NULLIF(rr.initial_outstanding_balance, 0), rr.total_repayment, 0)
        ELSE COALESCE(rr.total_repayment, 0)
      END AS effective_total,
      CASE
        WHEN rr.registration_type = 'outstanding_balance' THEN
          CASE
            WHEN COALESCE(NULLIF(rr.initial_outstanding_balance, 0), rr.total_repayment, 0) > 0 THEN
              CEIL(COALESCE(NULLIF(rr.initial_outstanding_balance, 0), rr.total_repayment, 0) / GREATEST(COALESCE(rr.duration_days, 30), 1))
            ELSE COALESCE(rr.daily_repayment, 0)
          END
        ELSE COALESCE(rr.daily_repayment, 0)
      END AS effective_daily
    FROM public.rent_requests rr
    JOIN tenants t ON t.id = rr.tenant_id
    CROSS JOIN actor a
    LEFT JOIN public.landlords l ON l.id = rr.landlord_id
    WHERE (
      rr.agent_id = a.uid
      OR rr.assigned_agent_id = a.uid
      OR (rr.agent_id IS NULL AND rr.assigned_agent_id IS NULL)
    ) AND (rr.status IN ('pending', 'approved', 'funded', 'disbursed', 'repaying', 'completed')
       OR rr.registration_type = 'outstanding_balance')
  ),
  request_agg AS (
    SELECT
      rb.tenant_id,
      COALESCE(SUM(
        CASE
          WHEN rb.status IN ('funded', 'disbursed', 'repaying') OR rb.registration_type = 'outstanding_balance'
          THEN GREATEST(0, rb.effective_total - COALESCE(rb.amount_repaid, 0))
          ELSE 0
        END
      ), 0) AS balance,
      COALESCE(SUM(
        CASE
          WHEN GREATEST(0, rb.effective_total - COALESCE(rb.amount_repaid, 0)) > 0
           AND rb.status IN ('approved', 'funded', 'disbursed', 'repaying')
          THEN rb.effective_daily
          ELSE 0
        END
      ), 0) AS daily,
      COALESCE(SUM(
        CASE
          WHEN rb.status IN ('funded', 'disbursed', 'repaying') OR rb.registration_type = 'outstanding_balance'
          THEN rb.effective_total
          ELSE 0
        END
      ), 0) AS total_repayment,
      COALESCE(SUM(
        CASE
          WHEN rb.status IN ('funded', 'disbursed', 'repaying') OR rb.registration_type = 'outstanding_balance'
          THEN COALESCE(rb.amount_repaid, 0)
          ELSE 0
        END
      ), 0) AS amount_repaid,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT rb.status), NULL) AS statuses,
      COUNT(*)::integer AS request_count,
      COUNT(*) FILTER (
        WHERE rb.status = 'completed'
          AND rb.effective_total > 0
          AND COALESCE(rb.amount_repaid, 0) >= rb.effective_total
      )::integer AS completed_count
    FROM request_base rb
    GROUP BY rb.tenant_id
  ),
  latest_context AS (
    SELECT DISTINCT ON (rb.tenant_id)
      rb.tenant_id,
      rb.landlord_name,
      rb.property_address,
      rb.latitude,
      rb.longitude
    FROM request_base rb
    ORDER BY rb.tenant_id, rb.created_at DESC
  ),
  last_repayment AS (
    SELECT DISTINCT ON (r.tenant_id)
      r.tenant_id,
      r.created_at AS last_paid_at,
      COALESCE(r.amount, 0) AS last_paid_amount
    FROM public.repayments r
    JOIN tenants t ON t.id = r.tenant_id
    ORDER BY r.tenant_id, r.created_at DESC
  ),
  today_repayments AS (
    SELECT
      r.tenant_id,
      COALESCE(SUM(r.amount), 0) AS today_paid_amount,
      COUNT(*)::integer AS today_paid_count
    FROM public.repayments r
    JOIN tenants t ON t.id = r.tenant_id
    WHERE r.created_at >= p_today_start
    GROUP BY r.tenant_id
  )
  SELECT
    t.id,
    t.full_name,
    t.phone,
    t.email,
    t.created_at,
    t.monthly_rent,
    t.verified,
    COALESCE(ra.balance, 0) AS balance,
    COALESCE(ra.daily, 0) AS daily,
    COALESCE(ra.total_repayment, 0) AS total_repayment,
    COALESCE(ra.amount_repaid, 0) AS amount_repaid,
    COALESCE(ra.statuses, ARRAY[]::text[]) AS statuses,
    lc.landlord_name,
    lc.property_address,
    lc.latitude,
    lc.longitude,
    COALESCE(ra.completed_count, 0) AS completed_count,
    COALESCE(ra.request_count, 0) AS request_count,
    lr.last_paid_at,
    COALESCE(lr.last_paid_amount, 0) AS last_paid_amount,
    COALESCE(tr.today_paid_amount, 0) AS today_paid_amount,
    COALESCE(tr.today_paid_count, 0) AS today_paid_count
  FROM tenants t
  LEFT JOIN request_agg ra ON ra.tenant_id = t.id
  LEFT JOIN latest_context lc ON lc.tenant_id = t.id
  LEFT JOIN last_repayment lr ON lr.tenant_id = t.id
  LEFT JOIN today_repayments tr ON tr.tenant_id = t.id
  ORDER BY COALESCE(ra.balance, 0) DESC, t.full_name ASC;
$function$;