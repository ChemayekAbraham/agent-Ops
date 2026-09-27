-- Tenant Ops Workspace — the money-pipeline block for Tenant360.
--
-- Per docs/TOPS_RULES.md: one new, read-only function. Reads existing tables
-- only (rent_requests, agent_landlord_float_allocations, landlord_payouts,
-- profiles, and our own tops_plan_clock) — adds no column anywhere, writes
-- nothing. A stage with no timestamp comes back NULL; the frontend renders
-- that as "not recorded", never a guess.
CREATE OR REPLACE FUNCTION public.tops_plan_pipeline_stages(p_rent_request_id uuid)
RETURNS TABLE (
  stage_key text,
  stage_label text,
  occurred_at timestamptz,
  actor_id uuid,
  actor_name text,
  age_days integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_approved_at timestamptz;
  v_approved_by uuid;
  v_funded_at timestamptz;
  v_float_at timestamptz;
  v_float_agent uuid;
  v_landlord_paid_at timestamptz;
  v_landlord_paid_actor uuid;
  v_receipt_at timestamptz;
  v_clock_start date;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'tenant_ops'::app_role)
    OR public.has_role(auth.uid(), 'operations'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'ceo'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT rr.approved_at, rr.approved_by, rr.funded_at
  INTO v_approved_at, v_approved_by, v_funded_at
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id;

  SELECT MIN(a.created_at), (array_agg(a.agent_id ORDER BY a.created_at))[1]
  INTO v_float_at, v_float_agent
  FROM public.agent_landlord_float_allocations a
  WHERE a.rent_request_id = p_rent_request_id;

  SELECT
    COALESCE(MIN(lp.disbursed_at), MIN(lp.finops_disbursed_at)),
    (array_agg(COALESCE(lp.finops_disbursed_by, lp.agent_id)
       ORDER BY COALESCE(lp.disbursed_at, lp.finops_disbursed_at)))[1],
    MIN(lp.receipt_uploaded_at)
  INTO v_landlord_paid_at, v_landlord_paid_actor, v_receipt_at
  FROM public.landlord_payouts lp
  WHERE lp.rent_request_id = p_rent_request_id;

  SELECT c.clock_start INTO v_clock_start
  FROM public.tops_plan_clock c
  WHERE c.rent_request_id = p_rent_request_id;

  RETURN QUERY
  WITH stages(seq, stage_key, stage_label, occurred_at, actor_id) AS (
    VALUES
      (1, 'approved'::text, 'Approved'::text, v_approved_at, v_approved_by),
      (2, 'funded', 'Funded', v_funded_at, NULL::uuid),
      (3, 'float_allocated', 'Float allocated', v_float_at, v_float_agent),
      (4, 'landlord_paid', 'Landlord paid', v_landlord_paid_at, v_landlord_paid_actor),
      (5, 'receipt_confirmed', 'Receipt confirmed', v_receipt_at, NULL::uuid),
      (6, 'clock_started', 'Clock started', v_clock_start::timestamptz, NULL::uuid)
  )
  SELECT
    s.stage_key,
    s.stage_label,
    s.occurred_at,
    s.actor_id,
    p.full_name AS actor_name,
    CASE WHEN s.occurred_at IS NULL THEN NULL ELSE (v_now::date - s.occurred_at::date) END AS age_days
  FROM stages s
  LEFT JOIN public.profiles p ON p.id = s.actor_id
  ORDER BY s.seq;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_plan_pipeline_stages(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_plan_pipeline_stages(uuid) TO authenticated;

COMMENT ON FUNCTION public.tops_plan_pipeline_stages(uuid) IS
'Read RPC for Tenant360''s money-pipeline block: approved, funded, float_allocated, landlord_paid, receipt_confirmed, clock_started, each with occurred_at/actor/age_days, reading only existing tables (rent_requests, agent_landlord_float_allocations, landlord_payouts, profiles) plus our own tops_plan_clock. A stage with no timestamp comes back with occurred_at/age_days NULL. Gated by an internal has_role check; EXECUTE granted to authenticated, revoked from anon.';
