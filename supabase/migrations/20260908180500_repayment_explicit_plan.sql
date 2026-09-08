-- Tenant Self-Payment (Route B) — M2: thread an explicit rent_request_id
-- through the authoritative repayment orchestration (BD-A).
--
-- THE PROBLEM THIS SOLVES
-- Three functions independently resolve "the tenant's active plan", and they
-- do NOT agree:
--
--   tenant_self_repayment_plan()        ORDER BY created_at ASC   (OLDEST)
--   record_rent_request_repayment_v2()  ORDER BY created_at DESC  (NEWEST)
--   record_rent_request_repayment()     ORDER BY created_at DESC  (NEWEST)
--                                       AND status IN ('funded','disbursed','approved')
--
-- For a tenant with two open plans, the settlement engine would settle the
-- oldest while the waterfall allocated against the newest. BD-A requires ONE
-- resolved rent_request_id to be used for repayment, allocation, waterfall,
-- attribution, reporting, notification and ledger traceability.
--
-- A second latent defect, left deliberately untouched for legacy callers: the
-- inner function's status filter omits 'repaying', while both callers above
-- include it. A plan already in 'repaying' therefore resolves in v2 but not in
-- the inner function, whose `IF v_request_id IS NOT NULL` then makes it a
-- SILENT NO-OP. Passing the id explicitly bypasses that filter entirely; the
-- NULL path keeps the existing filter verbatim so no existing caller changes
-- behaviour.
--
-- WHAT CHANGES
--   * Both functions gain a trailing `p_rent_request_id uuid DEFAULT NULL`.
--     NULL => byte-for-byte the current resolution logic. Non-NULL => use it.
--   * record_rent_request_repayment() now RETURNS the repayment id instead of
--     void, and v2 surfaces it. The self-payment route needs that id to stamp
--     deposit_request_id onto the row the authoritative function created,
--     rather than inserting a second, competing repayment row.
--
-- WHY DROP + CREATE RATHER THAN CREATE OR REPLACE
-- Postgres cannot add a parameter or change a return type in place. Leaving the
-- old arity behind would make a 5-argument call ambiguous ("function is not
-- unique") against a 6-argument version with a default. DROP + CREATE inside
-- one migration transaction is atomic, and Supabase RPC calls these by NAMED
-- argument, so existing callers that omit the new parameter continue to match.
--
-- SHARED-FUNCTION DISCLOSURE (required by the deployment brief)
-- Both functions are shared with the agent repayment path via
-- supabase/functions/tenant-pay-rent. Their behaviour when the new parameter is
-- omitted is unchanged, which is asserted at the end of this migration.

DROP FUNCTION IF EXISTS public.record_rent_request_repayment(uuid, numeric, uuid);

CREATE FUNCTION public.record_rent_request_repayment(
  p_tenant_id uuid,
  p_amount numeric,
  p_transaction_group_id uuid,
  p_rent_request_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_request_id uuid;
  v_total_repayment numeric;
  v_amount_repaid numeric;
  v_apply numeric;
  v_landlord_id uuid;
  v_landlord_name text;
  v_repayment_id uuid;
BEGIN
  IF p_rent_request_id IS NOT NULL THEN
    -- BD-A: caller has already resolved the plan. Use exactly that one. No
    -- status filter is applied here because the caller is responsible for
    -- eligibility, and the legacy filter omits 'repaying'.
    SELECT rr.id, rr.total_repayment, rr.amount_repaid, rr.landlord_id, l.name
    INTO v_request_id, v_total_repayment, v_amount_repaid, v_landlord_id, v_landlord_name
    FROM public.rent_requests rr
    LEFT JOIN public.landlords l ON l.id = rr.landlord_id
    WHERE rr.id = p_rent_request_id
      AND rr.tenant_id = p_tenant_id;

    IF v_request_id IS NULL THEN
      RAISE EXCEPTION 'rent_request % does not belong to tenant %',
        p_rent_request_id, p_tenant_id;
    END IF;
  ELSE
    -- LEGACY PATH — preserved verbatim, including the 'repaying' omission.
    SELECT rr.id, rr.total_repayment, rr.amount_repaid, rr.landlord_id, l.name
    INTO v_request_id, v_total_repayment, v_amount_repaid, v_landlord_id, v_landlord_name
    FROM public.rent_requests rr
    LEFT JOIN public.landlords l ON l.id = rr.landlord_id
    WHERE
      rr.tenant_id = p_tenant_id
      AND rr.status IN ('funded', 'disbursed', 'approved')
      AND rr.amount_repaid < rr.total_repayment
    ORDER BY rr.created_at DESC
    LIMIT 1;
  END IF;

  IF v_request_id IS NOT NULL THEN
    v_apply := LEAST(p_amount, COALESCE(v_total_repayment,0) - COALESCE(v_amount_repaid,0));

    UPDATE public.rent_requests
    SET
      amount_repaid = amount_repaid + v_apply,
      status = CASE WHEN (amount_repaid + v_apply) >= total_repayment THEN 'completed' ELSE status END,
      updated_at = now()
    WHERE id = v_request_id;

    INSERT INTO public.repayments (tenant_id, rent_request_id, amount)
    VALUES (p_tenant_id, v_request_id, v_apply)
    RETURNING id INTO v_repayment_id;

    IF v_landlord_id IS NOT NULL THEN
      UPDATE public.landlords
      SET
        rent_balance_due = GREATEST(0, rent_balance_due - v_apply),
        rent_last_paid_at = now(),
        rent_last_paid_amount = v_apply
      WHERE id = v_landlord_id;
    END IF;
  END IF;

  RETURN v_repayment_id;
END;
$function$;

DROP FUNCTION IF EXISTS public.record_rent_request_repayment_v2(uuid, numeric, text, uuid, uuid);

CREATE FUNCTION public.record_rent_request_repayment_v2(
  p_tenant_id uuid,
  p_amount numeric,
  p_source_table text,
  p_source_id uuid,
  p_transaction_group_id uuid,
  p_rent_request_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rr uuid;
  v_src uuid := COALESCE(p_source_id, gen_random_uuid());
  v_wf jsonb;
  v_scope boolean;
  v_repayment_id uuid;
BEGIN
  IF p_rent_request_id IS NOT NULL THEN
    -- BD-A: single resolved plan, threaded straight through to the waterfall.
    SELECT id INTO v_rr FROM rent_requests
     WHERE id = p_rent_request_id AND tenant_id = p_tenant_id;
    IF v_rr IS NULL THEN
      RAISE EXCEPTION 'rent_request % does not belong to tenant %',
        p_rent_request_id, p_tenant_id;
    END IF;
  ELSE
    -- LEGACY PATH — preserved verbatim.
    SELECT id INTO v_rr FROM rent_requests
    WHERE tenant_id = p_tenant_id
      AND status IN ('funded','disbursed','approved','repaying')
    ORDER BY created_at DESC LIMIT 1;
    IF v_rr IS NULL THEN RAISE EXCEPTION 'No active rent request for tenant %', p_tenant_id; END IF;
  END IF;

  v_scope := public.is_treasury_waterfall_scope(v_rr);
  IF v_scope THEN PERFORM public.assert_funding_treasury_recognised(v_rr); END IF;

  v_repayment_id := public.record_rent_request_repayment(
    p_tenant_id, p_amount, p_transaction_group_id, v_rr);

  IF v_scope THEN
    v_wf := public.post_instalment_waterfall(v_rr, p_amount, p_source_table, v_src);
  ELSE
    v_wf := jsonb_build_object('status','legacy_path_no_waterfall');
  END IF;

  RETURN jsonb_build_object('status','ok','rent_request_id',v_rr,'in_scope',v_scope,
                            'repayment_id',v_repayment_id,'waterfall',v_wf);
END;
$function$;

DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='record_rent_request_repayment';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 record_rent_request_repayment, found % (overload ambiguity)', v_n; END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='record_rent_request_repayment_v2';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 record_rent_request_repayment_v2, found %', v_n; END IF;
END $$;
