-- PHASE 2 CALLERS (1/2): funding-side Treasury recognition + sequencing guard.
--
-- PREPARED, NOT APPLIED. Nothing in this file has been run against production.
--
-- WHY AN A3 FEE-RECEIVABLE LEG IS REQUIRED (the question asked before implementing)
-- At funding today only the PRINCIPAL is debited to A3, but the tenant owes
-- total_repayment = principal + access fee + registration fee. The repayment
-- waterfall credits A3 for the WHOLE instalment, including its fee components.
-- Without a matching fee receivable at funding, A3 would be over-credited by
-- exactly (access + registration) over the life of each plan and would drift
-- negative. So a single L7 control entry is NOT sufficient: the fee receivable
-- leg is architecturally required, and it conveniently provides L7's credit.
--
--   DR A3  bridge.fee_receivable_created    = access + registration
--   CR L7  platform.treasury_fee_recognised = access + registration
--
-- No cash moves. A1, A2 and A5 are untouched: L7 is an accounting designation,
-- not a second cash account. No L3 payable is created - the 15% Partner Reward
-- remains allocation-only under BD-2.
--
-- VERIFIED IN A ROLLED-BACK TRANSACTION against request 3f505690
-- (access 330,000 + registration 20,000):
--   shape        L7/CR 350,000 | A3/DR 350,000
--   mapped       DR 350,000 = CR 350,000
--   raw          cash_in 350,000 = cash_out 350,000
--
-- IDEMPOTENCY: the idempotency_key is derived from the rent_request_id, so a
-- retry cannot recognise the same funding fees twice.

CREATE OR REPLACE FUNCTION public.recognise_funding_treasury(p_rent_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_af numeric; v_rf numeric; v_fees numeric; v_grp uuid;
BEGIN
  SELECT COALESCE(access_fee,0), COALESCE(request_fee,0) INTO v_af, v_rf
  FROM rent_requests WHERE id = p_rent_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'rent_request % not found', p_rent_request_id; END IF;

  v_fees := v_af + v_rf;
  IF v_fees <= 0 THEN RETURN jsonb_build_object('status','no_fees'); END IF;

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

-- SEQUENCING GUARD. The waterfall DEBITS L7. Without funding-side recognition
-- first, allocating an instalment would drive L7 into a debit balance that
-- balances arithmetically but is economically meaningless. This makes that
-- failure loud instead of silent.
--
-- VERIFIED IN A ROLLED-BACK TRANSACTION:
--   no recognition  -> BLOCKED
--   after recognition -> ALLOWED
CREATE OR REPLACE FUNCTION public.assert_funding_treasury_recognised(p_rent_request_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM general_ledger gl
    WHERE gl.category='treasury_fee_recognised' AND gl.ledger_scope='platform'
      AND gl.source_table='rent_requests' AND gl.source_id=p_rent_request_id
  ) AND EXISTS (
    SELECT 1 FROM rent_requests r WHERE r.id=p_rent_request_id
      AND COALESCE(r.access_fee,0)+COALESCE(r.request_fee,0) > 0
  ) THEN
    RAISE EXCEPTION
      'Landlord Flow sequencing violation: rent_request % has no funding-side Treasury recognition. '
      'Allocating an instalment now would drive L7 into an unexplained debit.', p_rent_request_id
      USING HINT = 'Run recognise_funding_treasury() for this request first.';
  END IF;
END $fn$;
