-- The cash flow now resolves every leg through the shared Balance Sheet resolver,
-- which walks the full ledger history (~560k legs, ~7s). Give the report its own
-- statement timeout so PostgREST does not cancel it. Read-only report function.
ALTER FUNCTION public.get_statement_of_cash_flows(timestamp with time zone, timestamp with time zone)
  SET statement_timeout = '120s';