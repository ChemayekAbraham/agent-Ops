-- Balance sheet imbalance of UGX 760,000 introduced on 2026-09-01.
--
-- ── What broke ──────────────────────────────────────────────────────────────
--
-- Migration 20260901185538 ("Self-support funding source: operational float
-- instead of withdrawable") changed the wallet leg of partner self-support
-- funding from wallet_bucket 'withdrawable' to 'float'. That was an intentional
-- OPERATIONAL change and the funding source really is operational float now.
--
-- But wallet_bucket is not only descriptive. In sofp_ledger_legs() an unmapped
-- wallet leg is resolved by a bucket-driven fallback, and the two branches carry
-- OPPOSITE debit conventions:
--
--   wallet_bucket 'float'   -> account A2, debit_when 'cash_in'
--   wallet_bucket otherwise -> account L1, debit_when 'cash_out'
--
-- Neither 'supporter_rent_fund' nor wallet-scope 'partner_funding' had a
-- ledger_account_map row, so both relied entirely on that fallback. Switching
-- the bucket therefore silently moved the leg from L1 to A2 AND inverted its
-- debit/credit side. Both legs of each entry landed on the same side:
--
--   platform.partner_funding   (cash_in)         -> CREDIT L2   (correct)
--   wallet.supporter_rent_fund (cash_out, float) -> CREDIT A2   (wrong: was DEBIT L1)
--
-- Because these groups hold one cash_in and one cash_out leg of equal size,
-- raw_net = 0, so the E4 one-sided counterpart in sofp_ledger_legs() is never
-- raised (its HAVING requires abs(MAX(raw_net)) > 0.5). The residual passed
-- straight into the balance check instead of being absorbed or flagged.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
--
-- Give both categories an explicit wallet-scope mapping. An explicit row wins
-- over the bucket fallback (COALESCE(mb, mw, fallback) in sofp_ledger_legs), so
-- the leg resolves to L1/cash_out regardless of which bucket it carries. The
-- 'float' tag is preserved untouched as the operational funding-source/audit
-- attribute it was introduced to be.
--
-- This restores the treatment used by every one of the 1,633 historical
-- partner_funding wallet legs since 2024-04-01:
--
--   DR L1 Wallet Custody Payable / CR L2 Partner Portfolios — Capital Held
--
-- and its exact mirror for a reversal: DR L2 / CR L1.
--
-- Economic substance: no cash enters or leaves the business (these groups have
-- no A1 leg). An obligation to return funds to the partner on demand becomes an
-- obligation to the partner as committed capital — a reclassification between
-- two liabilities, which is why no asset account should move.
--
-- ── Blast radius, measured before applying ──────────────────────────────────
--
--   category            bucket        legs   amount          resolution
--   partner_funding     (null)        1011   2,519,066,842   L1/cash_out  UNCHANGED
--   partner_funding     withdrawable   623   1,657,232,855   L1/cash_out  UNCHANGED
--   supporter_rent_fund (null)          25      49,027,208   L1/cash_out  UNCHANGED
--   supporter_rent_fund withdrawable      7       3,400,000   L1/cash_out  UNCHANGED
--   partner_funding     float             1         100,000   A2 -> L1     CHANGES
--   supporter_rent_fund float             4         480,000   A2 -> L1     CHANGES
--
-- 1,666 legs (UGX 4.23bn) already resolve to L1/cash_out through the fallback,
-- which these rows reproduce exactly, so they are unaffected. Only the 5 legs of
-- the 5 broken groups change. Both rows are wallet-scope; the existing
-- ('platform','partner_funding' -> L2) mapping is NOT touched.
--
-- No general_ledger row, amount, date, party, source record or bucket tag is
-- modified. This is a reporting-resolution mapping only, and it applies to all
-- future supporter_rent_fund / wallet partner_funding legs automatically.

INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
VALUES
  ('wallet', 'supporter_rent_fund', NULL, 'L1', 'cash_out',
   'Partner self-support funding drawn from the partner''s balance. Reclassifies wallet custody (L1) into partner capital (L2) on the paired platform leg; no asset moves. Explicit row so the resolution no longer depends on wallet_bucket, which is an operational funding-source tag.'),
  ('wallet', 'partner_funding', NULL, 'L1', 'cash_out',
   'Wallet-scope counterpart of partner funding (and its reversal). Matches the treatment of all historical partner_funding wallet legs. The platform-scope partner_funding -> L2 mapping is unchanged.')
ON CONFLICT (ledger_scope, category, COALESCE(wallet_bucket, '*')) DO UPDATE
  SET account_code = EXCLUDED.account_code,
      debit_when   = EXCLUDED.debit_when,
      notes        = EXCLUDED.notes;

-- ── Verification (run before and after; both must hold) ─────────────────────
--
-- 1. The five affected groups each net to zero:
--
--    SELECT transaction_group_id, SUM(dr) - SUM(cr) AS resid
--      FROM public.sofp_ledger_legs(now())
--     WHERE transaction_group_id IN (
--       '96ffcc21-e0f4-4429-b7d9-e5e384b475b0','064d8550-1c3b-4918-93f3-2846d2c3f02d',
--       '4d2de19f-51e8-46bb-b5ac-b6f1b9d93e8b','f0e6cce6-ea14-409b-b9d3-266a4fd3550c',
--       '2404a4f1-e6b7-4e11-a88a-0ec243e03fe6')
--     GROUP BY 1;
--
-- 2. Nothing before 2026-09-01 moves. This control must be byte-identical
--    before and after:
--
--    SELECT account_code, ROUND(SUM(dr)) dr, ROUND(SUM(cr)) cr
--      FROM public.sofp_ledger_legs('2026-08-13'::timestamptz) GROUP BY 1 ORDER BY 1;
--
-- 3. The statement balances:
--
--    SELECT public.get_statement_of_financial_position(now());
