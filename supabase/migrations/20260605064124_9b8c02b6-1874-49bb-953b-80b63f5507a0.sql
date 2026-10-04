-- One-click backfill: rebuild welile_receivables_summary derived totals from scratch
-- and verify every past snapshot against the live formula (rent * 1.33 * 12).
CREATE OR REPLACE FUNCTION public.backfill_receivables_summary(p_repair boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_expected_recorded numeric;
  v_expected_estimated numeric;
  v_fill_per_house numeric;
  v_checked int := 0;
  v_passed int := 0;
  v_failed int := 0;
  v_repaired int := 0;
  v_tol numeric;
  v_mismatches jsonb := '[]'::jsonb;
  v_rec_ok boolean;
  v_est_ok boolean;
BEGIN
  -- Ops only
  IF NOT public.is_ops_role(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  FOR r IN
    SELECT * FROM public.welile_receivables_summary ORDER BY computed_at ASC
  LOOP
    v_checked := v_checked + 1;

    -- Re-derive totals from the stored component fields using the live formula.
    v_expected_recorded := r.empty_receivable_total + r.unlisted_receivable_total;
    v_fill_per_house := ((r.avg_known_monthly * 1.33) / 30) * 30 * 12;
    v_expected_estimated := v_expected_recorded + (r.missing_rent_count * v_fill_per_house);

    v_tol := GREATEST(1, v_expected_estimated * 0.0001);
    v_rec_ok := abs(r.recorded_total - v_expected_recorded) <= GREATEST(1, v_expected_recorded * 0.0001);
    v_est_ok := abs(r.estimated_full_total - v_expected_estimated) <= v_tol;

    IF v_rec_ok AND v_est_ok THEN
      v_passed := v_passed + 1;
    ELSE
      v_failed := v_failed + 1;
      v_mismatches := v_mismatches || jsonb_build_object(
        'id', r.id,
        'computed_at', r.computed_at,
        'source_table', r.source_table,
        'stored_recorded', r.recorded_total,
        'expected_recorded', v_expected_recorded,
        'stored_estimated', r.estimated_full_total,
        'expected_estimated', v_expected_estimated
      );

      IF p_repair THEN
        UPDATE public.welile_receivables_summary
        SET recorded_total = v_expected_recorded,
            estimated_full_total = v_expected_estimated
        WHERE id = r.id;
        v_repaired := v_repaired + 1;
      END IF;
    END IF;
  END LOOP;

  -- Always insert a fresh live snapshot so the rebuild is anchored to current data.
  PERFORM public.recompute_receivables_summary('backfill');

  RETURN jsonb_build_object(
    'checked', v_checked,
    'passed', v_passed,
    'failed', v_failed,
    'repaired', v_repaired,
    'repair_mode', p_repair,
    'fresh_snapshot_added', true,
    'mismatches', v_mismatches,
    'run_at', now()
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.backfill_receivables_summary(boolean) TO authenticated;