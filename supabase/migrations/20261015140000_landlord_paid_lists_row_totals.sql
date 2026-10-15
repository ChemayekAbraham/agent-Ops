-- landlord_ops_paid_lists: each row now carries what the Landlord Ops "Paid & Repaying" and "Completed" tabs show.
--
-- Same function, same signature, same access rules (Landlord Ops, COO, CFO, CEO, super admin; SECURITY DEFINER, STABLE, search_path = public;
-- EXECUTE for authenticated only). Which landlords are in each tab, the counts, the paging and the ordering are exactly as before.
-- Added to every row: tenant_count (different tenants), total_rent, total_repaid, balance_left, agent_name and agent_phone (the agent who
-- registered the landlord, the same agent the Landlords list shows), verified, verification_status and property_address.
-- The money columns cover every Rent Plan except rejected, cancelled and deleted ones, so they equal the total line of the Tenants section
-- (landlord_tenant_overview). balance_left now means that (it used to cover repaying plans only; nothing reads it yet).
-- The search also looks at the landlord's agent and at the tenants' names and phones.
--
-- Rollback: supabase/rollbacks/20261015140000_landlord_paid_lists_row_totals.rollback.sql (restores the previous body).

CREATE OR REPLACE FUNCTION public.landlord_ops_paid_lists(
  p_tab    text,
  p_search text DEFAULT NULL,
  p_limit  integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text := lower(btrim(COALESCE(p_search, '')));
  v_result jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       public.has_role(v_uid, 'landlord_ops'::app_role) OR public.has_role(v_uid, 'coo'::app_role)
       OR public.has_role(v_uid, 'cfo'::app_role) OR public.has_role(v_uid, 'ceo'::app_role)
       OR public.has_role(v_uid, 'super_admin'::app_role)
     ) THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only Landlord Ops, COO, CFO, CEO and super admin can view the landlord lists' USING ERRCODE = '42501';
  END IF;
  IF p_tab IS NULL OR p_tab NOT IN ('paid_repaying', 'completed') THEN
    RAISE EXCEPTION 'TAB_INVALID: p_tab must be paid_repaying or completed' USING ERRCODE = '22023';
  END IF;

  WITH plans AS (
    -- one line per landlord. The money columns count every Rent Plan except rejected, cancelled or deleted ones, the same rule as the
    -- Tenants section (landlord_tenant_overview), so a row here always equals that section's total line.
    SELECT rr.landlord_id,
           count(*)                                                        AS plans_total,
           count(*) FILTER (WHERE rr.status = 'repaying')                  AS repaying_plans,
           count(*) FILTER (WHERE rr.status = 'completed')                 AS completed_plans,
           count(*) FILTER (WHERE rr.status IN ('funded', 'repaying'))     AS active_plans,
           count(DISTINCT COALESCE(rr.tenant_id, rr.id)) FILTER (WHERE rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')) AS tenant_count,
           COALESCE(sum(COALESCE(rr.rent_amount, 0)) FILTER (WHERE rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')), 0) AS total_rent,
           COALESCE(sum(COALESCE(rr.amount_repaid, 0)) FILTER (WHERE rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')), 0) AS total_repaid,
           COALESCE(sum(GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0), 0)) FILTER (WHERE rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')), 0) AS balance_left,
           string_agg(DISTINCT lower(concat_ws(' ', tp.full_name, tp.phone)), ' ') FILTER (WHERE rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')) AS tenant_text
      FROM public.rent_requests rr
      LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
     WHERE rr.landlord_id IS NOT NULL
     GROUP BY rr.landlord_id
  ), payouts AS (
    -- money that reached the landlord: payouts that were disbursed (not failed)
    SELECT lp.landlord_id,
           sum(lp.amount) AS paid_amount,
           max(COALESCE(lp.finops_disbursed_at, lp.disbursed_at)) AS last_paid_at
      FROM public.landlord_payouts lp
     WHERE lp.landlord_id IS NOT NULL
       AND lp.status <> 'failed'
       AND COALESCE(lp.finops_disbursed_at, lp.disbursed_at) IS NOT NULL
     GROUP BY lp.landlord_id
  ), alloc AS (
    -- ... and the Landlord Float allocations that were paid out (cancelled ones ignored)
    SELECT a.landlord_id, sum(a.paid_out_amount) AS allocation_paid
      FROM public.agent_landlord_float_allocations a
     WHERE a.landlord_id IS NOT NULL AND a.status <> 'cancelled' AND a.paid_out_amount > 0
     GROUP BY a.landlord_id
  ), base AS (
    SELECT p.landlord_id,
           l.name AS landlord_name, l.phone AS landlord_phone, l.mobile_money_number, l.district, l.village, l.property_address,
           l.verified, l.verification_status,
           ag.full_name AS agent_name, ag.phone AS agent_phone,
           p.plans_total, p.repaying_plans, p.completed_plans, p.active_plans,
           p.tenant_count, p.total_rent, p.total_repaid, p.balance_left,
           -- the two sources describe the same money; take the larger so a landlord in both is not counted twice
           GREATEST(COALESCE(po.paid_amount, 0), COALESCE(al.allocation_paid, 0)) AS received_amount,
           po.last_paid_at,
           (po.landlord_id IS NOT NULL OR al.landlord_id IS NOT NULL) AS received_money,
           lower(concat_ws(' ', l.name, l.phone, l.mobile_money_number, l.district, l.village, l.property_address, ag.full_name, ag.phone, p.tenant_text)) AS haystack
      FROM plans p
      JOIN public.landlords l ON l.id = p.landlord_id
      LEFT JOIN public.profiles ag ON ag.id = l.registered_by
      LEFT JOIN payouts po ON po.landlord_id = p.landlord_id
      LEFT JOIN alloc al ON al.landlord_id = p.landlord_id
  ), tabbed AS (
    SELECT b.*,
           (b.received_money AND b.repaying_plans >= 1)        AS in_paid_repaying,
           (b.completed_plans >= 1 AND b.active_plans = 0)     AS in_completed
      FROM base b
  ), counts AS (
    SELECT count(*) FILTER (WHERE in_paid_repaying) AS paid_repaying, count(*) FILTER (WHERE in_completed) AS completed
      FROM tabbed
  ), sel AS (
    SELECT t.*
      FROM tabbed t
     WHERE ((p_tab = 'paid_repaying' AND t.in_paid_repaying) OR (p_tab = 'completed' AND t.in_completed))
       AND (v_search = '' OR strpos(t.haystack, v_search) > 0)
  ), page AS (
    SELECT s.*
      FROM sel s
     ORDER BY CASE WHEN p_tab = 'paid_repaying' THEN s.repaying_plans ELSE s.completed_plans END DESC,
              s.landlord_name, s.landlord_id
     LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
           'tab', p_tab,
           'search', NULLIF(v_search, ''),
           'limit', v_limit,
           'offset', v_offset,
           'total', (SELECT count(*) FROM sel),
           'counts', (SELECT jsonb_build_object('paid_repaying', c.paid_repaying, 'completed', c.completed) FROM counts c),
           'rows', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'landlord_id', g.landlord_id,
                      'landlord_name', g.landlord_name,
                      'landlord_phone', g.landlord_phone,
                      'mobile_money_number', g.mobile_money_number,
                      'district', g.district,
                      'village', g.village,
                      'plans_total', g.plans_total,
                      'repaying_plans', g.repaying_plans,
                      'completed_plans', g.completed_plans,
                      'active_plans', g.active_plans,
                      'tenant_count', g.tenant_count,
                      'total_rent', g.total_rent,
                      'total_repaid', g.total_repaid,
                      'balance_left', g.balance_left,
                      'received_amount', g.received_amount,
                      'last_paid_at', g.last_paid_at,
                      'agent_name', g.agent_name,
                      'agent_phone', g.agent_phone,
                      'verified', g.verified,
                      'verification_status', g.verification_status,
                      'property_address', g.property_address
                    ) ORDER BY CASE WHEN p_tab = 'paid_repaying' THEN g.repaying_plans ELSE g.completed_plans END DESC, g.landlord_name, g.landlord_id)
               FROM page g), '[]'::jsonb)
         )
    INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.landlord_ops_paid_lists(text, text, integer, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.landlord_ops_paid_lists(text, text, integer, integer) TO authenticated;
