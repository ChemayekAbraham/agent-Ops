-- PHASE 1 (3/5): pro-rata instalment allocation with deterministic rounding.
--
-- compute_instalment_allocation() splits an amount by the priced shares using
-- the largest-remainder method, so components always foot to the amount exactly.
-- NUMERIC throughout; no floating point.
--
-- allocate_instalment() is the function the posting path must use. It allocates
-- the CUMULATIVE amount paid to date and subtracts what is already allocated.
-- Independent per-instalment rounding was tested first and REJECTED: small
-- components floor to zero on every instalment and drift (observed up to
-- UGX 198,000 on access fee, 20,000 on registration across a schedule). The
-- cumulative form telescopes, so a completed plan trues up exactly to the
-- priced components on the final instalment.
--
-- Neither function posts anything, and neither computes Partner Reward or
-- Agent Commission - those await BD-2 and BD-3.

CREATE OR REPLACE FUNCTION public.compute_instalment_allocation(
  p_rent_request_id uuid,
  p_instalment_amount numeric
) RETURNS TABLE(
  principal_component        numeric,
  registration_fee_component numeric,
  access_fee_component       numeric,
  basis_total                numeric,
  basis_principal            numeric,
  basis_access_fee           numeric,
  basis_registration_fee     numeric,
  basis_note                 text
) LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $fn$
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

  IF v_amt <= 0 THEN
    RETURN QUERY SELECT 0::numeric,0::numeric,0::numeric,v_tot,v_p,v_af,v_rf,'non-positive instalment'::text;
    RETURN;
  END IF;

  IF v_tot <= 0 OR v_tot <> (v_p + v_af + v_rf) THEN
    v_tot := v_p + v_af + v_rf;
    v_note := 'component sum (stored total_repayment absent or inconsistent)';
  END IF;

  IF v_tot <= 0 THEN
    RETURN QUERY SELECT v_amt,0::numeric,0::numeric,v_tot,v_p,v_af,v_rf,'degenerate basis - all principal'::text;
    RETURN;
  END IF;

  r_p  := v_amt * v_p  / v_tot;
  r_af := v_amt * v_af / v_tot;
  r_rf := v_amt * v_rf / v_tot;
  f_p  := FLOOR(r_p); f_af := FLOOR(r_af); f_rf := FLOOR(r_rf);
  v_rem := (v_amt - (f_p + f_af + f_rf))::int;

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

  IF (f_p + f_af + f_rf) <> v_amt THEN
    RAISE EXCEPTION 'allocation failed to reconcile: % + % + % <> %', f_p, f_af, f_rf, v_amt;
  END IF;

  RETURN QUERY SELECT f_p, f_rf, f_af, v_tot, v_p, v_af, v_rf, v_note;
END
$fn$;


CREATE OR REPLACE FUNCTION public.allocate_instalment(
  p_rent_request_id uuid,
  p_instalment_amount numeric
) RETURNS TABLE(
  principal_component        numeric,
  registration_fee_component numeric,
  access_fee_component       numeric,
  cumulative_before          numeric,
  cumulative_after           numeric,
  basis_note                 text
) LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $fn$
DECLARE
  v_amt numeric; v_prior_amt numeric; v_prior_p numeric; v_prior_rf numeric; v_prior_af numeric;
  v_cum numeric; v_note text; t_p numeric; t_rf numeric; t_af numeric;
BEGIN
  v_amt := ROUND(COALESCE(p_instalment_amount,0));

  SELECT COALESCE(SUM(ia.instalment_amount),0), COALESCE(SUM(ia.principal_component),0),
         COALESCE(SUM(ia.registration_fee_component),0), COALESCE(SUM(ia.access_fee_component),0)
    INTO v_prior_amt, v_prior_p, v_prior_rf, v_prior_af
  FROM public.instalment_allocations ia WHERE ia.rent_request_id = p_rent_request_id;

  IF v_amt <= 0 THEN
    RETURN QUERY SELECT 0::numeric,0::numeric,0::numeric,v_prior_amt,v_prior_amt,'non-positive instalment'::text;
    RETURN;
  END IF;

  v_cum := v_prior_amt + v_amt;

  SELECT a.principal_component, a.registration_fee_component, a.access_fee_component, a.basis_note
    INTO t_p, t_rf, t_af, v_note
  FROM public.compute_instalment_allocation(p_rent_request_id, v_cum) a;

  RETURN QUERY SELECT (t_p - v_prior_p), (t_rf - v_prior_rf), (t_af - v_prior_af),
                      v_prior_amt, v_cum, v_note;
END
$fn$;
