-- Financial Ops "owed to agent" counts zero-float payout claims (doc 229).
--
-- APPLIED BY HAND to production on 2026-10-14 (Josh); this file records it so the
-- repo matches. Do not re-run blindly: the marker check aborts once patched.
--
-- get_merchant_float_positions builds owed_to_agent from the `unbacked` CTE:
-- pending claims whose float position at payout time is strictly < 0. Doc 228
-- fixed the same strict test in v_merchant_oop_evidence, but this RPC has its
-- own copy, so a desk that paid out with exactly zero float (Immaculate,
-- 14 Oct: 15 bank payouts, UGX 12,727,500) showed nothing owed on the card.
--
-- Change: `< 0` becomes `<= 0` in that one expression. Marker replace on the
-- LIVE definition; aborts unless the marker occurs exactly once. Positive
-- positions (float covered the payout) are untouched.
--
-- Measured before applying (pending, unreimbursed claims at position = 0):
-- Immaculate 12,939,400 (payouts 12,841,500 + fees 97,900), Nabbaale Claire
-- 8,545,450 (was 89,200), Emma Maiso 2,751,681 (was 0).
-- Not in critical_function_baselines (checked 2026-10-14).

DO $mig$
DECLARE
  v_def text;
  v_marker constant text := 'o.created_at)) < 0';
BEGIN
  v_def := pg_get_functiondef('public.get_merchant_float_positions(boolean)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_marker, ''))) / length(v_marker) <> 1 THEN
    RAISE EXCEPTION 'get_merchant_float_positions: position marker not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_marker, 'o.created_at)) <= 0 /* doc 229 */');
END
$mig$;
