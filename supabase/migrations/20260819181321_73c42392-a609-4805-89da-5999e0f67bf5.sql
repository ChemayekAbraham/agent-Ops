-- Is this rent plan reserved (or already funded) by a partner self-managed funding?
CREATE OR REPLACE FUNCTION public.psm_plan_partner_reserved_stage(p_rent_request_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.rent_requests rr
       WHERE rr.id = p_rent_request_id AND rr.self_funding_partner_id IS NOT NULL
    ) THEN 'partner_funded'
    WHEN EXISTS (
      SELECT 1
        FROM public.partner_self_funding_lines l
        JOIN public.partner_self_commitments c ON c.id = l.commitment_id
       WHERE l.rent_request_id = p_rent_request_id
         AND c.status IN ('pending_ops_approval','active')
    ) THEN 'partner_committed'
    WHEN EXISTS (
      SELECT 1 FROM public.partner_self_plan_claims pc
       WHERE pc.rent_request_id = p_rent_request_id
         AND pc.status IN ('held','confirmed')
         AND (pc.status = 'confirmed' OR pc.expires_at > now())
    ) THEN 'partner_held'
    ELSE NULL
  END;
$$;

REVOKE ALL ON FUNCTION public.psm_plan_partner_reserved_stage(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.psm_plan_partner_reserved_stage(uuid) TO authenticated, service_role;

-- Fence: the company/CFO route can never allocate landlord float for a plan a
-- partner has reserved or already funded.
CREATE OR REPLACE FUNCTION public.guard_partner_reserved_float_allocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stage text;
BEGIN
  IF NEW.rent_request_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.source, '') = 'partner_self_funding' THEN
    RETURN NEW;
  END IF;

  v_stage := public.psm_plan_partner_reserved_stage(NEW.rent_request_id);
  IF v_stage IS NOT NULL THEN
    RAISE EXCEPTION 'PARTNER_RESERVED: this rent plan is being funded by a partner (%). Company float disbursement is blocked.', v_stage
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_partner_reserved_float_allocation ON public.agent_landlord_float_allocations;
CREATE TRIGGER trg_guard_partner_reserved_float_allocation
BEFORE INSERT ON public.agent_landlord_float_allocations
FOR EACH ROW EXECUTE FUNCTION public.guard_partner_reserved_float_allocation();

-- Reserved-plan lookup for funding queues. Deliberately exposes NO partner identity.
CREATE OR REPLACE VIEW public.v_partner_reserved_plan_ids
WITH (security_invoker = true)
AS
SELECT rr.id AS rent_request_id,
       public.psm_plan_partner_reserved_stage(rr.id) AS reserved_stage
  FROM public.rent_requests rr
 WHERE public.psm_plan_partner_reserved_stage(rr.id) IS NOT NULL;

GRANT SELECT ON public.v_partner_reserved_plan_ids TO authenticated;
GRANT SELECT ON public.v_partner_reserved_plan_ids TO service_role;