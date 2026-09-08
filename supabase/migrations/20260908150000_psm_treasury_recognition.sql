-- Partner Direct Funding (PSM): recognise Landlord Flow Treasury at funding.
--
-- THE GAP THIS CLOSES
-- psm_disburse_landlord_float() sets rent_requests.funded_at, which places a
-- post-go-live partner-funded request INTO the Treasury waterfall scope - but it
-- never called recognise_funding_treasury(). The result was a request that is
-- in scope with no L7 credit:
--   * tenant self-payment via record_rent_request_repayment_v2 would be BLOCKED
--     by assert_funding_treasury_recognised(), and
--   * an agent collection would silently bypass the new waterfall entirely.
-- Only the CFO path (fund-agent-landlord-float) had been wired.
--
-- Observed live: request 7a02c339 funded 2026-09-08 07:05 via PSM, in scope,
-- zero Treasury legs. Containment of that specific request is a SEPARATE,
-- separately-approved action and is deliberately NOT performed here.
--
-- WHAT CHANGES
-- Exactly one addition: a call to the EXISTING recognise_funding_treasury()
-- after the rent_requests UPDATE. No second implementation is created.
--
--   DR A3  bridge.fee_receivable_created    = access fee + registration fee
--   CR L7  platform.treasury_fee_recognised = access fee + registration fee
--
-- ORDERING IS LOad-BEARING: the call sits AFTER the UPDATE that sets funded_at,
-- because is_treasury_waterfall_scope() reads funded_at. Called before the
-- UPDATE it would see NULL, return out_of_scope_legacy, and silently do nothing.
--
-- WHAT DOES NOT CHANGE
--   * Principal accounting is untouched. The principal still posts
--     platform.rent_disbursement (CR A1) / bridge.rent_receivable_created (DR A3)
--     and is NEVER posted to L7.
--   * Partner ROI is untouched: accrue_partner_self_returns() continues to
--     compute principal x monthly_rate% x days_live/days_in_cycle (15%/month on
--     every current line), recorded in partner_self_earnings and paid by
--     pay_partner_self_cycles().
--   * No L3 payable is created. The instalment-level partner_reward_component
--     remains an attribution only (BD-2).
--   * The CFO funding path is untouched.
--   * Pricing is untouched.
--   * Pre-go-live PSM requests stay out of scope: recognise_funding_treasury()
--     returns 'out_of_scope_legacy' for them and posts nothing.
--
-- IDEMPOTENCY
-- Two independent layers, both already in recognise_funding_treasury():
--   1. an EXISTS check on treasury_fee_recognised for the rent_request, and
--   2. a deterministic idempotency key 'treasury-funding:<rent_request_id>'.
-- A retried disbursement therefore cannot duplicate the A3/L7 pair. The existing
-- PSM guards are unchanged: the live-allocation check, the per-commitment
-- advisory lock, and the 'psm-float-<line_id>' key on the principal legs.
--
-- FAILURE BEHAVIOUR
-- The call is deliberately NOT wrapped in an exception handler. A PL/pgSQL
-- function runs in one transaction, so if recognition fails the whole
-- disbursement rolls back. Funding a request into scope without its Treasury
-- credit is the precise defect this migration exists to remove, so a partial
-- success is worse than no success.

CREATE OR REPLACE FUNCTION public.psm_disburse_landlord_float(
  p_commitment_id uuid,
  p_topup_id uuid DEFAULT NULL::uuid,
  p_rent_request_ids uuid[] DEFAULT NULL::uuid[]
) RETURNS jsonb
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
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.psm_is_topup_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT partner_id INTO v_partner FROM public.partner_self_commitments WHERE id = p_commitment_id;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'commitment_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-float-' || p_commitment_id::text));

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

    -- PRINCIPAL ONLY. Unchanged. Never posted to L7.
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

    -- LANDLORD FLOW TREASURY RECOGNITION.
    -- MUST run after the UPDATE above: is_treasury_waterfall_scope() reads
    -- funded_at, so calling this earlier would see NULL and silently skip.
    -- Reuses the existing function; idempotent; returns 'out_of_scope_legacy'
    -- for pre-go-live requests and posts nothing for them.
    v_treasury := public.recognise_funding_treasury(v_line.rent_request_id);
    IF (v_treasury->>'status') = 'recognised' THEN
      v_treasury_recognised := v_treasury_recognised + 1;
    END IF;

    v_funded := v_funded + 1;
    v_total := v_total + v_line.principal;
  END LOOP;

  -- Notices must describe ONLY what this disbursement released. Aggregating by
  -- rent_request_id previously swept in cancelled/reverted allocations for the
  -- same tenant, inflating both the amount and the tenant count in the SMS.
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
                       'topup_id', p_topup_id));

  RETURN jsonb_build_object('funded', v_funded, 'skipped', v_skipped,
                            'total_amount', v_total, 'notices_queued', v_notices,
                            'treasury_recognised', v_treasury_recognised);
END;
$function$;
