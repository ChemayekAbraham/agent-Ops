-- PHASE 2 (BD-3): historical Treasury shortfall recorded as a contra-revenue
-- pricing subsidy of UGX 940,292.
--
-- Population: 17 funded requests where partner reward + agent commission exceed
-- access fee + registration fee. All 17 are 7-day plans. Recorded line by line in
-- bd3_pricing_subsidy_population so the aggregate traces to identified requests
-- and is not spread across unrelated transactions.
--
-- Entry:  DR R1 940,292 (contra-revenue)  /  CR L7 940,292 (Treasury funded)
--
-- Touches no cash, no customer repayment, no partner ROI payment, no agent
-- commission already paid, and rewrites no historical row.
--
-- WHY 940,292 AND NOT 1,280,305: Access Fee and Registration Fee are treated as
-- fungible within the Landlord Flow Treasury, per BD-3. The two figures differ by
-- exactly UGX 340,013 of registration fee: 21 requests breach the Access Fee
-- alone, of which 4 are fully rescued by their registration fee, leaving 17 that
-- remain negative at Treasury level.

CREATE TABLE IF NOT EXISTS public.bd3_pricing_subsidy_population (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id      uuid NOT NULL REFERENCES public.rent_requests(id),
  duration_days        integer NOT NULL,
  rent_amount          numeric(20,2) NOT NULL,
  access_fee           numeric(20,2) NOT NULL,
  registration_fee     numeric(20,2) NOT NULL,
  partner_reward       numeric(20,2) NOT NULL,
  agent_commission     numeric(20,2) NOT NULL,
  shortfall            numeric(20,2) NOT NULL,
  transaction_group_id uuid,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bd3_shortfall_positive CHECK (shortfall > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bd3_population_rr
  ON public.bd3_pricing_subsidy_population(rent_request_id);

INSERT INTO public.bd3_pricing_subsidy_population
  (rent_request_id, duration_days, rent_amount, access_fee, registration_fee,
   partner_reward, agent_commission, shortfall)
SELECT id, duration_days, rent_amount, access_fee, request_fee,
       ROUND(rent_amount * 0.15 * (duration_days / 30.0)),
       ROUND(total_repayment * 0.10),
       ROUND(rent_amount * 0.15 * (duration_days / 30.0)) + ROUND(total_repayment * 0.10)
         - access_fee - request_fee
FROM public.rent_requests
WHERE funded_at IS NOT NULL AND access_fee > 0 AND duration_days > 0
  AND ROUND(rent_amount * 0.15 * (duration_days / 30.0)) + ROUND(total_repayment * 0.10)
      - access_fee - request_fee > 0
ON CONFLICT (rent_request_id) DO NOTHING;

DO $t$
DECLARE v_grp uuid; v_amt numeric; v_n int;
BEGIN
  SELECT ROUND(SUM(shortfall)), COUNT(*) INTO v_amt, v_n
  FROM public.bd3_pricing_subsidy_population WHERE transaction_group_id IS NULL;
  IF COALESCE(v_amt, 0) <= 0 THEN
    RAISE NOTICE 'BD-3 subsidy already posted - skipping';
    RETURN;
  END IF;

  SELECT public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object('direction','cash_in','amount', v_amt,
        'category','treasury_net_revenue','ledger_scope','platform',
        'source_table','bd3_pricing_subsidy_population','currency','UGX','transaction_date',now(),
        'description','BD-3 contra-revenue pricing subsidy: ' || v_n ||
                      ' underpriced 7-day Landlord Flow requests. Trace: bd3_pricing_subsidy_population.'),
      jsonb_build_object('direction','cash_out','amount', v_amt,
        'category','treasury_fee_recognised','ledger_scope','platform',
        'source_table','bd3_pricing_subsidy_population','currency','UGX','transaction_date',now(),
        'description','BD-3 subsidy credited to Landlord Flow Treasury control')
    ), idempotency_key := 'bd3-pricing-subsidy-v1') INTO v_grp;

  UPDATE public.bd3_pricing_subsidy_population
     SET transaction_group_id = v_grp WHERE transaction_group_id IS NULL;
END $t$;
