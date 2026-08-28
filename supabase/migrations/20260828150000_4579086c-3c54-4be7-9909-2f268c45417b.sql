-- Departments still cannot see the "Budget category" options, so no
-- department can file a budget.
--
-- 20260828140000 added a SELECT policy on ledger_account_catalog for the
-- budgetable rows. That approach depends on RLS resolving as intended for
-- every department role, and on no one editing policies on that table
-- afterwards - the catalogue is finance-owned, and its original policy
-- deliberately restricts reads to finance and executive roles.
--
-- This removes the dependency instead of tuning it. A SECURITY DEFINER
-- function runs as its owner and bypasses RLS on the tables it reads, so
-- the budget form can offer spending categories without the caller needing
-- any read grant on the chart of accounts at all. It is the pattern already
-- used throughout this feature (budget_my_submissions,
-- budget_department_route, budget_user_department_ids).
--
-- The function exposes only what the budget form needs and only rows a
-- department may legitimately budget against. The predicate is identical to
-- budget_is_budgetable_account(), which budget_save_draft enforces on every
-- line, so the options offered and the values accepted cannot drift apart.
--
-- No amounts are exposed: ledger_account_catalog holds account definitions,
-- not balances. Revenue, equity, liability and current-asset accounts are
-- excluded, as they are not budgetable.
--
-- 20260828140000 is left in place. It is harmless alongside this, and
-- reverting it would need another migration for no benefit.

CREATE OR REPLACE FUNCTION public.budget_budgetable_accounts()
RETURNS TABLE (code text, label text, section text, nature text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.code, c.label, c.section, c.nature
    FROM public.ledger_account_catalog c
   WHERE c.nature = 'expense' OR c.section = 'non_current_asset'
   ORDER BY c.sort_order, c.code;
$$;

REVOKE EXECUTE ON FUNCTION public.budget_budgetable_accounts() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.budget_budgetable_accounts() FROM anon;
GRANT EXECUTE ON FUNCTION public.budget_budgetable_accounts() TO authenticated, service_role;
