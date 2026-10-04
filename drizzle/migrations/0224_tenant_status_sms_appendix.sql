CREATE TABLE IF NOT EXISTS public.tenant_status_appendices (
  status_code text PRIMARY KEY,
  label text NOT NULL,
  body_template text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT tenant_status_appendices_status_code_ck CHECK (status_code IN ('in_cycle_good', 'plan_completed', 'outside_cycle')),
  CONSTRAINT tenant_status_appendices_body_template_ck CHECK (length(trim(body_template)) >= 20)
);

GRANT SELECT ON public.tenant_status_appendices TO authenticated;
GRANT ALL ON public.tenant_status_appendices TO service_role;

ALTER TABLE public.tenant_status_appendices ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant_status_appendices'
      AND policyname = 'tenant_status_appendices_read_active_or_ops'
  ) THEN
    CREATE POLICY tenant_status_appendices_read_active_or_ops
      ON public.tenant_status_appendices
      FOR SELECT
      TO authenticated
      USING (active OR public.is_ops_role(auth.uid()));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.touch_tenant_status_appendices_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_tenant_status_appendices_updated_at ON public.tenant_status_appendices;
CREATE TRIGGER trg_touch_tenant_status_appendices_updated_at
  BEFORE UPDATE ON public.tenant_status_appendices
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_tenant_status_appendices_updated_at();

CREATE OR REPLACE FUNCTION public.get_tenant_status_appendices(
  p_tenant_ids uuid[],
  p_domain_name text DEFAULT 'welileapp.com'
)
RETURNS TABLE(
  tenant_id uuid,
  status_code text,
  status_appendix text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH input_tenants AS (
  SELECT DISTINCT id AS tenant_id
  FROM unnest(COALESCE(p_tenant_ids, ARRAY[]::uuid[])) AS id
  WHERE id IS NOT NULL
), today AS (
  SELECT (now() AT TIME ZONE 'Africa/Kampala')::date AS d
), domain_value AS (
  SELECT regexp_replace(
           regexp_replace(COALESCE(NULLIF(trim(p_domain_name), ''), 'welileapp.com'), '^https?://', ''),
           '/+$',
           ''
         ) AS domain_name
), payments AS (
  SELECT x.rent_request_id,
         max((x.created_at AT TIME ZONE 'Africa/Kampala')::date) AS last_pay_date
  FROM (
    SELECT ac.rent_request_id, ac.created_at
    FROM public.agent_collections ac
    WHERE ac.rent_request_id IS NOT NULL
      AND ac.reversed_at IS NULL
    UNION ALL
    SELECT rp.rent_request_id, rp.created_at
    FROM public.repayments rp
    WHERE rp.rent_request_id IS NOT NULL
  ) x
  GROUP BY x.rent_request_id
), live_candidates AS (
  SELECT rr.tenant_id,
         rr.id AS rent_request_id,
         rr.agent_id,
         sched.term_end,
         pay.last_pay_date,
         CASE
           WHEN COALESCE(rr.repayment_frequency, '') = 'weekly' THEN true
           WHEN COALESCE(rr.repayment_frequency, '') = 'daily' THEN false
           ELSE public.rent_request_is_weekly_shape(rr.duration_days, rr.registration_type)
         END AS is_weekly
  FROM input_tenants it
  JOIN public.v_tenant_daily_eligibility v ON v.tenant_id = it.tenant_id
  JOIN public.rent_requests rr ON rr.id = v.rent_request_id
  JOIN public.v_rent_plan_schedule sched ON sched.rent_request_id = rr.id
  LEFT JOIN payments pay ON pay.rent_request_id = rr.id
  WHERE (COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0)) > 0
), live_classified AS (
  SELECT lc.tenant_id,
         lc.agent_id,
         CASE
           WHEN lc.term_end < t.d THEN 'outside_cycle'
           WHEN lc.term_end >= t.d THEN 'in_cycle_good'
           ELSE NULL
         END AS status_code,
         CASE
           WHEN lc.term_end < t.d THEN 1
           ELSE 2
         END AS priority,
         lc.term_end,
         lc.last_pay_date
  FROM live_candidates lc
  CROSS JOIN today t
  WHERE lc.last_pay_date IS NOT NULL
    AND (t.d - lc.last_pay_date) <= CASE WHEN lc.is_weekly THEN 14 ELSE 7 END
), ranked_live AS (
  SELECT DISTINCT ON (tenant_id)
         tenant_id,
         agent_id,
         status_code,
         priority,
         term_end,
         last_pay_date
  FROM live_classified
  WHERE status_code IS NOT NULL
  ORDER BY tenant_id, priority, term_end DESC, last_pay_date DESC
), completed_collection AS (
  SELECT ac.rent_request_id,
         COALESCE(sum(ac.amount), 0) AS collected
  FROM public.agent_collections ac
  WHERE ac.rent_request_id IS NOT NULL
    AND ac.reversed_at IS NULL
  GROUP BY ac.rent_request_id
), completed_candidates AS (
  SELECT DISTINCT ON (rr.tenant_id)
         rr.tenant_id,
         rr.agent_id,
         'plan_completed'::text AS status_code,
         3 AS priority,
         rr.updated_at
  FROM input_tenants it
  JOIN public.rent_requests rr ON rr.tenant_id = it.tenant_id
  LEFT JOIN completed_collection cc ON cc.rent_request_id = rr.id
  WHERE rr.status = 'completed'
    AND rr.funded_at IS NOT NULL
    AND (COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0)) <= 0
    AND COALESCE(cc.collected, 0) >= (COALESCE(rr.total_repayment, 0) * 0.95)
    AND EXISTS (
      SELECT 1
      FROM public.agent_landlord_float_allocations a
      WHERE a.rent_request_id = rr.id
        AND COALESCE(a.paid_out_amount, 0) > 0
      UNION ALL
      SELECT 1
      FROM public.landlord_payouts lp
      WHERE lp.rent_request_id = rr.id
        AND (lp.disbursed_at IS NOT NULL OR lp.finops_disbursed_at IS NOT NULL)
      LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.rent_requests live_rr
      WHERE live_rr.tenant_id = rr.tenant_id
        AND live_rr.status IN ('funded', 'repaying')
        AND COALESCE(live_rr.agent_payment_status, 'paying') <> 'not_paying'
        AND COALESCE(live_rr.tenancy_status, 'active') = 'active'
        AND live_rr.tenancy_ended_at IS NULL
        AND (COALESCE(live_rr.total_repayment, 0) - COALESCE(live_rr.amount_repaid, 0)) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM public.rent_repayment_pauses pz
          WHERE pz.rent_request_id = live_rr.id
            AND pz.status = 'active'
            AND pz.resumed_at IS NULL
        )
    )
  ORDER BY rr.tenant_id, rr.updated_at DESC NULLS LAST, rr.created_at DESC
), status_choice AS (
  SELECT tenant_id, agent_id, status_code, priority
  FROM ranked_live
  UNION ALL
  SELECT tenant_id, agent_id, status_code, priority
  FROM completed_candidates
), picked AS (
  SELECT DISTINCT ON (tenant_id)
         tenant_id,
         agent_id,
         status_code
  FROM status_choice
  ORDER BY tenant_id, priority
), agent_links AS (
  SELECT DISTINCT ON (l.agent_id)
         l.agent_id,
         l.short_code
  FROM public.recruitment_campaign_links l
  JOIN public.recruitment_campaigns c ON c.id = l.campaign_id
  WHERE l.status = 'active'
    AND c.status = 'active'
    AND l.short_code IS NOT NULL
    AND (l.expires_at IS NULL OR l.expires_at > now())
  ORDER BY l.agent_id,
           CASE WHEN l.link_type = 'general_campaign_link' THEN 0 ELSE 1 END,
           l.created_at DESC
), fallback_link AS (
  SELECT l.short_code
  FROM public.recruitment_campaign_links l
  JOIN public.recruitment_campaigns c ON c.id = l.campaign_id
  WHERE l.status = 'active'
    AND c.status = 'active'
    AND l.short_code IS NOT NULL
    AND (l.expires_at IS NULL OR l.expires_at > now())
  ORDER BY CASE WHEN l.link_type = 'general_campaign_link' THEN 0 ELSE 1 END,
           l.created_at DESC
  LIMIT 1
), rendered AS (
  SELECT p.tenant_id,
         p.status_code,
         replace(
           replace(
             t.body_template,
             '{{tenant_name}}',
             COALESCE(NULLIF(split_part(trim(COALESCE(pr.full_name, '')), ' ', 1), ''), 'there')
           ),
           '{{join_link}}',
           CASE
             WHEN p.status_code = 'outside_cycle' AND COALESCE(al.short_code, fl.short_code) IS NOT NULL
               THEN dv.domain_name || '/join/' || COALESCE(al.short_code, fl.short_code)
             WHEN p.status_code = 'outside_cycle'
               THEN dv.domain_name || '/join'
             ELSE ''
           END
         ) AS status_appendix
  FROM picked p
  JOIN public.tenant_status_appendices t ON t.status_code = p.status_code AND t.active
  LEFT JOIN public.profiles pr ON pr.id = p.tenant_id
  LEFT JOIN agent_links al ON al.agent_id = p.agent_id
  LEFT JOIN fallback_link fl ON true
  CROSS JOIN domain_value dv
)
SELECT rendered.tenant_id, rendered.status_code, rendered.status_appendix
FROM rendered
WHERE NULLIF(trim(rendered.status_appendix), '') IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.get_tenant_status_appendix(
  p_tenant_id uuid,
  p_domain_name text DEFAULT 'welileapp.com'
)
RETURNS TABLE(
  status_code text,
  status_appendix text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT g.status_code, g.status_appendix
  FROM public.get_tenant_status_appendices(ARRAY[p_tenant_id], p_domain_name) g
  WHERE g.tenant_id = p_tenant_id
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_status_appendices(uuid[], text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_tenant_status_appendix(uuid, text) TO authenticated, service_role;