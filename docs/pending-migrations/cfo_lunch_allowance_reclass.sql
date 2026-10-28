-- PENDING — NOT APPLIED. Requires CFO (Angwen Sarah) approval before running.
--
-- Purpose: append-only accounting correction for automated lunch allowance payments
-- that the cfo-direct-credit "expense" path posted on the platform side as
-- category system_balance_correction / classification admin_correction
-- (maps to E3 equity) instead of payroll_expense (maps to X1 operating expense).
--
-- Per eligible original platform leg (amount A) this posts ONE new balanced pair:
--   Dr X1 Operating expense   — platform, cash_out, payroll_expense,           production, A
--   Cr E3 Equity correction   — platform, cash_in,  system_balance_correction, production, A
-- Net effect: E3 nets to zero for these payments, X1 rises by A. Cash, wallets
-- (L1 custody), balances and the original rows are untouched.
--
-- Eligible = the Money Out rule `_cfo_paid_lunch_correction_ok` (matching wallet credit,
-- same amount, no reversal, no same-day duplicate). As at 2026-10-28: 219 legs,
-- UGX 798,000. Held: 1 same-day duplicate, UGX 3,000 (not reclassed; needs review).
--
-- Idempotent: one correction per original leg, keyed by source_id = original leg id.

CREATE TABLE IF NOT EXISTS public.cfo_lunch_reclass_log (
  original_leg_id uuid PRIMARY KEY,
  correction_group_id uuid NOT NULL,
  amount numeric NOT NULL,
  posted_by uuid NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.cfo_lunch_reclass_log TO authenticated;
GRANT ALL ON public.cfo_lunch_reclass_log TO service_role;
ALTER TABLE public.cfo_lunch_reclass_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY cfo_read ON public.cfo_lunch_reclass_log FOR SELECT TO authenticated
  USING ((select has_role((select auth.uid()), 'cfo'::app_role)) OR (select has_role((select auth.uid()), 'super_admin'::app_role)));
CREATE POLICY mfa_required_for_staff ON public.cfo_lunch_reclass_log AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));

-- Read-only preview (what would be posted).
CREATE OR REPLACE FUNCTION public.cfo_lunch_reclass_preview()
RETURNS TABLE(original_leg_id uuid, txn_date date, amount numeric, already_posted boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT (has_role(auth.uid(), 'cfo'::app_role) OR has_role(auth.uid(), 'super_admin'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY
  SELECT g.id, (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date, g.amount,
         EXISTS (SELECT 1 FROM cfo_lunch_reclass_log l WHERE l.original_leg_id = g.id)
  FROM general_ledger g
  WHERE g.direction = 'cash_out' AND g.classification = 'admin_correction'
    AND g.category = 'system_balance_correction' AND g.ledger_scope = 'platform'
    AND g.description ILIKE '%automated%lunch allowance%'
    AND public._cfo_paid_lunch_correction_ok(g.id, g.transaction_group_id, g.amount, g.transaction_date)
  ORDER BY g.transaction_date, g.id;
END $$;
REVOKE ALL ON FUNCTION public.cfo_lunch_reclass_preview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_lunch_reclass_preview() TO authenticated;

-- Post (CFO only, atomic, idempotent). Caller must pass the expected count and total
-- from the preview so a changed population aborts instead of posting.
CREATE OR REPLACE FUNCTION public.cfo_lunch_reclass_post(p_expected_count int, p_expected_total numeric, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r record; v_gid uuid; v_n int := 0; v_t numeric := 0; v_cn int; v_ct numeric;
BEGIN
  IF NOT has_role(auth.uid(), 'cfo'::app_role) THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF length(coalesce(btrim(p_reason), '')) < 10 THEN RAISE EXCEPTION 'reason must be at least 10 characters'; END IF;

  SELECT count(*), coalesce(sum(p.amount), 0) INTO v_cn, v_ct
  FROM cfo_lunch_reclass_preview() p WHERE NOT p.already_posted;
  IF v_cn <> p_expected_count OR v_ct <> p_expected_total THEN
    RAISE EXCEPTION 'population changed: % / % found, % / % expected', v_cn, v_ct, p_expected_count, p_expected_total;
  END IF;

  FOR r IN SELECT * FROM cfo_lunch_reclass_preview() p WHERE NOT p.already_posted LOOP
    v_gid := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('amount', r.amount, 'direction', 'cash_out', 'category', 'payroll_expense',
        'ledger_scope', 'platform', 'classification', 'production',
        'source_table', 'cfo_lunch_reclass', 'source_id', r.original_leg_id,
        'transaction_date', now(),
        'description', 'Lunch allowance reclass to operating expense (orig ' || r.original_leg_id || ', ' || r.txn_date || ')'),
      jsonb_build_object('amount', r.amount, 'direction', 'cash_in', 'category', 'system_balance_correction',
        'ledger_scope', 'platform', 'classification', 'production',
        'source_table', 'cfo_lunch_reclass', 'source_id', r.original_leg_id,
        'transaction_date', now(),
        'description', 'Lunch allowance reclass — reverse equity correction (orig ' || r.original_leg_id || ')')
    ), 'cfo_lunch_reclass:' || r.original_leg_id, false);
    INSERT INTO cfo_lunch_reclass_log(original_leg_id, correction_group_id, amount, posted_by)
    VALUES (r.original_leg_id, v_gid, r.amount, auth.uid());
    v_n := v_n + 1; v_t := v_t + r.amount;
  END LOOP;

  INSERT INTO audit_logs(action_type, table_name, record_id, reason, user_id, metadata)
  VALUES ('cfo_lunch_reclass_post', 'general_ledger', gen_random_uuid()::text, p_reason, auth.uid(),
          jsonb_build_object('count', v_n, 'total', v_t));
  INSERT INTO system_events(event_type, metadata)
  VALUES ('ledger_classification_backfilled', jsonb_build_object('kind', 'lunch_allowance_reclass', 'count', v_n, 'total', v_t));
  RETURN jsonb_build_object('posted', v_n, 'total', v_t);
END $$;
REVOKE ALL ON FUNCTION public.cfo_lunch_reclass_post(int, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_lunch_reclass_post(int, numeric, text) TO authenticated;

-- Money Out follow-up (same migration, so nothing is counted twice):
-- the original correction legs keep counting via _cfo_paid_lunch_correction_ok only
-- while NOT in cfo_lunch_reclass_log; once reclassed, the new production
-- payroll_expense leg (Operational Expenses, type "Payroll Expense") is what counts.
-- The posting date of the new leg is today, so Money Out will need to report it on the
-- ORIGINAL payment date (via cfo_lunch_reclass_log) to keep 21–28 Oct totals unchanged.
-- Exact RPC edits to be written after approval of the accounting entries above.

-- NOTE before applying: verify audit_logs / system_events column names and the
-- create_ledger_transaction(entries, idempotency_key, skip_balance_check) contract
-- against the live schema, per project guardrails.
