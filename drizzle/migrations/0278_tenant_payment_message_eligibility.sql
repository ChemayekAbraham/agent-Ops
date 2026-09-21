-- Customer-care numbers published in tenant messages. Configuration, not code,
-- so the care line can change without a release.
CREATE TABLE IF NOT EXISTS public.tenant_support_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  phone text NOT NULL,
  sort_order integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

GRANT SELECT ON public.tenant_support_contacts TO authenticated;
GRANT ALL ON public.tenant_support_contacts TO service_role;

ALTER TABLE public.tenant_support_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_support_contacts_read ON public.tenant_support_contacts;
CREATE POLICY tenant_support_contacts_read
  ON public.tenant_support_contacts FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS tenant_support_contacts_write ON public.tenant_support_contacts;
CREATE POLICY tenant_support_contacts_write
  ON public.tenant_support_contacts FOR ALL
  TO authenticated
  USING (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
  )
  WITH CHECK (
    public.is_ops_role(auth.uid())
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'cfo')
  );

INSERT INTO public.tenant_support_contacts (label, phone, sort_order)
SELECT 'Welile Customer Care', '+256777607640', 1
WHERE NOT EXISTS (SELECT 1 FROM public.tenant_support_contacts WHERE phone = '+256777607640');

INSERT INTO public.tenant_support_contacts (label, phone, sort_order)
SELECT 'Welile Support', '0748747134', 2
WHERE NOT EXISTS (SELECT 1 FROM public.tenant_support_contacts WHERE phone = '0748747134');

-- Exact-money figures for a tenant's payment confirmation message. Reads the
-- same authoritative plan/collection data and the same configurable thresholds
-- as the Top-Up Eligibility report; computes no payment state of its own.
CREATE OR REPLACE FUNCTION public.get_tenant_payment_message_vars(p_tenant_ids uuid[])
RETURNS TABLE (
  tenant_id uuid,
  rent_request_id uuid,
  rent_amount numeric,
  total_expected numeric,
  paid_to_date numeric,
  remaining numeric,
  pct_covered numeric,
  term_end date,
  days_left_in_cycle integer,
  days_after_cycle integer,
  tier_key text,
  current_access numeric,
  current_topup numeric,
  next_level_key text,
  next_level_label text,
  next_level_required numeric,
  next_level_access numeric,
  next_level_deadline date
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rules jsonb := public.tenant_topup_eligibility_rules();
  v_qual numeric := COALESCE((v_rules->>'qualifying_pct')::numeric, 90);
  v_same numeric := COALESCE((v_rules->>'same_amount_pct')::numeric, 70);
  v_d0 integer := COALESCE((v_rules->'tiers'->0->>'max_days_after_cycle')::integer, 0);
  v_d1 integer := COALESCE((v_rules->'tiers'->1->>'max_days_after_cycle')::integer, 30);
  v_d2 integer := COALESCE((v_rules->'tiers'->2->>'max_days_after_cycle')::integer, 60);
  v_i0 numeric := COALESCE((v_rules->'tiers'->0->>'increase_pct')::numeric, 100);
  v_i1 numeric := COALESCE((v_rules->'tiers'->1->>'increase_pct')::numeric, 50);
  v_i2 numeric := COALESCE((v_rules->'tiers'->2->>'increase_pct')::numeric, 25);
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  RETURN QUERY
  WITH latest AS (
    SELECT DISTINCT ON (s.tenant_id)
           s.tenant_id, s.rent_request_id, s.term_end, s.total_amount, s.amount_repaid
    FROM public.v_rent_plan_schedule s
    WHERE s.tenant_id = ANY(p_tenant_ids)
    ORDER BY s.tenant_id, s.term_start DESC, s.rent_request_id
  ),
  base AS (
    SELECT l.tenant_id,
           l.rent_request_id,
           COALESCE(rr.rent_amount, 0)::numeric AS rent_amount,
           l.total_amount::numeric AS total_expected,
           l.amount_repaid::numeric AS paid_to_date,
           GREATEST(l.total_amount - l.amount_repaid, 0)::numeric AS remaining,
           CASE WHEN l.total_amount > 0
                THEN ROUND(l.amount_repaid * 100.0 / l.total_amount, 2) ELSE 0 END AS pct_covered,
           l.term_end,
           GREATEST(l.term_end - v_today, 0)::integer AS days_left_in_cycle,
           GREATEST(v_today - l.term_end, 0)::integer AS days_after_cycle
    FROM latest l
    LEFT JOIN public.rent_requests rr ON rr.id = l.rent_request_id
  ),
  graded AS (
    SELECT b.*,
      CASE
        WHEN b.pct_covered >= v_qual AND b.days_after_cycle <= v_d0 THEN 'within_cycle'
        WHEN b.pct_covered >= v_qual AND b.days_after_cycle <= v_d1 THEN 'within_one_month'
        WHEN b.pct_covered >= v_qual AND b.days_after_cycle <= v_d2 THEN 'within_two_months'
        WHEN b.pct_covered >= v_qual THEN 'beyond_two_months'
        WHEN b.pct_covered >= v_same THEN 'same_amount_only'
        ELSE 'not_eligible'
      END AS tier_key
    FROM base b
  ),
  priced AS (
    SELECT g.*,
      CASE g.tier_key
        WHEN 'within_cycle' THEN v_i0
        WHEN 'within_one_month' THEN v_i1
        WHEN 'within_two_months' THEN v_i2
        ELSE 0
      END AS increase_pct,
      GREATEST(ROUND(g.total_expected * v_qual / 100 - g.paid_to_date), 0) AS to_qualifying,
      GREATEST(ROUND(g.total_expected * v_same / 100 - g.paid_to_date), 0) AS to_same_amount
    FROM graded g
  )
  SELECT
    p.tenant_id,
    p.rent_request_id,
    p.rent_amount,
    p.total_expected,
    p.paid_to_date,
    p.remaining,
    p.pct_covered,
    p.term_end,
    p.days_left_in_cycle,
    p.days_after_cycle,
    p.tier_key,
    CASE WHEN p.tier_key = 'not_eligible' THEN 0::numeric
         ELSE ROUND(p.rent_amount * (100 + p.increase_pct) / 100) END AS current_access,
    ROUND(p.rent_amount * p.increase_pct / 100) AS current_topup,
    nl.key AS next_level_key,
    nl.label AS next_level_label,
    nl.required AS next_level_required,
    nl.access AS next_level_access,
    nl.deadline AS next_level_deadline
  FROM priced p
  LEFT JOIN LATERAL (
    SELECT x.key, x.label, x.required, x.access, x.deadline
    FROM (
      VALUES
        ('within_cycle', 'full double', v_i0, p.term_end + v_d0, p.to_qualifying),
        ('within_one_month', 'half increase', v_i1, p.term_end + v_d1, p.to_qualifying),
        ('within_two_months', 'quarter increase', v_i2, p.term_end + v_d2, p.to_qualifying),
        ('same_amount_only', 'same amount again', 0::numeric, NULL::date, p.to_same_amount)
    ) AS t(key, label, inc, deadline, required)
    CROSS JOIN LATERAL (
      SELECT t.key, t.label, t.required,
             ROUND(p.rent_amount * (100 + t.inc) / 100) AS access,
             t.deadline
    ) x
    WHERE (t.deadline IS NULL OR v_today <= t.deadline)
      AND t.inc > CASE p.tier_key
                    WHEN 'within_cycle' THEN v_i0
                    WHEN 'within_one_month' THEN v_i1
                    WHEN 'within_two_months' THEN v_i2
                    ELSE -1 END
      AND t.required > 0
    ORDER BY t.inc DESC
    LIMIT 1
  ) nl ON true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_payment_message_vars(uuid[]) TO authenticated, service_role;