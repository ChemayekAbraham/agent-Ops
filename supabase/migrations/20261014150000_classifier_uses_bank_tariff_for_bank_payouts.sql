-- classify_merchant_payout_funding charges bank payouts the wallet-to-bank tariff (doc 227).
--
-- APPLIED BY HAND to production on 2026-10-14 (Josh); this file records it so the
-- repo matches. Do not re-run blindly: the marker check will abort if the
-- classifier was already patched.
--
-- Doc 225 put the wallet-to-bank tariff in approve-withdrawal, but the live
-- classifier prices the telecom leg itself with telecom_sending_charge()
-- (mobile-money P2P tiers 100-2,000). Immaculate's bank payouts on 2026-10-14
-- were filed with 1,000-2,000 telecom claims instead of 4,100-9,250, and the
-- classifier also caps the float telecom leg at that understated figure. The
-- classifier owns the claim rows (it rebuilds unattested pending rows), so it
-- must use the same tariff.
--
-- 1. bank_sending_charge(): MTN wallet-to-bank schedule, same table as
--    BANK_CHARGE_TIERS in approve-withdrawal / src/lib/cashoutCharges.ts.
-- 2. classifier: string replace on the LIVE definition; aborts unless the
--    marker is found exactly once.
-- 3. Re-classify ONLY bank payouts that already have unattested open claims
--    today, so telecom amounts are corrected without filing claims on payouts
--    that had none. Forward-only; reimbursed/rejected rows are untouched.
--
-- Result verified 2026-10-14: the six bank payouts read 9,250 / 9,250 / 9,250 /
-- 4,100 / 4,100 / 6,150 and payout principals were unchanged.

CREATE OR REPLACE FUNCTION public.bank_sending_charge(p_amount numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN COALESCE(p_amount, 0) <= 0 THEN 0
    WHEN p_amount <= 125000 THEN 1500
    WHEN p_amount <= 250000 THEN 2250
    WHEN p_amount <= 500000 THEN 4100
    WHEN p_amount <= 1000000 THEN 6150
    WHEN p_amount <= 2000000 THEN 9250
    ELSE 11300
  END::numeric
$function$;

DO $mig$
DECLARE
  v_def text;
  v_new text;
  v_marker constant text := 'v_telecom := public.telecom_sending_charge(v_amount);';
  v_repl   constant text := $r$v_telecom := CASE WHEN COALESCE(w.payout_method, '') = 'bank_transfer' THEN public.bank_sending_charge(v_amount) ELSE public.telecom_sending_charge(v_amount) END; /* doc 227 */$r$;
BEGIN
  v_def := pg_get_functiondef('public.classify_merchant_payout_funding(uuid,text)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_marker, ''))) / length(v_marker) <> 1 THEN
    RAISE EXCEPTION 'classifier telecom marker not found exactly once';
  END IF;
  v_new := replace(v_def, v_marker, v_repl);
  EXECUTE v_new;
END
$mig$;

DO $fix$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT o.withdrawal_id
    FROM public.merchant_out_of_pocket_advances o
    JOIN public.withdrawal_requests w ON w.id = o.withdrawal_id
    WHERE w.payout_method = 'bank_transfer'
      AND o.status IN ('pending_reimbursement','needs_review')
      AND o.created_at >= '2026-10-14 00:00:00+00'
  LOOP
    PERFORM public.classify_merchant_payout_funding(r.withdrawal_id, 'manual');
  END LOOP;
END
$fix$;
