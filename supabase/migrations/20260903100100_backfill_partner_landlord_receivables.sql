-- Part 2 of 2 — Dated backfill recognising Partner and Landlord receivables.
-- BIS approved. Requires 20260903100000 (accounts, allowlist, mappings) first.
--
-- ── How this posts ──────────────────────────────────────────────────────────
--
-- Through public.create_ledger_transaction(entries, idempotency_key,
-- skip_balance_check) - the only sanctioned write path. general_ledger carries
-- trg_enforce_ledger_rpc_only, which rejects any INSERT that does not set
-- ledger.authorized, so a raw INSERT would be blocked by design. The RPC also
-- honours per-entry transaction_date, classification and source_table, which is
-- what makes a dated, auditable backfill possible.
--
-- Each record posts its own two-leg group, dated at that record's own date, not
-- one lump sum. Amounts are read from the sub-ledger; nothing is hardcoded.
--
-- ── Journal entries ─────────────────────────────────────────────────────────
--
--   Per promissory note, amount = amount - total_collected
--     DR A7  bridge.partner_receivable_created        (cash_in)
--     CR L2  platform.partner_receivable_capital      (cash_out)
--
--   Per Welile Homes subscription, amount = outstanding_balance
--     DR A6  bridge.landlord_receivable_created       (cash_in)
--     CR L4  platform.landlord_receivable_obligation  (cash_out)
--
-- One cash_in leg and one cash_out leg of equal size per group, so
-- trg_enforce_ledger_group_balance is satisfied without skip_balance_check.
--
-- ── No double recognition ───────────────────────────────────────────────────
--
-- Partner  : total_collected is 0 on every note, so amount - total_collected is
--            the full promise and no collected amount is re-recognised. The
--            only existing promissory_notes ledger legs are agent_commission /
--            marketing_expense (UGX 478,000) which are commission, not
--            principal, and are untouched.
-- Landlord : outstanding_balance is already net of collections.
--            receivable_total 32,520,000 - outstanding 31,445,000 = 1,075,000,
--            which reconciles exactly to the rent_repayment legs already in the
--            ledger. Recognising outstanding_balance therefore recognises only
--            the uncollected part.
--
-- Idempotency is enforced twice: a deterministic idempotency_key per record,
-- and a NOT EXISTS guard on (source_id, category). Re-running posts nothing.

DO $do$
DECLARE
  r           record;
  v_amount    numeric;
  v_when      timestamptz;
  v_entries   jsonb;
  v_partner_n int := 0;  v_partner_amt numeric := 0;
  v_land_n    int := 0;  v_land_amt    numeric := 0;
BEGIN
  -- ── Partner receivables ───────────────────────────────────────────────────
  FOR r IN
    SELECT id, partner_name, amount, total_collected, status, approved_at, created_at
    FROM public.promissory_notes
    WHERE status IN ('pending','activated')
      AND GREATEST(COALESCE(amount,0) - COALESCE(total_collected,0), 0) > 0
    ORDER BY COALESCE(approved_at, created_at)
  LOOP
    v_amount := GREATEST(COALESCE(r.amount,0) - COALESCE(r.total_collected,0), 0);
    v_when   := COALESCE(r.approved_at, r.created_at, now());

    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.general_ledger
      WHERE source_id = r.id AND category = 'partner_receivable_created'
    );

    v_entries := jsonb_build_array(
      jsonb_build_object(
        'ledger_scope','bridge', 'category','partner_receivable_created',
        'direction','cash_in', 'amount', v_amount,
        'classification','production', 'transaction_date', v_when,
        'source_table','promissory_notes', 'source_id', r.id,
        'description', format('Promissory note receivable recognised — %s (%s)',
                              COALESCE(NULLIF(r.partner_name,''),'partner'), r.status)),
      jsonb_build_object(
        'ledger_scope','platform', 'category','partner_receivable_capital',
        'direction','cash_out', 'amount', v_amount,
        'classification','production', 'transaction_date', v_when,
        'source_table','promissory_notes', 'source_id', r.id,
        'description', format('Partner capital obligation on note — %s',
                              COALESCE(NULLIF(r.partner_name,''),'partner')))
    );

    PERFORM public.create_ledger_transaction(
      entries => v_entries,
      idempotency_key => 'partner_recv_backfill:' || r.id::text,
      skip_balance_check => false);

    v_partner_n := v_partner_n + 1;  v_partner_amt := v_partner_amt + v_amount;
  END LOOP;

  -- ── Landlord receivables ──────────────────────────────────────────────────
  FOR r IN
    SELECT id, landlord_name, outstanding_balance, created_at
    FROM public.welile_homes_subscriptions
    WHERE subscription_status = 'active'
      AND COALESCE(outstanding_balance,0) > 0
    ORDER BY created_at
  LOOP
    v_amount := COALESCE(r.outstanding_balance,0);
    v_when   := COALESCE(r.created_at, now());

    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.general_ledger
      WHERE source_id = r.id AND category = 'landlord_receivable_created'
    );

    v_entries := jsonb_build_array(
      jsonb_build_object(
        'ledger_scope','bridge', 'category','landlord_receivable_created',
        'direction','cash_in', 'amount', v_amount,
        'classification','production', 'transaction_date', v_when,
        'source_table','welile_homes_subscriptions', 'source_id', r.id,
        'description', format('Welile Homes subscription receivable recognised — %s',
                              COALESCE(NULLIF(r.landlord_name,''),'landlord'))),
      jsonb_build_object(
        'ledger_scope','platform', 'category','landlord_receivable_obligation',
        'direction','cash_out', 'amount', v_amount,
        'classification','production', 'transaction_date', v_when,
        'source_table','welile_homes_subscriptions', 'source_id', r.id,
        'description', format('Landlord rent obligation on subscription — %s',
                              COALESCE(NULLIF(r.landlord_name,''),'landlord')))
    );

    PERFORM public.create_ledger_transaction(
      entries => v_entries,
      idempotency_key => 'landlord_recv_backfill:' || r.id::text,
      skip_balance_check => false);

    v_land_n := v_land_n + 1;  v_land_amt := v_land_amt + v_amount;
  END LOOP;

  RAISE NOTICE 'Partner receivables recognised: % notes, UGX %', v_partner_n, v_partner_amt;
  RAISE NOTICE 'Landlord receivables recognised: % subscriptions, UGX %', v_land_n, v_land_amt;
END
$do$;

-- ── Reconciliation (run after applying) ─────────────────────────────────────
--
-- 1. Partner ledger balance equals the sub-ledger:
--
--    SELECT
--      (SELECT ROUND(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END))
--         FROM general_ledger WHERE category='partner_receivable_created')      AS a7_recognised,
--      (SELECT ROUND(SUM(GREATEST(COALESCE(amount,0)-COALESCE(total_collected,0),0)))
--         FROM promissory_notes WHERE status IN ('pending','activated'))         AS sub_ledger;
--
-- 2. Landlord ledger balance equals the sub-ledger:
--
--    SELECT
--      (SELECT ROUND(SUM(CASE WHEN direction='cash_in' THEN amount ELSE -amount END))
--         FROM general_ledger WHERE category='landlord_receivable_created')     AS a6_recognised,
--      (SELECT ROUND(SUM(COALESCE(outstanding_balance,0)))
--         FROM welile_homes_subscriptions WHERE subscription_status='active')    AS sub_ledger;
--
-- 3. Nothing recognised twice:
--
--    SELECT source_id, category, COUNT(*) FROM general_ledger
--     WHERE category IN ('partner_receivable_created','landlord_receivable_created')
--     GROUP BY 1,2 HAVING COUNT(*) > 1;   -- expect zero rows
--
-- 4. Balance sheet still balances (assets and liabilities both rise by the same
--    amount, so the check is unchanged):
--
--    SELECT ROUND(SUM(dr)-SUM(cr)) FROM public.sofp_ledger_legs(now());  -- expect 0
