-- Ensure the reconciliation view respects underlying table access rules.
ALTER VIEW public.wallet_ledger_truth_view SET (security_invoker = on);