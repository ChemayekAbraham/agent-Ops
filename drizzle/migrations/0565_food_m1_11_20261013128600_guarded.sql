DO $fm1guard_outer$
DECLARE
  s text := $fm1guard$-- Food M1 — keep canteen payments out of Shopping Advance qualification.
--
-- PENDING, NOT APPLIED ANYWHERE LIVE. Held outside supabase/migrations/ because
-- adding it there applies it to production. Apply after
-- 20261013128000_food_payment_after_receipt (needs public.food_payment_attempts),
-- only with separate approval.
--
-- WHY. A Food wallet payment (food_pay_order) is posted as an ordinary pair of
-- `wallet_transfer` legs: employee cash_out, Food Coordinator cash_in, reference
-- 'FOODPAY-<order>' (attempt n>1: 'FOODPAY-<order>-A<n>').
-- _shopping_advance_received_24h() (drizzle 0533) counts EVERY positive wallet
-- `wallet_transfer` cash_in of the last 24 hours as a received transfer, so each
-- canteen payment would make the coordinator a Shopping Advance qualified sender
-- and raise their access limit by 2x the meal total. A standard sender reversal
-- of a Food payment ('FOODPAY-...-REV') would count for the employee likewise.
--
-- FIX (narrowest). Only _shopping_advance_received_24h changes, and only by
-- excluding legs belonging to a Food payment: the leg's transaction group is a
-- recorded Food payment attempt, or its reference has the Food payment prefix.
-- Every other condition is the live definition unchanged. Its three callers
-- (agent_ops_shopping_advance_qualified_senders, _qualified_profiles,
-- _user_dossier) are not edited. No ledger, wallet, repayment or other financial
-- function changes, and no row is written.
--
-- DRIFT GUARD. Refuses (whole file rolls back) unless the current body is
-- exactly the verified live definition (md5 of prosrc read from production on
-- 2026-10-14), so it never overwrites an unreviewed version.
--
-- ROLLBACK: re-run the _shopping_advance_received_24h statement from
-- drizzle/migrations/0533_agent_ops_shopping_advance_rolling_24h.sql.

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._shopping_advance_received_24h()');
  IF v_md5 IS DISTINCT FROM '29fa5640ca5bd977e7929684c95554c2' THEN
    RAISE EXCEPTION 'food: _shopping_advance_received_24h() is missing or differs from the reviewed definition (md5 %)', v_md5;
  END IF;
  IF to_regclass('public.food_payment_attempts') IS NULL THEN
    RAISE EXCEPTION 'food: apply 20261013128000_food_payment_after_receipt first';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public._shopping_advance_received_24h()
RETURNS TABLE(user_id uuid, transfer_count bigint, transfer_total numeric, first_transfer_at timestamptz, last_transfer_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT gl.user_id, count(*)::bigint, sum(gl.amount)::numeric, min(gl.transaction_date), max(gl.transaction_date)
  FROM public.general_ledger gl
  WHERE gl.user_id IS NOT NULL AND gl.ledger_scope = 'wallet'
    AND gl.category = 'wallet_transfer' AND gl.direction = 'cash_in'
    AND gl.amount > 0 AND gl.classification <> 'admin_correction'
    AND gl.transaction_date >= now() - interval '24 hours'
    -- Food canteen payments, and reversals of them, are not received transfers
    AND COALESCE(gl.reference_id, '') NOT LIKE 'FOODPAY-%'
    AND NOT EXISTS (SELECT 1 FROM public.food_payment_attempts fa
                     WHERE fa.transaction_group_id = gl.transaction_group_id)
  GROUP BY gl.user_id;
$$;
REVOKE ALL ON FUNCTION public._shopping_advance_received_24h() FROM PUBLIC, anon, authenticated;
$fm1guard$;
  h text := encode(sha256(convert_to(s, 'UTF8')), 'hex');
BEGIN
  IF h <> '2bf6996c57ac9c125e1faa46319cd8fc05c639d127e903cc28cfc4d674b973b6' THEN
    RAISE EXCEPTION 'food m1 guard: 20261013128600 checksum mismatch, got %', h;
  END IF;
  EXECUTE s;
END
$fm1guard_outer$;