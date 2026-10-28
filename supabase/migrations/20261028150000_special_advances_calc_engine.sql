-- 2026-10-27: Special Advances, Phase 1: authoritative calculation engine. NOT APPLIED. Production apply needs explicit
-- CFO approval. Additive only: three new, side-effect-free functions. Touches no table, no existing function, no
-- existing advance product, and nothing in general_ledger, wallets or payments.
--
-- Rules (CFO decisions 2026-10-27; the preview in src/lib/specialAdvancePreview.ts mirrors them exactly):
--   rate     presets 1% per day, 15% per month, 28% per month; or a custom rate with an explicit basis:
--            daily basis 0 < rate <= 1%, monthly basis 0 < rate <= 28%; 0% is not permitted; at most 2 decimals.
--   term     7, 14, 30 days or a custom whole number of days, 1 to 90.
--   principal whole UGX, at least 10,000 (no policy maximum; 1,000,000,000,000 is a technical overflow bound only).
--   frequency daily (1 day), weekly (7 days), monthly (every 30 days). Bi-weekly is not offered.
--   access fee (simple, never compounded; half up to whole UGX):
--            monthly basis: round(principal x rate x days / 30);  daily basis: round(principal x rate x days).
--   registration fee 10,000 if principal <= 200,000, else 20,000 (the existing rule).
--   total    principal + access fee + registration fee.
--   instalments n = ceil(term / period); amount = ceil(total / n); the last instalment is the remainder, so the
--            schedule sums exactly to the total.
--   due dates payout date + min(k x period, term), Kampala calendar days. The term runs from the PAYOUT date, not
--            approval; the caller passes the payout date (the quote passes the intended date).
--   split    each instalment is attributed late fee -> access fee -> registration fee -> principal (approved waterfall).
--   allocation of a payment against what is due: the same order; anything left over is returned as `excess`
--            (how an overpayment is treated is a Phase 4 decision; this function never applies it).
-- Errors: SPECIAL_ADVANCE_INVALID_TERMS (22023) with DETAIL = JSON array of the failing fields
--         (principal, rate, rate_basis, term, frequency, start_date).
-- Privileges: owner-only internals (later CFO-only RPCs call them). Rollback:
--   supabase/rollbacks/20261028150000_special_advances_calc_engine.rollback.sql
-- Tests: src/test/specialAdvanceServerEngine.test.ts (PGlite; golden cases shared with the preview + 3,000 random
--        agreements compared row for row with the preview).

SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF to_regprocedure('public._special_advance_term_errors(numeric,numeric,text,numeric,text,date)') IS NOT NULL
     OR to_regprocedure('public._special_advance_schedule(numeric,numeric,text,numeric,text,date)') IS NOT NULL
     OR to_regprocedure('public._special_advance_allocate(jsonb,numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: Special Advances calculation functions already exist; nothing was changed';
  END IF;
END
$pre$;

-- Which agreed terms are invalid (empty array = valid). Single definition used by every Special Advances function.
CREATE FUNCTION public._special_advance_term_errors(
  p_principal numeric, p_rate_percent numeric, p_rate_basis text, p_term_days numeric, p_frequency text, p_start_date date)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN p_principal IS NULL OR p_principal <> trunc(p_principal)
              OR p_principal < 10000 OR p_principal > 1000000000000 THEN 'principal' END,
    CASE WHEN p_rate_percent IS NULL OR p_rate_percent <= 0
              OR p_rate_percent * 100 <> trunc(p_rate_percent * 100)
              OR p_rate_percent > CASE WHEN p_rate_basis = 'daily' THEN 1 ELSE 28 END THEN 'rate' END,
    CASE WHEN p_rate_basis IS NULL OR p_rate_basis NOT IN ('daily', 'monthly') THEN 'rate_basis' END,
    CASE WHEN p_term_days IS NULL OR p_term_days <> trunc(p_term_days)
              OR p_term_days < 1 OR p_term_days > 90 THEN 'term' END,
    CASE WHEN p_frequency IS NULL OR p_frequency NOT IN ('daily', 'weekly', 'monthly') THEN 'frequency' END,
    CASE WHEN p_start_date IS NULL THEN 'start_date' END
  ], NULL);
$$;

-- The full repayment schedule for agreed terms. Pure: same input, same output; reads no table and no clock.
CREATE FUNCTION public._special_advance_schedule(
  p_principal numeric, p_rate_percent numeric, p_rate_basis text, p_term_days numeric, p_frequency text, p_start_date date)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_errors text[] := public._special_advance_term_errors(p_principal, p_rate_percent, p_rate_basis, p_term_days, p_frequency, p_start_date);
  v_p bigint;
  v_bp bigint;          -- rate in hundredths of a percent (28% = 2800, 0.5% = 50)
  v_term int;
  v_step int;
  v_n int;
  v_fee bigint;
  v_reg bigint;
  v_total bigint;
  v_inst bigint;
  v_access_left bigint;
  v_reg_left bigint;
  v_prin_left bigint;
  v_remaining bigint;
  v_amt bigint;
  v_left bigint;
  v_a bigint;
  v_r bigint;
  v_pr bigint;
  v_due date;
  v_rows jsonb := '[]'::jsonb;
  k int;
BEGIN
  IF cardinality(v_errors) > 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_INVALID_TERMS' USING ERRCODE = '22023', DETAIL = to_jsonb(v_errors)::text;
  END IF;

  v_p := p_principal::bigint;
  v_bp := (p_rate_percent * 100)::bigint;
  v_term := p_term_days::int;
  -- exact numeric arithmetic; round() on a positive numeric is half up
  v_fee := CASE WHEN p_rate_basis = 'daily'
                THEN round((v_p::numeric * v_bp * v_term) / 10000)
                ELSE round((v_p::numeric * v_bp * v_term) / 300000) END;
  v_reg := CASE WHEN v_p <= 200000 THEN 10000 ELSE 20000 END;
  v_total := v_p + v_fee + v_reg;
  v_step := CASE p_frequency WHEN 'daily' THEN 1 WHEN 'weekly' THEN 7 ELSE 30 END;
  v_n := ceil(v_term::numeric / v_step)::int;
  v_inst := ceil(v_total::numeric / v_n)::bigint;

  v_access_left := v_fee;
  v_reg_left := v_reg;
  v_prin_left := v_p;
  v_remaining := v_total;
  FOR k IN 1 .. v_n LOOP
    v_amt := CASE WHEN k = v_n THEN v_remaining ELSE least(v_inst, v_remaining) END;
    IF v_amt <= 0 THEN
      -- cannot happen within the limits (n(n-1) < total); refuse rather than store a zero instalment
      RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_INVARIANT' USING ERRCODE = 'P0001';
    END IF;
    v_left := v_amt;
    v_a := least(v_left, v_access_left);  v_left := v_left - v_a;  v_access_left := v_access_left - v_a;
    v_r := least(v_left, v_reg_left);     v_left := v_left - v_r;  v_reg_left := v_reg_left - v_r;
    v_pr := least(v_left, v_prin_left);   v_left := v_left - v_pr; v_prin_left := v_prin_left - v_pr;
    v_remaining := v_remaining - v_amt;
    v_due := p_start_date + least(k * v_step, v_term);
    v_rows := v_rows || jsonb_build_object(
      'number', k, 'due_date', to_char(v_due, 'YYYY-MM-DD'), 'amount', v_amt,
      'access_fee', v_a, 'registration_fee', v_r, 'principal', v_pr, 'balance_after', v_remaining);
  END LOOP;
  IF v_remaining <> 0 OR v_access_left <> 0 OR v_reg_left <> 0 OR v_prin_left <> 0 THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_SCHEDULE_INVARIANT' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'calc_version', 'sa-calc-1',
    'principal', v_p, 'rate_percent', p_rate_percent, 'rate_basis', p_rate_basis, 'term_days', v_term,
    'frequency', p_frequency, 'start_date', to_char(p_start_date, 'YYYY-MM-DD'),
    'access_fee', v_fee, 'registration_fee', v_reg, 'total_repayable', v_total,
    'instalments', v_n, 'instalment_amount', v_inst,
    'final_instalment_amount', (v_rows -> (v_n - 1) ->> 'amount')::bigint,
    'first_due_date', v_rows -> 0 ->> 'due_date',
    'final_due_date', v_rows -> (v_n - 1) ->> 'due_date',
    'schedule', v_rows);
END $$;

-- Splits one payment across what is currently due, in the approved order. Returns the parts and any excess; it
-- never decides what happens to an overpayment.
CREATE FUNCTION public._special_advance_allocate(p_due jsonb, p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  v_keys text[] := ARRAY['late_fee', 'access_fee', 'registration_fee', 'principal'];
  v_out jsonb := '{}'::jsonb;
  v_left numeric;
  v_due numeric;
  v_part numeric;
  k text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> trunc(p_amount) THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_PAYMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_due IS NULL OR jsonb_typeof(p_due) <> 'object' THEN
    RAISE EXCEPTION 'SPECIAL_ADVANCE_DUE_INVALID' USING ERRCODE = '22023';
  END IF;
  v_left := p_amount;
  FOREACH k IN ARRAY v_keys LOOP
    IF jsonb_typeof(p_due -> k) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_DUE_INVALID' USING ERRCODE = '22023', DETAIL = k;
    END IF;
    v_due := (p_due ->> k)::numeric;
    IF v_due < 0 OR v_due <> trunc(v_due) THEN
      RAISE EXCEPTION 'SPECIAL_ADVANCE_DUE_INVALID' USING ERRCODE = '22023', DETAIL = k;
    END IF;
    v_part := least(v_left, v_due);
    v_left := v_left - v_part;
    v_out := v_out || jsonb_build_object(k, v_part::bigint);
  END LOOP;
  RETURN v_out || jsonb_build_object('excess', v_left::bigint);
END $$;

REVOKE ALL ON FUNCTION public._special_advance_term_errors(numeric, numeric, text, numeric, text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_schedule(numeric, numeric, text, numeric, text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._special_advance_allocate(jsonb, numeric) FROM PUBLIC, anon, authenticated;

RESET lock_timeout;
