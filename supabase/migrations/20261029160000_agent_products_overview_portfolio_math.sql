-- Agent products overview (Smart phones etc.): three figures were wrong.
--  1. "Active field fleet" counted orders still waiting on the COO / CFO (ops_approved, coo_approved).
--     They have not been handed over and already show under "In Progress"; they also showed as
--     "1 fully paid" because a not-yet-issued order has no balance. They are now excluded.
--  2. "Financial portfolio" (outstanding) is the repayment-plan balance, which includes the plan
--     markup, yet it was shown against the phone price ("Total invested") and the recovery rate was
--     repaid / phone price. Both mixed two bases. in_field_repayable = repaid + outstanding is now
--     returned so the card can show progress against what is actually owed.
--  3. in_field_fully_paid counts only holders who have paid something and owe nothing.
DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.get_agent_products_overview(text)'::regprocedure);
  v_new text;
BEGIN
  v_new := replace(v_def,
    $a$ARRAY['pending_approval','submitted','rejected','cancelled','declined'];$a$,
    $a$ARRAY['pending_approval','submitted','rejected','cancelled','declined','ops_approved','coo_approved'];$a$);
  IF v_new = v_def THEN RAISE EXCEPTION 'excluded-status anchor not found'; END IF;

  v_def := v_new;
  v_new := replace(v_def,
    $a$'in_field_repaid', COALESCE((SELECT SUM(repaid_amount) FROM per_agent), 0),$a$,
    $a$'in_field_repaid', COALESCE((SELECT SUM(repaid_amount) FROM per_agent), 0),
      'in_field_repayable', COALESCE((SELECT SUM(repaid_amount + outstanding_amount) FROM per_agent), 0),
      'in_field_fully_paid', COALESCE((SELECT COUNT(*) FROM per_agent WHERE repaid_amount > 0 AND outstanding_amount <= 0), 0),$a$);
  IF v_new = v_def THEN RAISE EXCEPTION 'repaid anchor not found'; END IF;

  EXECUTE v_new;
END
$mig$;
