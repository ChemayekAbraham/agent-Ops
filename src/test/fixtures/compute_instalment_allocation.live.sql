-- public.compute_instalment_allocation, production definition (read-only export 2026-11-08). Test fixture.
CREATE OR REPLACE FUNCTION public.compute_instalment_allocation(p_rent_request_id uuid, p_instalment_amount numeric)
 RETURNS TABLE(principal_component numeric, registration_fee_component numeric, access_fee_component numeric, basis_total numeric, basis_principal numeric, basis_access_fee numeric, basis_registration_fee numeric, basis_note text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_p numeric; v_af numeric; v_rf numeric; v_tot numeric; v_stored numeric;
  v_amt numeric; v_note text := 'stored total_repayment';
  r_p numeric; r_af numeric; r_rf numeric;
  f_p numeric; f_af numeric; f_rf numeric;
  v_rem int; v_rec record;
BEGIN
  SELECT COALESCE(rent_amount,0), COALESCE(access_fee,0), COALESCE(request_fee,0), COALESCE(total_repayment,0)
    INTO v_p, v_af, v_rf, v_stored
  FROM public.rent_requests WHERE id = p_rent_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'rent_request % not found', p_rent_request_id; END IF;

  v_amt := ROUND(COALESCE(p_instalment_amount, 0));
  v_tot := v_stored;

  -- Non-positive instalment (reversal / zero / NULL): allocate nothing.
  IF v_amt <= 0 THEN
    RETURN QUERY SELECT 0::numeric,0::numeric,0::numeric,v_tot,v_p,v_af,v_rf,'non-positive instalment'::text;
    RETURN;
  END IF;

  -- Basis integrity: fall back to the component sum when total_repayment is
  -- absent or inconsistent, so the three shares always sum to exactly 1.
  IF v_tot <= 0 OR v_tot <> (v_p + v_af + v_rf) THEN
    v_tot := v_p + v_af + v_rf;
    v_note := 'component sum (stored total_repayment absent or inconsistent)';
  END IF;

  -- Nothing priced at all: the instalment can only be principal.
  IF v_tot <= 0 THEN
    RETURN QUERY SELECT v_amt,0::numeric,0::numeric,v_tot,v_p,v_af,v_rf,'degenerate basis - all principal'::text;
    RETURN;
  END IF;

  r_p  := v_amt * v_p  / v_tot;
  r_af := v_amt * v_af / v_tot;
  r_rf := v_amt * v_rf / v_tot;
  f_p  := FLOOR(r_p); f_af := FLOOR(r_af); f_rf := FLOOR(r_rf);
  v_rem := (v_amt - (f_p + f_af + f_rf))::int;

  -- Largest-remainder: give each surplus shilling to the largest fractional
  -- part. Deterministic tie-break: principal, then access fee, then registration.
  IF v_rem > 0 THEN
    FOR v_rec IN
      SELECT k FROM (
        SELECT 'p'::text  AS k, (r_p  - f_p)  AS frac, 1 AS ord
        UNION ALL SELECT 'af', (r_af - f_af), 2
        UNION ALL SELECT 'rf', (r_rf - f_rf), 3
      ) t ORDER BY frac DESC, ord ASC LIMIT v_rem
    LOOP
      IF    v_rec.k = 'p'  THEN f_p  := f_p  + 1;
      ELSIF v_rec.k = 'af' THEN f_af := f_af + 1;
      ELSE                      f_rf := f_rf + 1;
      END IF;
    END LOOP;
  END IF;

  -- Hard invariant: components must foot to the instalment exactly.
  IF (f_p + f_af + f_rf) <> v_amt THEN
    RAISE EXCEPTION 'allocation failed to reconcile: % + % + % <> %', f_p, f_af, f_rf, v_amt;
  END IF;

  RETURN QUERY SELECT f_p, f_rf, f_af, v_tot, v_p, v_af, v_rf, v_note;
END
$function$;
