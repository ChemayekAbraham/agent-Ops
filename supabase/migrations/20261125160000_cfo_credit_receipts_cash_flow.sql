-- CFO direct credits (CFO decision 16 Nov 2026): a CFO credit of an incoming email/SMS receipt that was booked against
-- Legacy Opening Balance Adjustments (E3) is reclassified to cash by batch acct_corr_202611_cfo_credits
-- (docs/finance/corrections/2026-11-16_cfo_credit_receipts.sql). In the cash flow that cash is customer money received
-- into wallets, not a legacy adjustment. Data only (one cash-flow line); no posting.
DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fin_cash_flow_map WHERE account_code = 'E3' AND category = 'wallet_correction_reclass_e3') THEN
    RAISE EXCEPTION 'precondition failed: already installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ledger_account_map WHERE category = 'wallet_correction_reclass_e3') THEN
    RAISE EXCEPTION 'precondition failed: migration 20261125110000 is not installed';
  END IF;
END $pre$;

INSERT INTO public.fin_cash_flow_map (account_code, category, section, group_label, group_sort, line_in, line_out, sort)
VALUES ('E3', 'wallet_correction_reclass_e3', 'operating', 'Customer wallet funds (held for users)', 60,
        'Customer funds received into wallets', 'Customer funds paid out of wallets', 10);
