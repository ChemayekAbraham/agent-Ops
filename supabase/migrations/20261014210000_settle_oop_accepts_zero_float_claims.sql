-- settle_merchant_out_of_pocket accepts zero-float payout claims (doc 230).
--
-- APPLIED BY HAND to production on 2026-10-14 (Josh); this file records it so the
-- repo matches. Do not re-run blindly: the marker check aborts once patched.
--
-- The RPC re-derives evidence itself (its own copy of the view's rule), so after
-- doc 228 it still skipped zero-float claims as `not_evidenced_by_books`.
-- Same two changes as doc 228: position <= 0 counts as evidenced, and at exactly
-- 0 the whole shortfall is the evidenced amount. Estimated telecom claims are
-- still skipped (unchanged).

DO $$
DECLARE
  v_def text;
  v_a text := 'v_row.float_position_at_payout < 0;';
  v_b text := 'ELSE LEAST(v_row.shortfall_amount, GREATEST(0, -v_row.float_position_at_payout))';
BEGIN
  v_def := pg_get_functiondef('public.settle_merchant_out_of_pocket(uuid[],text)'::regprocedure);
  IF (length(v_def)-length(replace(v_def,v_a,'')))/length(v_a) <> 1
     OR (length(v_def)-length(replace(v_def,v_b,'')))/length(v_b) <> 1 THEN
    RAISE EXCEPTION 'settle_merchant_out_of_pocket: markers not found exactly once';
  END IF;
  v_def := replace(v_def, v_a, 'v_row.float_position_at_payout <= 0; /* doc 230 */');
  v_def := replace(v_def, v_b,
    'WHEN v_row.float_position_at_payout = 0 THEN v_row.shortfall_amount ' || v_b);
  EXECUTE v_def;
END
$$;
