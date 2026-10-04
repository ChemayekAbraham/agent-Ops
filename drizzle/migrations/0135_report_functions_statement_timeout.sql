-- Reporting-only change: the financial statement builders scan the whole
-- general_ledger (≈560k legs, ~17s per resolver pass) and therefore exceed the
-- 8s statement_timeout carried by the `authenticated` role, surfacing as
-- "canceling statement due to statement timeout" in the CFO dashboard.
-- get_statement_of_cash_flows already carries a function-level override
-- (migration 0133); this extends the same override to the other statement
-- builders. No accounting logic, mapping, ledger data or definition changes.

ALTER FUNCTION public.sofp_ledger_legs(timestamp with time zone)
  SET statement_timeout = '120s';

ALTER FUNCTION public.get_statement_of_financial_position(timestamp with time zone)
  SET statement_timeout = '120s';

ALTER FUNCTION public.get_financial_statement_ledger_sums(timestamp with time zone, timestamp with time zone)
  SET statement_timeout = '120s';

ALTER FUNCTION public.get_landlord_float_management_split(timestamp with time zone)
  SET statement_timeout = '120s';

ALTER FUNCTION public.get_receivables_total()
  SET statement_timeout = '120s';

ALTER FUNCTION public.get_platform_cash_summary()
  SET statement_timeout = '120s';

ALTER FUNCTION public.get_platform_cash_breakdown()
  SET statement_timeout = '120s';

ALTER FUNCTION public.get_treasury_cash_position(timestamp with time zone)
  SET statement_timeout = '120s';

ALTER FUNCTION public.get_outstanding_agent_float()
  SET statement_timeout = '120s';

ALTER FUNCTION public.get_wallet_ledger_category_sums(timestamp with time zone, timestamp with time zone)
  SET statement_timeout = '120s';

ALTER FUNCTION public.get_cfo_cash_movement_rows(timestamp with time zone, timestamp with time zone, integer)
  SET statement_timeout = '120s';
