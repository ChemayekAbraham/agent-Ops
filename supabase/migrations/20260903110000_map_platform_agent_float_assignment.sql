-- Clear the "Unclassified — flagged for review" block on the balance sheet.
--
-- ── What was flagged ────────────────────────────────────────────────────────
--
-- The flagged block showed A9 Suspense at (UGX 15,000,000). Tracing every leg
-- that lands in A9 or L9 gave exactly three contributors:
--
--   platform.agent_float_assignment   3 legs   (15,000,000)   UNMAPPED
--   bridge.orphan_reassignment        1 leg      1,000,000    mapped to A9 by design
--   bridge.orphan_reversal            1 leg     (1,000,000)   mapped to A9 by design
--
-- The orphan pair is a reassignment and its own reversal. Both are deliberately
-- routed to A9 and they net to zero, so the whole reported balance came from
-- the single unmapped category. L9 has no legs at all.
--
-- ── The three transactions ──────────────────────────────────────────────────
--
-- Three identical UGX 5,000,000 movements on 2026-09-02:
--
--   platform.agent_float_assignment  cash_out  "Bank float sent to Sky Bubbles
--                                               via Equity Bank Uganda"
--   wallet.agent_float_assignment    cash_in   "Float funded via Equity Bank
--                                               Uganda. TID: 432071..."
--
-- The wallet leg resolves correctly: float bucket -> A2, debit_when cash_in, so
-- a cash_in leg debits A2 and float rises. The platform leg had no
-- ledger_account_map row, so it fell to the A9 fallback and credited suspense
-- instead of the bank.
--
-- ── Treatment ───────────────────────────────────────────────────────────────
--
-- Identical to its sibling, which is already mapped:
--
--   platform.agent_float_deposit     -> A1  debit_when 'cash_in'   (existing)
--   platform.agent_float_assignment  -> A1  debit_when 'cash_in'   (this row)
--
-- Posted cash_out, that credits A1: bank cash leaving to fund agent float,
-- which is exactly what the description states.
--
-- ── Why no balance moves ────────────────────────────────────────────────────
--
-- The platform fallback debit_when is already 'cash_in' and this row maps it to
-- 'cash_in', so the debit/credit SIDE of each leg is unchanged - the leg still
-- credits. Only the account changes, A9 -> A1, and both are current assets.
-- Total debits, total credits, total assets and the balance check are therefore
-- untouched by construction; the 15,000,000 simply moves out of suspense and
-- into bank cash, where it belongs.
--
-- After this, A9 nets to zero and the flagged block no longer renders.

INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
VALUES ('platform', 'agent_float_assignment', NULL, 'A1', 'cash_in',
        'Bank cash sent out to fund an agent float assignment. Mirrors platform.agent_float_deposit: the platform leg is posted cash_out, which against debit_when cash_in credits A1 and reduces bank cash, while the paired wallet float leg debits A2. Without this row the leg fell to the A9 suspense fallback.')
ON CONFLICT (ledger_scope, category, COALESCE(wallet_bucket, '*')) DO UPDATE
  SET account_code = EXCLUDED.account_code,
      debit_when   = EXCLUDED.debit_when,
      notes        = EXCLUDED.notes;

-- ── Verification ────────────────────────────────────────────────────────────
--
-- A9 and L9 should now net to zero, with only the self-cancelling orphan pair
-- remaining:
--
--   WITH resolved AS (
--     SELECT gl.direction dir, gl.amount amt,
--            COALESCE(mb.account_code, mw.account_code,
--              CASE WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket='float' THEN 'A2'
--                   WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket='advance' THEN 'A4'
--                   WHEN gl.ledger_scope='wallet' THEN 'L1' ELSE 'A9' END) AS acct,
--            COALESCE(mb.debit_when, mw.debit_when,
--              CASE WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
--                   WHEN gl.ledger_scope='wallet' THEN 'cash_out' ELSE 'cash_in' END) AS dw
--       FROM general_ledger gl
--       LEFT JOIN ledger_account_map mb ON mb.ledger_scope=gl.ledger_scope AND mb.category=gl.category
--             AND mb.wallet_bucket IS NOT NULL AND mb.wallet_bucket=gl.wallet_bucket
--       LEFT JOIN ledger_account_map mw ON mw.ledger_scope=gl.ledger_scope AND mw.category=gl.category
--             AND mw.wallet_bucket IS NULL
--      WHERE gl.classification IN ('production','legacy_real'))
--   SELECT acct, COUNT(*) legs, ROUND(SUM(CASE WHEN dir=dw THEN amt ELSE -amt END)) net_debit
--     FROM resolved WHERE acct IN ('A9','L9') GROUP BY 1;
--   -- expect A9: 2 legs, net_debit 0
