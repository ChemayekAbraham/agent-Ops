-- Landlord Float Pool — self-managed top-ups reach the pool.
--
-- Design: docs/LANDLORD_POOL_FUNDING_DESIGN.md §11
-- Needs:  20260929230800 (landlord_pool_reserve_increment)
--
-- partner_ops_approve_self_topup posts the partner debit (supporter_rent_fund,
-- key psm-topup-<id>) and then calls psm_disburse_landlord_float with
-- p_topup_id and the new tenant lines. Each new line is now reserved as a
-- self-support TOP-UP entry (landlord_pool_topup_self_support) and drawn
-- straight to the agent's landlord float by the existing deploy below it —
-- the same flow as a new tenant-backed portfolio.
--
-- Reproduced from the live definition (20260929230400); the only changes are
-- the lines marked `Landlord Float Pool (self-managed top-ups)` and the
-- reserve block. Non-blocking: a failed reserve is filed for replay and the
-- top-up still funds the tenant from treasury, as it does today.

CREATE OR REPLACE FUNCTION public.psm_disburse_landlord_float(p_commitment_id uuid, p_topup_id uuid DEFAULT NULL::uuid, p_rent_request_ids uuid[] DEFAULT NULL::uuid[])
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
  v_alloc_ids uuid[] := ARRAY[]::uuid[];
  v_landlord_name text;
  v_ref text;
  v_funded integer := 0;
  v_skipped integer := 0;
  v_total numeric := 0;
  v_notices integer := 0;
  v_treasury jsonb;
  v_treasury_recognised integer := 0;
  v_pool_entry uuid;          -- Landlord Float Pool
  v_pool_drawn numeric := 0;  -- Landlord Float Pool
  v_pool_pid uuid;            -- Landlord Float Pool (self-managed top-ups)
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.psm_is_topup_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT partner_id INTO v_partner FROM public.partner_self_commitments WHERE id = p_commitment_id;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'commitment_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-float-' || p_commitment_id::text));

  -- Landlord Float Pool: a self-managed top-up's new tenant lines are reserved
  -- as self-support TOP-UP entries — only once the top-up's own wallet debit
  -- (key psm-topup-<id>) exists, and only for a pool_eligible portfolio
  -- (checked inside landlord_pool_reserve_increment).
  IF p_topup_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.general_ledger g
                  WHERE g.idempotency_key = 'psm-topup-' || p_topup_id::text) THEN
    SELECT fp.portfolio_id INTO v_pool_pid FROM public.funder_pending_portfolios fp
     WHERE fp.commitment_id = p_commitment_id ORDER BY fp.created_at DESC LIMIT 1;
  END IF;

  FOR v_line IN
    SELECT l.id AS line_id,
           l.principal,
           l.rent_request_id,
           rr.status AS rr_status,
           rr.tenant_id,
           rr.landlord_id,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           ld.name AS landlord_name,
           COALESCE(ld.mobile_money_number, ld.phone) AS landlord_phone
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
    ) VALUES (
      v_agent, v_line.tenant_id, v_line.rent_request_id, v_line.landlord_id,
      v_landlord_name, v_line.landlord_phone, v_line.principal, 'partner_self_funding',
      v_partner, v_ref
    )
    RETURNING id INTO v_alloc;

    v_alloc_ids := v_alloc_ids || v_alloc;

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
          'description','Landlord float credited (partner-funded) - ' || v_landlord_name
        )
      ),
      idempotency_key := 'psm-float-' || v_line.line_id::text
    );

    -- Landlord Float Pool (self-managed top-ups): reserve this top-up line first.
    IF v_pool_pid IS NOT NULL THEN
      BEGIN
        PERFORM public.landlord_pool_reserve_increment(v_pool_pid, 'topup', v_line.principal,
          'partner_self_funding_lines', v_line.line_id, 'psm_self_topup');
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
        VALUES (v_pool_pid, 'reserve', 'psm_self_topup', SQLERRM,
                jsonb_build_object('sqlstate', SQLSTATE, 'topup_id', p_topup_id, 'line_id', v_line.line_id));
      END;
    END IF;

    -- Landlord Float Pool: this tenant line was reserved as self-support, so
    -- the money leaves the pool now, beside the rent_disbursement above.
    v_pool_entry := NULL;
    SELECT e.id INTO v_pool_entry FROM public.landlord_pool_entries e
     WHERE e.source_table = 'partner_self_funding_lines' AND e.source_id = v_line.line_id
       AND e.status = 'open' AND e.in_pool > 0;
    IF v_pool_entry IS NOT NULL THEN
      v_pool_drawn := v_pool_drawn + coalesce((public.landlord_pool_deploy(
        v_line.rent_request_id, v_line.principal, 'self_support', v_alloc, v_pool_entry,
        'psm_disburse_landlord_float') ->> 'drawn')::numeric, 0);
    END IF;

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
       AND status IN ('approved','coo_approved','pending','agent_ops_approved',
                      'tenant_ops_approved','landlord_ops_approved','cfo_approved');

    v_treasury := public.recognise_funding_treasury(v_line.rent_request_id);
    IF (v_treasury->>'status') = 'recognised' THEN
      v_treasury_recognised := v_treasury_recognised + 1;
    END IF;

    v_funded := v_funded + 1;
    v_total := v_total + v_line.principal;
  END LOOP;

  WITH grouped AS (
    SELECT a.agent_id, a.landlord_id,
           MIN(a.landlord_name) AS landlord_name,
           SUM(a.allocated_amount) AS amount,
           COUNT(DISTINCT a.rent_request_id)::int AS tenant_count,
           array_agg(DISTINCT a.rent_request_id) AS rent_request_ids
      FROM public.agent_landlord_float_allocations a
     WHERE a.id = ANY(v_alloc_ids)
       AND a.status NOT IN ('cancelled','reversed')
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
                       'treasury_recognised', v_treasury_recognised,
                       'topup_id', p_topup_id,
                       'landlord_pool_drawn', v_pool_drawn));

  RETURN jsonb_build_object('funded', v_funded, 'skipped', v_skipped,
                            'total_amount', v_total, 'notices_queued', v_notices,
                            'treasury_recognised', v_treasury_recognised,
                            'landlord_pool_drawn', v_pool_drawn);
END;
$function$;
