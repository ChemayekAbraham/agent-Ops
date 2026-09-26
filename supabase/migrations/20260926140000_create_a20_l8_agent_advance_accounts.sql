-- Agent Advance accounting: create the two missing accounts.
--
-- Reference data only. No ledger entry, no mapping, no balance, no wallet
-- movement. Nothing can post to either account until ledger_account_map rows
-- exist, which is a separate change.
--
-- WHY THESE TWO
-- -------------
-- Of the UGX 52,290,254.30 that agents operationally owe, only the principal
-- component (31,970,532) has an account today. The remaining 20,319,722 of
-- access fees, registration fees and capitalised penalty exists only as fields
-- on `agent_advances` and appears nowhere in the financial statements.
--
--   A10 Agent Advances Receivable            already exists (principal + penalty)
--   A11 Agent Advance Access Fees Receivable already exists
--   A20 Agent Advance Registration Fees Receivable  <- created here
--   L8  Unearned Agent Advance Penalty Income       <- created here
--
-- A20 holds the registration fee charged at origination (flat 10,000 at or
-- below 200,000 principal, 20,000 above). CFO decision 2 of 2026-09-26 fixed
-- A20 as the account; the revenue recognition point is assumed to follow the
-- access fee (origination) and is flagged for confirmation.
--
-- L8 is the unearned-income counterpart to the penalty capitalised into A10.
-- CFO decision 4 of 2026-09-26: penalty accrues as a receivable but is
-- recognised as income only on collection, because it arises exclusively on
-- advances that are already in default (271 of 323 open advances are overdue).
-- L8 therefore fully offsets the A10 penalty component until cash is received,
-- producing no P&L on accrual and no P&L on write-off.
--
-- VERIFIED BEFORE WRITING THIS
-- ----------------------------
--   * Neither code appears in ledger_account_catalog, ledger_account_map,
--     ledger_accounts, ledger_account_groups or sofp_ledger_legs.
--   * get_statement_of_financial_position reads ledger_account_catalog
--     generically and contains no hardcoded account-code list, so both accounts
--     are picked up by the Balance Sheet on creation.
--   * ledger_account_catalog has no unique constraint on sort_order, so these
--     values disturb no existing row.
--
-- PLACEMENT
-- ---------
-- A20 takes sort_order 49 (the next free slot after A17=48) rather than 43,
-- which would require renumbering A12..A17. It therefore prints after the
-- Service Centre receivables instead of beside A10/A11. That is cosmetic; a
-- renumber can follow separately if the statement ordering matters.
-- L8 takes 60, free between L6=50 and L9=90.

INSERT INTO public.ledger_account_catalog (code, label, nature, section, sort_order)
VALUES
  ('A20', 'Agent Advance Registration Fees Receivable', 'asset',     'current_asset',      49),
  ('L8',  'Unearned Agent Advance Penalty Income',      'liability', 'current_liability',  60)
ON CONFLICT (code) DO NOTHING;
