-- Doc 213. Emma Maiso (6bb72978-1450-4800-96c2-8d1414ab2df5): the 3,000,000 Airtel
-- float top-up (TID 158376088074, occurred 2026-10-08 18:18:05 UTC) was sent to cover
-- payout 59ae76d0 (UGX 1,800,000). It was ingested at 18:19:01, after the payout had
-- reserved at 18:18:22, so the classifier saw only 371,500 float and filed UGX
-- 1,430,500 (1,428,500 principal + 2,000 telecom) as her own money. The 3M was then
-- credited in full, so her float was overstated by exactly that amount while the same
-- amount sat as a claim.
--
-- Josh (2026-10-09): the 3M was meant to cover the 1.8M payout; the company owes
-- nothing. Books fixed in two halves that must move together:
--   1. book the missing float consumption (float -1,430,500, platform offset);
--   2. reject the two claims (kept for audit, not deleted).
-- Net position is unchanged (-925,408): this removes the phantom float AND the claim.
--
-- Notes:
--  * The principal leg uses reference '<wd>-merchant-float-consume-topup-cover'
--    because uq_general_ledger_reference_dedupe forbids a second wallet cash_out with
--    the original '-merchant-float-consume' reference. The classifier only sums the
--    exact original reference, so it still sees 371,500 float; the rejected claims
--    stay rejected (its upsert only touches pending rows).
--  * The telecom claim carries reviewed_at from auto-confirmation, so the filter
--    ignores reviewed_at and only protects attested / reimbursed rows.
--  * Dry-run on production 2026-10-09 (rolled back): float 1,794,000 -> 363,500.
DO $$
DECLARE
  c_agent constant uuid := '6bb72978-1450-4800-96c2-8d1414ab2df5';
  c_wd    constant uuid := '59ae76d0-0f27-42ff-bef8-7d1f50d19058';
  c_ts    constant timestamptz := '2026-10-08 18:20:31+00';
  v_before numeric; v_after numeric; v_claims numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM public.general_ledger
              WHERE reference_id = c_wd::text || '-merchant-float-consume-topup-cover') THEN
    RETURN; -- already applied
  END IF;

  SELECT COALESCE(SUM(shortfall_amount), 0) INTO v_claims
  FROM public.merchant_out_of_pocket_advances
  WHERE withdrawal_id = c_wd AND status = 'pending_reimbursement'
    AND attested_at IS NULL AND reimbursed_at IS NULL;
  IF v_claims <> 1430500 THEN
    RAISE EXCEPTION 'Emma claims are % not 1430500; live state differs', v_claims;
  END IF;

  SELECT float_balance_signed INTO v_before FROM public.v_user_wallet_strict WHERE user_id = c_agent;

  PERFORM public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object('user_id', c_agent, 'amount', 1428500, 'direction', 'cash_out',
        'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'category', 'agent_float_settlement',
        'classification', 'production', 'source_table', 'withdrawal_requests', 'source_id', c_wd,
        'reference_id', c_wd::text || '-merchant-float-consume-topup-cover', 'transaction_date', c_ts,
        'description', 'Float top-up TID158376088074 (3M) covered payout ' || c_wd || ' (doc 213, by SQL on Josh''s instruction)'),
      jsonb_build_object('user_id', c_agent, 'amount', 1428500, 'direction', 'cash_in',
        'ledger_scope', 'platform', 'category', 'agent_float_settlement',
        'classification', 'production', 'source_table', 'withdrawal_requests', 'source_id', c_wd,
        'reference_id', c_wd::text || '-merchant-float-consume-topup-cover', 'transaction_date', c_ts,
        'description', 'Merchant float settled to customer for withdrawal ' || c_wd || ' (top-up cover, doc 213)'),
      jsonb_build_object('user_id', c_agent, 'amount', 2000, 'direction', 'cash_out',
        'ledger_scope', 'wallet', 'wallet_bucket', 'float', 'category', 'agent_float_settlement',
        'classification', 'production', 'source_table', 'withdrawal_requests', 'source_id', c_wd,
        'reference_id', c_wd::text || '-merchant-telecom-charge', 'transaction_date', c_ts,
        'description', 'Telecom sending charge for merchant cash-out ' || c_wd || ' (doc 213)'),
      jsonb_build_object('user_id', c_agent, 'amount', 2000, 'direction', 'cash_in',
        'ledger_scope', 'platform', 'category', 'agent_float_settlement',
        'classification', 'production', 'source_table', 'withdrawal_requests', 'source_id', c_wd,
        'reference_id', c_wd::text || '-merchant-telecom-charge', 'transaction_date', c_ts,
        'description', 'Telecom sending charge recovered from merchant float for withdrawal ' || c_wd || ' (doc 213)')
    ),
    idempotency_key := 'doc213-emma-topup-covers-payout:' || c_wd,
    skip_balance_check := true);

  SELECT float_balance_signed INTO v_after FROM public.v_user_wallet_strict WHERE user_id = c_agent;
  IF v_before - v_after <> 1430500 THEN
    RAISE EXCEPTION 'float moved by % instead of 1430500; rolling back', v_before - v_after;
  END IF;

  UPDATE public.merchant_out_of_pocket_advances
     SET status = 'rejected', reviewed_at = now(),
         review_note = 'COVERED BY FLOAT TOP-UP 2026-10-09 (doc 213): the 3M float TID158376088074 was sent to cover this payout; float consumption booked, company owes nothing (Josh).',
         updated_at = now()
   WHERE withdrawal_id = c_wd AND status = 'pending_reimbursement'
     AND attested_at IS NULL AND reimbursed_at IS NULL;

  PERFORM public.reconcile_wallet_from_ledger(c_agent);
END $$;
