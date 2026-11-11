-- Recreate public.ops_tenant_inbox(text, integer, timestamp with time zone)
-- from the live pg_get_functiondef (md5 264ca1ceaa2c1907a06b35c508e7660d).
-- The only change qualifies four bare tenant_id references in the RETURN QUERY
-- (agent_visits.tenant_id three times, and active.tenant_id in the active-plan
-- filter). Those names clash with the RETURNS TABLE output column, which
-- Postgres logged as 42702 (column reference "tenant_id" is ambiguous) eight
-- times between 10:30 and 10:39 Africa/Kampala on 11 Nov 2026.
-- Signature, argument defaults, return shape, filters, and search_path are unchanged.
-- Expected pg_get_functiondef md5 after this migration: 104959dddd1f31cc4c612905415f8b88
-- EXECUTE stays with authenticated, postgres, and service_role. anon is not granted.

CREATE OR REPLACE FUNCTION public.ops_tenant_inbox(p_bucket text, p_limit integer DEFAULT 50, p_cursor timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(tenant_id uuid, full_name text, phone text, city text, severity text, reason text, days_no_progress integer, outstanding_ugx numeric, trust_score integer, trust_tier text, last_visit_at timestamp with time zone, snoozed_until timestamp with time zone, rank_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  WITH active AS (
    SELECT
      rr.tenant_id,
      MAX(GREATEST(rr.updated_at, COALESCE(rr.disbursed_at, rr.created_at))) AS last_progress,
      SUM(GREATEST(rr.total_repayment - COALESCE(rr.amount_repaid,0), 0))     AS outstanding
    FROM public.rent_requests rr
    WHERE rr.status IN ('active','disbursed','funded','overdue')
      AND COALESCE(rr.amount_repaid,0) < COALESCE(rr.total_repayment,0)
    GROUP BY rr.tenant_id
  ),
  visits AS (
    SELECT agent_visits.tenant_id, MAX(checked_in_at) AS last_visit_at
    FROM public.agent_visits
    WHERE agent_visits.tenant_id IS NOT NULL
    GROUP BY agent_visits.tenant_id
  ),
  base AS (
    SELECT
      p.id            AS tenant_id,
      p.full_name,
      p.phone,
      p.city,
      a.last_progress,
      a.outstanding,
      v.last_visit_at,
      EXTRACT(DAY FROM (now() - COALESCE(a.last_progress, p.created_at)))::int AS days_no_progress,
      ts.score        AS trust_score,
      ts.tier         AS trust_tier,
      st.snoozed_until
    FROM public.profiles p
    LEFT JOIN active a              ON a.tenant_id = p.id
    LEFT JOIN visits v              ON v.tenant_id = p.id
    LEFT JOIN public.welile_trust_score_cache ts ON ts.user_id = p.id
    LEFT JOIN public.ops_inbox_state st
           ON st.tenant_id = p.id AND st.ops_user_id = v_uid
    WHERE p.id IN (SELECT active.tenant_id FROM active)
       OR (p.created_at > now() - interval '7 days' AND COALESCE(p.verified,false) = false)
  ),
  classified AS (
    SELECT
      b.*,
      CASE
        WHEN b.snoozed_until IS NOT NULL AND b.snoozed_until > now() THEN 'snoozed'
        WHEN b.outstanding > 0 AND b.days_no_progress >= 7 THEN 'critical'
        WHEN b.outstanding > 0 AND b.days_no_progress >= 3 THEN 'at_risk'
        WHEN COALESCE(b.trust_score, 500) < 400 THEN 'watch'
        WHEN b.outstanding IS NULL THEN 'new'
        ELSE 'watch'
      END AS severity
    FROM base b
  )
  SELECT
    c.tenant_id,
    c.full_name,
    c.phone,
    c.city,
    c.severity,
    CASE c.severity
      WHEN 'critical' THEN format('%s days no payment · UGX %s outstanding%s',
                                  c.days_no_progress, to_char(c.outstanding,'FM999,999,999'),
                                  CASE WHEN c.last_visit_at IS NULL OR c.last_visit_at < now() - interval '7 days'
                                       THEN ' · no agent visit in 7d' ELSE '' END)
      WHEN 'at_risk'  THEN format('%s days no payment · UGX %s outstanding',
                                  c.days_no_progress, to_char(c.outstanding,'FM999,999,999'))
      WHEN 'watch'    THEN format('Trust score %s — needs attention', COALESCE(c.trust_score,0))
      WHEN 'new'      THEN 'New tenant, not yet verified'
      WHEN 'snoozed'  THEN format('Snoozed until %s', to_char(c.snoozed_until,'Mon DD HH24:MI'))
    END AS reason,
    c.days_no_progress,
    COALESCE(c.outstanding,0) AS outstanding_ugx,
    COALESCE(c.trust_score,0)::int AS trust_score,
    c.trust_tier,
    c.last_visit_at,
    c.snoozed_until,
    COALESCE(c.last_progress, c.snoozed_until, now()) AS rank_at
  FROM classified c
  WHERE c.severity = p_bucket
    AND (p_cursor IS NULL OR COALESCE(c.last_progress, c.snoozed_until, now()) < p_cursor)
  ORDER BY
    CASE c.severity WHEN 'critical' THEN c.outstanding ELSE 0 END DESC NULLS LAST,
    c.days_no_progress DESC NULLS LAST,
    c.tenant_id
  LIMIT GREATEST(1, LEAST(p_limit, 200));
END;
$function$;

REVOKE ALL ON FUNCTION public.ops_tenant_inbox(text, integer, timestamp with time zone) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_tenant_inbox(text, integer, timestamp with time zone)
  TO authenticated, postgres, service_role;
