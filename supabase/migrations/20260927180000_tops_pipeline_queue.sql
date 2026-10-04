-- Tenant Ops Workspace — Pipeline tab: one queue of currently-stalled plans,
-- reusing the exact stage vocabulary and timestamp sources
-- tops_plan_pipeline_stages() already established for Tenant360 (same six
-- stages: approved, funded, float_allocated, landlord_paid,
-- receipt_confirmed, clock_started). That function answers "where has THIS
-- one plan been" for a single plan; this one answers "which plans are
-- currently stuck, and where" across the whole portfolio. No new geo/agg
-- logic invented — the per-stage timestamp derivation is copied verbatim
-- from tops_plan_pipeline_stages's own body, just applied to every
-- in-flight plan instead of one.
--
-- A plan is "in the pipeline" once approved and until its repayment clock
-- starts (tops_plan_clock.clock_start set) — once the clock starts it has
-- left this pipeline and belongs to Collections/Calling instead. Rejected/
-- cancelled/deleted-by-agent plans never entered a live pipeline and are
-- excluded.
CREATE OR REPLACE FUNCTION public.tops_pipeline_queue()
RETURNS TABLE (
  rent_request_id uuid,
  tenant_name text,
  agent_name text,
  current_stage_key text,
  current_stage_label text,
  gap_label text,
  owner_id uuid,
  owner_name text,
  stage_entered_at timestamptz,
  age_days integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
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

  RETURN QUERY
  WITH plans AS (
    SELECT
      rr.id AS rent_request_id,
      rr.tenant_id,
      COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
      rr.approved_at,
      rr.approved_by,
      rr.funded_at
    FROM public.rent_requests rr
    LEFT JOIN public.tops_plan_clock c ON c.rent_request_id = rr.id
    WHERE rr.approved_at IS NOT NULL
      AND rr.status NOT IN ('rejected', 'cancelled', 'deleted_by_agent')
      AND c.clock_start IS NULL
  ),
  float_alloc AS (
    SELECT
      a.rent_request_id,
      MIN(a.created_at) AS float_at,
      (array_agg(a.agent_id ORDER BY a.created_at))[1] AS float_agent
    FROM public.agent_landlord_float_allocations a
    GROUP BY a.rent_request_id
  ),
  landlord AS (
    SELECT
      lp.rent_request_id,
      COALESCE(MIN(lp.disbursed_at), MIN(lp.finops_disbursed_at)) AS landlord_paid_at,
      (array_agg(COALESCE(lp.finops_disbursed_by, lp.agent_id)
         ORDER BY COALESCE(lp.disbursed_at, lp.finops_disbursed_at)))[1] AS landlord_paid_actor,
      MIN(lp.receipt_uploaded_at) AS receipt_at
    FROM public.landlord_payouts lp
    GROUP BY lp.rent_request_id
  ),
  staged AS (
    SELECT
      p.rent_request_id, p.tenant_id, p.agent_id,
      p.approved_at, p.approved_by, p.funded_at,
      fa.float_at, fa.float_agent,
      l.landlord_paid_at, l.landlord_paid_actor, l.receipt_at
    FROM plans p
    LEFT JOIN float_alloc fa ON fa.rent_request_id = p.rent_request_id
    LEFT JOIN landlord l ON l.rent_request_id = p.rent_request_id
  ),
  current_stage AS (
    SELECT
      s.rent_request_id, s.tenant_id, s.agent_id,
      CASE
        WHEN s.receipt_at IS NOT NULL THEN 'receipt_confirmed'
        WHEN s.landlord_paid_at IS NOT NULL THEN 'landlord_paid'
        WHEN s.float_at IS NOT NULL THEN 'float_allocated'
        WHEN s.funded_at IS NOT NULL THEN 'funded'
        ELSE 'approved'
      END AS current_stage_key,
      CASE
        WHEN s.receipt_at IS NOT NULL THEN s.receipt_at
        WHEN s.landlord_paid_at IS NOT NULL THEN s.landlord_paid_at
        WHEN s.float_at IS NOT NULL THEN s.float_at
        WHEN s.funded_at IS NOT NULL THEN s.funded_at
        ELSE s.approved_at
      END AS stage_entered_at,
      CASE
        WHEN s.receipt_at IS NOT NULL THEN NULL::uuid
        WHEN s.landlord_paid_at IS NOT NULL THEN s.landlord_paid_actor
        WHEN s.float_at IS NOT NULL THEN s.float_agent
        WHEN s.funded_at IS NOT NULL THEN NULL::uuid
        ELSE s.approved_by
      END AS owner_id
    FROM staged s
  )
  SELECT
    cs.rent_request_id,
    tp.full_name,
    ap.full_name,
    cs.current_stage_key,
    CASE cs.current_stage_key
      WHEN 'approved' THEN 'Approved'
      WHEN 'funded' THEN 'Funded'
      WHEN 'float_allocated' THEN 'Float allocated'
      WHEN 'landlord_paid' THEN 'Landlord paid'
      WHEN 'receipt_confirmed' THEN 'Receipt confirmed'
    END,
    CASE
      WHEN cs.current_stage_key = 'approved' THEN 'Approved but unfunded'
      WHEN cs.current_stage_key IN ('funded', 'float_allocated') THEN 'Funded but landlord unpaid'
      WHEN cs.current_stage_key IN ('landlord_paid', 'receipt_confirmed') THEN 'Landlord paid but clock not started'
    END,
    cs.owner_id,
    op.full_name,
    cs.stage_entered_at,
    (v_now::date - cs.stage_entered_at::date)::integer
  FROM current_stage cs
  LEFT JOIN public.profiles tp ON tp.id = cs.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = cs.agent_id
  LEFT JOIN public.profiles op ON op.id = cs.owner_id
  ORDER BY (v_now::date - cs.stage_entered_at::date) DESC NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_pipeline_queue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tops_pipeline_queue() TO authenticated;

COMMENT ON FUNCTION public.tops_pipeline_queue() IS
'One row per plan currently stalled in the funding pipeline (approved but the repayment clock has not yet started), with its current stage, that stage''s owner/actor, and age in days — the same six-stage vocabulary and timestamp sources tops_plan_pipeline_stages() already established, applied across the whole portfolio instead of one plan. gap_label answers the brief''s three named one-click questions directly (approved but unfunded / funded but landlord unpaid / landlord paid but clock not started); "waiting on my desk" is owner_id = the viewer, filtered client-side. Default sort is age_days descending — stalled items are the point. Gated by an internal has_role check.';
