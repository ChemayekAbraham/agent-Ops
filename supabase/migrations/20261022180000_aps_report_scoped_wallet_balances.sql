-- Speed up get_agent_products_services_report(date, date): ~8s -> ~2.8s per call.
--
-- 95% of the time went into `LEFT JOIN v_user_wallet_strict w` in agent_float_rows. That view
-- aggregates every wallet in general_ledger before filtering (its CTEs are referenced twice,
-- so they are materialised and the user filter cannot be pushed down). The report only needs
-- the ~700 agents it lists, so it now calls _wallet_strict_for_users_impl(uuid[]), the same
-- strict wallet logic scoped to the given users, once with the report's agent ids.
--
-- Verified on production 2026-10-22: identical withdrawable/float balances for all 699 agents,
-- and identical report output apart from the order of tied rows in agent_float_rows (rows
-- sorted by collections_amount, ties were already unordered).
--
-- The live function body is not in this repo, so this edits it in place: replace exactly one
-- occurrence of the join, or fail.

DO $$
DECLARE
  v_def  text := pg_get_functiondef('public.get_agent_products_services_report(date,date)'::regprocedure);
  v_from text := 'LEFT JOIN v_user_wallet_strict w ON w.user_id = a.id';
  v_to   text := 'LEFT JOIN public._wallet_strict_for_users_impl((SELECT array_agg(ag.id) FROM agents ag)) w ON w.user_id = a.id';
  v_n    int;
BEGIN
  IF position(v_to IN v_def) > 0 THEN
    RAISE NOTICE 'already applied';
    RETURN;
  END IF;
  v_n := (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 v_user_wallet_strict join, found %', v_n;
  END IF;
  EXECUTE replace(v_def, v_from, v_to);
END $$;
