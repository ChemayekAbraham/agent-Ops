-- Agent Advance accounting: activate the account mappings.
--
-- Reference data only. No ledger entry, no balance, no wallet movement. These
-- rows are inert until code posts under these categories, and no code does yet.
--
-- DIRECTIONS TESTED BEFORE ACTIVATION
-- -----------------------------------
-- Each mapping was simulated against real production amounts (advance
-- 7612edc4: principal 5,100,000, access fee 2,295,000, registration fee
-- 20,000; the 408 penalty accrual of 2026-09-26; a 420 repayment; and a
-- 685,000 write-off). All four groups balance on mapped accounts AND on raw
-- cash_in/cash_out, so create_ledger_transaction accepts them:
--
--   Origination  DR A10 5,100,000 + A11 2,295,000 + A20 20,000
--                CR L1 5,100,000 + R1 2,315,000                     -> balances
--                receivables 7,415,000 = operational outstanding exactly
--   Penalty      DR A10 408 / CR L8 408                             -> balances, no P&L
--   Repayment    DR L1 420 + L8 31 / CR A10 288 + A11 108 + A20 24 + R1 31
--                                                                   -> balances
--   Write-off    DR X4 685,000 / CR A10 500,000 + A11 165,000 + A20 20,000
--                                                                   -> balances
--
-- All twelve categories are already in ledger_category_allowlist() (migration
-- 20260926123000), so strict_mode accepts them. A20 and L8 exist (migration
-- 20260926140000).
--
-- DELIBERATELY NOT CREATED
-- ------------------------
-- `agent_advance_fee_revenue` is HELD. It carries two economically distinct
-- credits -- origination fee income and released penalty income -- and CFO
-- decision 2 (penalty income to R1 or a dedicated R2) is still open. If
-- penalty income is separated, this must become two categories rather than
-- one. Activating it now would force that choice by default. Until it exists
-- no origination-fee or penalty-collection entry can post, which is the
-- intended state.
--
-- Convention: debit_when = 'cash_out' throughout, so a leg posted cash_out
-- debits the account and a leg posted cash_in credits it. This matches the
-- existing agent_advance_repayment -> A10 row.

INSERT INTO public.ledger_account_map
  (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
VALUES
  -- Origination and top-up: principal raises the advances receivable.
  ('platform', 'agent_advance_disbursement', NULL, 'A10', 'cash_out',
   'Agent Advance principal advanced. Replaces the rent_disbursement + source_table exception; posted cash_out to debit A10.'),

  -- Fees charged at origination.
  ('platform', 'agent_advance_access_fee_charged', NULL, 'A11', 'cash_out',
   'Access fee charged at origination or on a top-up/re-term increase. Debits A11.'),
  ('platform', 'agent_advance_registration_fee_charged', NULL, 'A20', 'cash_out',
   'Flat registration fee charged at origination. Debits A20.'),

  -- Penalty: receivable now, income only on collection (CFO decision 4).
  ('platform', 'agent_advance_penalty_accrued', NULL, 'A10', 'cash_out',
   'Overdue penalty capitalised into the advance balance. Debits A10; the counterpart is L8, not revenue.'),
  ('platform', 'agent_advance_penalty_unearned', NULL, 'L8', 'cash_out',
   'Unearned penalty income. Credited on accrual, debited on collection or write-off. Produces no P&L until collected.'),

  -- Repayment allocation (four-way pro rata, CFO decision 3).
  ('platform', 'agent_advance_access_fee_collected', NULL, 'A11', 'cash_out',
   'Access-fee share of a repayment. Posted cash_in to credit A11.'),
  ('platform', 'agent_advance_registration_fee_collected', NULL, 'A20', 'cash_out',
   'Registration-fee share of a repayment. Posted cash_in to credit A20. Distinct from registration_fee_collected, which maps to R1.'),

  -- Write-off (CFO decision 5: unresolved clawbacks are write-offs, not reversals).
  ('platform', 'agent_advance_written_off', NULL, 'A10', 'cash_out',
   'Principal and capitalised penalty de-recognised on write-off. Credits A10 against X4; the penalty portion is offset by a DR to L8, so it carries no P&L.'),
  ('platform', 'agent_advance_access_fee_written_off', NULL, 'A11', 'cash_out',
   'Access-fee receivable de-recognised on write-off or reversal. Credits A11.'),
  ('platform', 'agent_advance_registration_fee_written_off', NULL, 'A20', 'cash_out',
   'Registration-fee receivable de-recognised on write-off or reversal. Credits A20.'),

  -- Reversal on settlement of the clawback.
  ('platform', 'agent_advance_reversed', NULL, 'A10', 'cash_out',
   'Principal de-recognised when an advance is reversed and the clawback has actually settled. Credits A10.'),

  -- Wallet side of a clawback. Matches the existing wallet fallback (L1 /
  -- cash_out) but is stated explicitly so it no longer depends on it.
  ('wallet', 'agent_advance_clawback', NULL, 'L1', 'cash_out',
   'Wallet side of an advance clawback: debits customer custody payable. Amount and bucket are unchanged from the executed movement.')
ON CONFLICT DO NOTHING;
