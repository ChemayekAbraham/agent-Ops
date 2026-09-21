-- Authorization guard: the payment-message figures expose a tenant's plan
-- position, so only the tenant themselves, ops/exec roles, or the service role
-- (the notice sweep) may read them.
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
  v_uid uuid := auth.uid();
BEGIN
  IF NOT (
    COALESCE(auth.role(), '') = 'service_role'
    OR (v_uid IS NOT NULL AND p_tenant_ids = ARRAY[v_uid])
    OR (v_uid IS NOT NULL AND (
         public.is_ops_role(v_uid)
         OR public.has_role(v_uid, 'manager')
         OR public.has_role(v_uid, 'super_admin')
         OR public.has_role(v_uid, 'ceo')
         OR public.has_role(v_uid, 'coo')
         OR public.has_role(v_uid, 'cfo')
         OR public.has_role(v_uid, 'cto')
       ))
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

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
    ORDER BY t.required ASC, t.inc DESC
    LIMIT 1
  ) nl ON true;
END;
$$;

-- Read-only overview for the Tenant Communications tab: the live message
-- templates, merchant codes, care numbers and recent payment-message activity.
CREATE OR REPLACE FUNCTION public.get_tenant_communications_overview(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_result jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'super_admin')
    OR public.has_role(v_uid, 'ceo')
    OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cfo')
    OR public.has_role(v_uid, 'cto')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT jsonb_build_object(
    'as_of', now(),
    'rules', public.tenant_topup_eligibility_rules(),
    'templates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'event_key', e.event_key,
               'label', e.label,
               'active', e.active,
               'message_class', e.message_class,
               'body_template', e.body_template
             ) ORDER BY e.event_key)
      FROM public.tenant_notification_events e
      WHERE e.event_key IN ('PAYMENT_FULL', 'PAYMENT_PARTIAL', 'PAYMENT_MISSED')
    ), '[]'::jsonb),
    'channels', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'provider', c.provider,
               'merchant_code', c.merchant_code,
               'merchant_name', c.merchant_name,
               'active', c.active
             ) ORDER BY c.provider)
      FROM public.payment_channels c
    ), '[]'::jsonb),
    'support_contacts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id,
               'label', s.label,
               'phone', s.phone,
               'sort_order', s.sort_order,
               'active', s.active
             ) ORDER BY s.sort_order, s.label)
      FROM public.tenant_support_contacts s
    ), '[]'::jsonb),
    'totals', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'event_key', t.event_key,
               'channel', t.channel,
               'status', t.status,
               'count', t.n
             ))
      FROM (
        SELECT l.event_key, l.channel, l.status, count(*) AS n
        FROM public.tenant_notification_log l
        WHERE l.event_key IN ('PAYMENT_FULL', 'PAYMENT_PARTIAL', 'PAYMENT_MISSED')
          AND l.created_at >= now() - interval '7 days'
        GROUP BY 1, 2, 3
      ) t
    ), '[]'::jsonb),
    'recent', COALESCE((
      SELECT jsonb_agg(r) FROM (
        SELECT l.id, l.tenant_id, p.full_name AS tenant_name, l.event_key, l.channel,
               l.status, l.skip_reason, l.provider, l.phone, l.created_at
        FROM public.tenant_notification_log l
        LEFT JOIN public.profiles p ON p.id = l.tenant_id
        WHERE l.event_key IN ('PAYMENT_FULL', 'PAYMENT_PARTIAL', 'PAYMENT_MISSED')
        ORDER BY l.created_at DESC
        LIMIT v_limit
      ) r
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_communications_overview(integer) TO authenticated, service_role;

-- Care numbers are maintained from the Tenant Communications tab.
CREATE OR REPLACE FUNCTION public.set_tenant_support_contact(
  p_id uuid,
  p_label text,
  p_phone text,
  p_sort_order integer DEFAULT 1,
  p_active boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'super_admin')
    OR public.has_role(v_uid, 'ceo')
    OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cfo')
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF COALESCE(btrim(p_label), '') = '' THEN
    RAISE EXCEPTION 'A label is required';
  END IF;
  IF COALESCE(btrim(p_phone), '') = '' THEN
    RAISE EXCEPTION 'A phone number is required';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.tenant_support_contacts (label, phone, sort_order, active, updated_by)
    VALUES (btrim(p_label), btrim(p_phone), COALESCE(p_sort_order, 1), COALESCE(p_active, true), v_uid)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.tenant_support_contacts
       SET label = btrim(p_label),
           phone = btrim(p_phone),
           sort_order = COALESCE(p_sort_order, sort_order),
           active = COALESCE(p_active, active),
           updated_at = now(),
           updated_by = v_uid
     WHERE id = p_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Contact not found';
    END IF;
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_tenant_support_contact(uuid, text, text, integer, boolean) TO authenticated, service_role;