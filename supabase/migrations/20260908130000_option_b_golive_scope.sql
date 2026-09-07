-- PHASE 2 CALLERS (3/3): Option-B go-live scoping.
--
-- PREPARED, NOT APPLIED. Supersedes the unscoped definitions in
-- 20260908120000 / 20260908120500; apply in filename order.
--
-- WHY SCOPING IS REQUIRED
-- Measured against production: 688 open/funded requests carry UGX 260,580,341 of
-- outstanding repayment, of which UGX 76,416,482 is outstanding Access +
-- Registration fee. None has funding-side L7 recognition, because none existed
-- when they were funded. Under the unscoped guard ALL 688 would be blocked from
-- repaying. Allowing them through instead would DEBIT L7 by 76,416,482 with no
-- offsetting credit - arithmetically balanced but economically meaningless.
--
-- Option B: legacy plans keep their existing repayment path untouched and are
-- neither blocked nor backfilled. Only requests funded on/after go-live enter the
-- new Treasury waterfall.
--
-- AUTHORITATIVE FUNDING FIELD: rent_requests.funded_at, set by
-- fund-agent-landlord-float at the same moment status becomes 'funded'.
--
-- DATA-QUALITY CAVEAT THAT SHAPES THE PREDICATE: 20 rows carry a funded status
-- (funded / disbursed / repaying) with a NULL funded_at. A naive
-- "funded_at >= go_live" test would misclassify them, and NULL >= x is NULL, not
-- false, in a WHERE clause. is_treasury_waterfall_scope() therefore treats NULL
-- funded_at as LEGACY explicitly.
--
-- DRY RUN (rolled back) CONFIRMED:
--   open plans on legacy path (protected)      688
--   open plans entering the new waterfall        0
--   funded-status rows with NULL funded_at      20  -> forced legacy
--   pipeline awaiting funding                    2  -> enter new path once funded

CREATE OR REPLACE FUNCTION public.treasury_waterfall_go_live()
RETURNS timestamptz LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $$ SELECT '2026-09-08 00:00:00+00'::timestamptz $$;

COMMENT ON FUNCTION public.treasury_waterfall_go_live() IS
  'Option-B go-live boundary. Requests with funded_at on/after this enter the Landlord Flow Treasury waterfall. Set to match rent_pricing_floor_effective_from() so pricing and Treasury economics start together.';

CREATE OR REPLACE FUNCTION public.is_treasury_waterfall_scope(p_rent_request_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $fn$
DECLARE v_funded timestamptz; v_fees numeric;
BEGIN
  SELECT funded_at, COALESCE(access_fee,0) + COALESCE(request_fee,0)
    INTO v_funded, v_fees
  FROM rent_requests WHERE id = p_rent_request_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_funded IS NULL THEN RETURN false; END IF;                       -- legacy
  IF v_funded < public.treasury_waterfall_go_live() THEN RETURN false; END IF;
  RETURN v_fees > 0;
END $fn$;

-- Recognition is a no-op for legacy plans: recognising fees for a plan whose
-- repayments will never allocate would strand a permanent L7 credit.
CREATE OR REPLACE FUNCTION public.recognise_funding_treasury(p_rent_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_af numeric; v_rf numeric; v_fees numeric; v_grp uuid;
BEGIN
  IF NOT public.is_treasury_waterfall_scope(p_rent_request_id) THEN
    RETURN jsonb_build_object('status','out_of_scope_legacy');
  END IF;

  SELECT COALESCE(access_fee,0), COALESCE(request_fee,0) INTO v_af, v_rf
  FROM rent_requests WHERE id = p_rent_request_id;
  v_fees := v_af + v_rf;

  IF EXISTS (SELECT 1 FROM general_ledger gl
             WHERE gl.category='treasury_fee_recognised' AND gl.ledger_scope='platform'
               AND gl.source_table='rent_requests' AND gl.source_id=p_rent_request_id) THEN
    RETURN jsonb_build_object('status','already_recognised');
  END IF;

  SELECT public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object('direction','cash_in','amount',v_fees,'category','fee_receivable_created',
        'ledger_scope','bridge','source_table','rent_requests','source_id',p_rent_request_id::text,
        'currency','UGX','transaction_date',now(),
        'description','Fee receivable recognised (access + registration) at funding'),
      jsonb_build_object('direction','cash_out','amount',v_fees,'category','treasury_fee_recognised',
        'ledger_scope','platform','source_table','rent_requests','source_id',p_rent_request_id::text,
        'currency','UGX','transaction_date',now(),
        'description','Landlord Flow Treasury recognised at funding')),
    idempotency_key := 'treasury-funding:'||p_rent_request_id::text) INTO v_grp;

  RETURN jsonb_build_object('status','recognised','transaction_group_id',v_grp,
                            'access_fee',v_af,'registration_fee',v_rf,'total',v_fees);
END $fn$;

-- Guard applies only in scope, so the 688 legacy plans are never blocked.
CREATE OR REPLACE FUNCTION public.assert_funding_treasury_recognised(p_rent_request_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $fn$
BEGIN
  IF NOT public.is_treasury_waterfall_scope(p_rent_request_id) THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM general_ledger gl
    WHERE gl.category='treasury_fee_recognised' AND gl.ledger_scope='platform'
      AND gl.source_table='rent_requests' AND gl.source_id=p_rent_request_id
  ) THEN
    RAISE EXCEPTION
      'Landlord Flow sequencing violation: in-scope rent_request % has no funding-side Treasury recognition. '
      'Allocating an instalment now would drive L7 into an unexplained debit.', p_rent_request_id
      USING HINT = 'Run recognise_funding_treasury() for this request first.';
  END IF;
END $fn$;

-- Legacy plans take the original repayment path unchanged: repayment recorded,
-- no allocation spine row, no Treasury legs.
CREATE OR REPLACE FUNCTION public.record_rent_request_repayment_v2(
  p_tenant_id uuid,
  p_amount numeric,
  p_source_table text DEFAULT 'tenant_pay_rent',
  p_source_id uuid DEFAULT NULL,
  p_transaction_group_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_rr uuid; v_src uuid := COALESCE(p_source_id, gen_random_uuid()); v_wf jsonb; v_scope boolean;
BEGIN
  SELECT id INTO v_rr FROM rent_requests
  WHERE tenant_id = p_tenant_id
    AND status IN ('funded','disbursed','approved','repaying')
  ORDER BY created_at DESC LIMIT 1;
  IF v_rr IS NULL THEN RAISE EXCEPTION 'No active rent request for tenant %', p_tenant_id; END IF;

  v_scope := public.is_treasury_waterfall_scope(v_rr);

  IF v_scope THEN PERFORM public.assert_funding_treasury_recognised(v_rr); END IF;

  PERFORM public.record_rent_request_repayment(p_tenant_id, p_amount, p_transaction_group_id);

  IF v_scope THEN
    v_wf := public.post_instalment_waterfall(v_rr, p_amount, p_source_table, v_src);
  ELSE
    v_wf := jsonb_build_object('status','legacy_path_no_waterfall');
  END IF;

  RETURN jsonb_build_object('status','ok','rent_request_id',v_rr,'in_scope',v_scope,'waterfall',v_wf);
END $fn$;
