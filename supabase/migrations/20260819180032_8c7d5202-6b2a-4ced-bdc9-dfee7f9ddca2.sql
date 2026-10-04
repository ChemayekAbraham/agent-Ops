-- 1. Traceability columns on landlord float allocations
ALTER TABLE public.agent_landlord_float_allocations
  ADD COLUMN IF NOT EXISTS funded_by_partner_id uuid,
  ADD COLUMN IF NOT EXISTS funding_reference text;

CREATE INDEX IF NOT EXISTS idx_alfa_funded_by_partner
  ON public.agent_landlord_float_allocations (funded_by_partner_id)
  WHERE funded_by_partner_id IS NOT NULL;

-- 2. Agent SMS notice queue (DB-backed, one row per agent+landlord per approval)
CREATE TABLE IF NOT EXISTS public.partner_float_agent_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id uuid NOT NULL REFERENCES public.partner_self_commitments(id) ON DELETE CASCADE,
  topup_id uuid REFERENCES public.partner_self_topups(id) ON DELETE SET NULL,
  partner_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  landlord_id uuid,
  landlord_name text NOT NULL DEFAULT 'the landlord',
  amount numeric NOT NULL CHECK (amount > 0),
  tenant_count integer NOT NULL DEFAULT 1,
  rent_request_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  provider text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.partner_float_agent_notices TO authenticated;
GRANT ALL ON public.partner_float_agent_notices TO service_role;
ALTER TABLE public.partner_float_agent_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ops_read_partner_float_notices" ON public.partner_float_agent_notices;
CREATE POLICY "ops_read_partner_float_notices"
  ON public.partner_float_agent_notices FOR SELECT TO authenticated
  USING (
    public.psm_is_topup_reviewer(auth.uid())
    OR agent_id = auth.uid()
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_pfan_unique_scope
  ON public.partner_float_agent_notices (
    COALESCE(topup_id, commitment_id), agent_id, COALESCE(landlord_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS idx_pfan_pending
  ON public.partner_float_agent_notices (status, created_at)
  WHERE status = 'pending';

DROP TRIGGER IF EXISTS trg_pfan_updated_at ON public.partner_float_agent_notices;
CREATE TRIGGER trg_pfan_updated_at
  BEFORE UPDATE ON public.partner_float_agent_notices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Disbursement routine: partner principal -> agent landlord float
CREATE OR REPLACE FUNCTION public.psm_disburse_landlord_float(
  p_commitment_id uuid,
  p_topup_id uuid DEFAULT NULL,
  p_rent_request_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid;
  v_line record;
  v_agent uuid;
  v_alloc uuid;
  v_landlord_name text;
  v_ref text;
  v_funded integer := 0;
  v_skipped integer := 0;
  v_total numeric := 0;
  v_notices integer := 0;
BEGIN
  SELECT partner_id INTO v_partner FROM public.partner_self_commitments WHERE id = p_commitment_id;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'commitment_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-float-' || p_commitment_id::text));

  -- Single set-based read: lines + rent request + landlord in one pass (no N+1).
  FOR v_line IN
    SELECT l.id AS line_id,
           l.principal,
           l.rent_request_id,
           rr.status AS rr_status,
           rr.tenant_id,
           rr.landlord_id,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           ld.name AS landlord_name
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.landlords ld ON ld.id = rr.landlord_id
     WHERE l.commitment_id = p_commitment_id
       AND (p_rent_request_ids IS NULL OR l.rent_request_id = ANY(p_rent_request_ids))
     ORDER BY l.created_at
  LOOP
    v_agent := v_line.agent_id;

    IF v_agent IS NULL THEN
      v_skipped := v_skipped + 1;
      PERFORM public.psm_audit(auth.uid(), v_partner, 'float_disbursement_skipped',
        'partner_self_funding_lines', v_line.line_id,
        jsonb_build_object('reason', 'no_agent_assigned', 'rent_request_id', v_line.rent_request_id));
      CONTINUE;
    END IF;

    -- Never double-fund: any live allocation on this plan (any source) blocks.
    IF EXISTS (
      SELECT 1 FROM public.agent_landlord_float_allocations a
       WHERE a.rent_request_id = v_line.rent_request_id
         AND a.status IN ('open','partially_paid')
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_landlord_name := COALESCE(v_line.landlord_name, 'Unknown Landlord');
    v_ref := 'PSF-' || upper(substr(replace(v_line.line_id::text, '-', ''), 1, 8));

    INSERT INTO public.agent_landlord_float_allocations (
      agent_id, tenant_id, rent_request_id, landlord_id,
      landlord_name, landlord_phone, allocated_amount, source,
      funded_by_partner_id, funding_reference
    )
    SELECT v_agent, v_line.tenant_id, v_line.rent_request_id, v_line.landlord_id,
           v_landlord_name, COALESCE(ld.mobile_money_number, ld.phone),
           v_line.principal, 'partner_self_funding', v_partner, v_ref
      FROM (SELECT 1) x
      LEFT JOIN public.landlords ld ON ld.id = v_line.landlord_id
    RETURNING id INTO v_alloc;

    -- Ledger: platform pays out, bridge receivable created. Partner stamped on
    -- both legs so the CFO can trace the funding to the partner.
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'direction','cash_out','amount', v_line.principal,
          'category','rent_disbursement','ledger_scope','platform',
          'source_table','partner_self_funding_lines','source_id', v_line.line_id,
          'reference_id', v_ref,
          'user_id', v_agent,
          'linked_party', v_partner::text,
          'description','Partner self-managed funding released to agent landlord float for ' || v_landlord_name
        ),
        jsonb_build_object(
          'direction','cash_in','amount', v_line.principal,
          'category','rent_receivable_created','ledger_scope','bridge',
          'source_table','partner_self_funding_lines','source_id', v_line.line_id,
          'reference_id', v_ref,
          'user_id', v_agent,
          'linked_party', v_partner::text,
          'description','Landlord float credited (partner-funded) – ' || v_landlord_name
        )
      ),
      idempotency_key := 'psm-float-' || v_line.line_id::text
    );

    INSERT INTO public.agent_float_funding (agent_id, amount, funded_by, rent_request_id, notes)
    VALUES (v_agent, v_line.principal, auth.uid(), v_line.rent_request_id,
            'Partner-funded landlord float for ' || v_landlord_name)
    ON CONFLICT DO NOTHING;

    UPDATE public.rent_requests
       SET status = 'funded',
           funded_at = COALESCE(funded_at, now()),
           self_funding_partner_id = COALESCE(self_funding_partner_id, v_partner),
           self_funding_line_id = COALESCE(self_funding_line_id, v_line.line_id),
           updated_at = now()
     WHERE id = v_line.rent_request_id
       AND status IN ('approved','coo_approved','pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','cfo_approved');

    v_funded := v_funded + 1;
    v_total := v_total + v_line.principal;
  END LOOP;

  -- One notice per agent+landlord, built set-based from the allocations we own.
  WITH grouped AS (
    SELECT a.agent_id, a.landlord_id,
           MIN(a.landlord_name) AS landlord_name,
           SUM(a.allocated_amount) AS amount,
           COUNT(*)::int AS tenant_count,
           array_agg(a.rent_request_id) AS rent_request_ids
      FROM public.agent_landlord_float_allocations a
      JOIN public.partner_self_funding_lines l
        ON l.rent_request_id = a.rent_request_id AND l.commitment_id = p_commitment_id
     WHERE a.source = 'partner_self_funding'
       AND a.funded_by_partner_id = v_partner
       AND (p_rent_request_ids IS NULL OR a.rent_request_id = ANY(p_rent_request_ids))
     GROUP BY a.agent_id, a.landlord_id
  ), ins AS (
    INSERT INTO public.partner_float_agent_notices (
      commitment_id, topup_id, partner_id, agent_id, landlord_id,
      landlord_name, amount, tenant_count, rent_request_ids
    )
    SELECT p_commitment_id, p_topup_id, v_partner, g.agent_id, g.landlord_id,
           COALESCE(g.landlord_name,'the landlord'), g.amount, g.tenant_count, g.rent_request_ids
      FROM grouped g
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_notices FROM ins;

  PERFORM public.psm_audit(auth.uid(), v_partner, 'landlord_float_disbursed',
    'partner_self_commitments', p_commitment_id,
    jsonb_build_object('funded_lines', v_funded, 'skipped_lines', v_skipped,
                       'total_amount', v_total, 'notices_queued', v_notices,
                       'topup_id', p_topup_id));

  RETURN jsonb_build_object('funded', v_funded, 'skipped', v_skipped,
                            'total_amount', v_total, 'notices_queued', v_notices);
END;
$function$;

REVOKE ALL ON FUNCTION public.psm_disburse_landlord_float(uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.psm_disburse_landlord_float(uuid, uuid, uuid[]) TO authenticated, service_role;

-- 4. CFO tracking view
CREATE OR REPLACE VIEW public.v_partner_funded_landlord_float AS
SELECT a.id AS allocation_id,
       a.funded_by_partner_id AS partner_id,
       pp.full_name AS partner_name,
       a.agent_id,
       ap.full_name AS agent_name,
       a.landlord_id,
       a.landlord_name,
       a.tenant_id,
       tp.full_name AS tenant_name,
       a.rent_request_id,
       a.allocated_amount,
       a.paid_out_amount,
       a.remaining_amount,
       a.status,
       a.funding_reference,
       a.created_at,
       l.commitment_id,
       l.id AS funding_line_id
  FROM public.agent_landlord_float_allocations a
  LEFT JOIN public.partner_self_funding_lines l ON l.rent_request_id = a.rent_request_id
  LEFT JOIN public.profiles pp ON pp.id = a.funded_by_partner_id
  LEFT JOIN public.profiles ap ON ap.id = a.agent_id
  LEFT JOIN public.profiles tp ON tp.id = a.tenant_id
 WHERE a.source = 'partner_self_funding';

GRANT SELECT ON public.v_partner_funded_landlord_float TO authenticated, service_role;

-- 5. Queue view for the SMS worker (single round trip: notice + agent contact)
CREATE OR REPLACE VIEW public.v_partner_float_notice_queue AS
SELECT n.id, n.commitment_id, n.topup_id, n.partner_id, n.agent_id,
       n.landlord_id, n.landlord_name, n.amount, n.tenant_count,
       n.status, n.attempts, n.created_at,
       p.full_name AS agent_name,
       COALESCE(p.phone, p.mobile_money_number) AS agent_phone
  FROM public.partner_float_agent_notices n
  LEFT JOIN public.profiles p ON p.id = n.agent_id;

GRANT SELECT ON public.v_partner_float_notice_queue TO service_role;
