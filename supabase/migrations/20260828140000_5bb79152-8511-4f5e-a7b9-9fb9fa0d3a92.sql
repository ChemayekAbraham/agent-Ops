-- The "Budget category" field on the department budget submission form was
-- empty for every department, so no department could file a budget at all.
--
-- The field is populated from ledger_account_catalog, whose only SELECT
-- policy (20260815102716) restricts reads to finance and executive roles:
--
--   has_role(cfo) OR has_role(ceo) OR has_role(coo) OR has_role(manager)
--   OR has_role(financial_ops) OR has_role(super_admin) OR has_role(cto)
--
-- Ordinary department staff hold none of those, so the query returned zero
-- rows and the dropdown rendered with no options. The failure was invisible
-- from a finance account, which does hold a listed role and sees the full
-- catalogue - which is why the budget cycle could be created and its
-- notifications delivered while every recipient hit a dead end.
--
-- Fix: let any authenticated user read the accounts they are permitted to
-- budget against, and only those. The predicate is deliberately identical to
-- budget_is_budgetable_account(), which budget_save_draft enforces on every
-- line, so the options offered and the values accepted cannot drift apart.
--
-- Permissive SELECT policies are OR'd, so the finance/executive policy is
-- untouched and those roles keep full visibility of the chart of accounts.
-- Everyone else gains expense and non-current-asset rows only: no revenue,
-- equity, liability or current-asset accounts, and no amounts - this table
-- holds account definitions, not balances.

DROP POLICY IF EXISTS "Staff read budgetable spending categories"
  ON public.ledger_account_catalog;

CREATE POLICY "Staff read budgetable spending categories"
ON public.ledger_account_catalog FOR SELECT TO authenticated
USING (nature = 'expense' OR section = 'non_current_asset');
