CREATE OR REPLACE FUNCTION public.accrue_partner_self_returns(p_as_of date DEFAULT CURRENT_DATE)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r record;
  v_cycle_start date;
  v_cycle_end date;
  v_days integer;
  v_total numeric;
  v_lines integer;
  v_cycle_id uuid;
  v_commitments integer := 0;
  v_recognised numeric := 0;
  v_as_of date := LEAST(COALESCE(p_as_of, CURRENT_DATE), CURRENT_DATE);
BEGIN
  FOR r IN
    SELECT * FROM public.partner_self_commitments
    WHERE status='active' AND next_payout_at IS NOT NULL AND next_payout_at::date <= v_as_of
    ORDER BY next_payout_at ASC
  LOOP
    v_cycle_end := r.next_payout_at::date;
    v_cycle_start := (r.next_payout_at - interval '1 month')::date;
    v_days := GREATEST(1, v_cycle_end - v_cycle_start);

    INSERT INTO public.partner_self_payout_cycles (partner_id, commitment_id, cycle_start, cycle_end)
    VALUES (r.partner_id, r.id, v_cycle_start, v_cycle_end)
    ON CONFLICT (commitment_id, cycle_end) DO UPDATE SET updated_at = now()
    RETURNING id INTO v_cycle_id;

    INSERT INTO public.partner_self_earnings (
      line_id, commitment_id, partner_id, cycle_start, cycle_end,
      days_live, days_in_cycle, principal, monthly_rate, amount, payout_cycle_id
    )
    SELECT l.id, r.id, r.partner_id, v_cycle_start, v_cycle_end,
           d.days_live, v_days, l.principal, l.monthly_rate,
           round(l.principal * l.monthly_rate / 100 * d.days_live::numeric / v_days),
           v_cycle_id
    FROM public.partner_self_funding_lines l
    CROSS JOIN LATERAL (
      SELECT GREATEST(0,
        LEAST(v_cycle_end, COALESCE(l.completed_at::date, v_cycle_end))
        - GREATEST(v_cycle_start, l.live_at::date)
      ) AS days_live
    ) d
    WHERE l.commitment_id = r.id
      AND l.live_at IS NOT NULL
      AND l.status IN ('active','completed')
      AND d.days_live > 0
    ON CONFLICT (line_id, cycle_end) DO NOTHING;

    SELECT COALESCE(SUM(amount),0), COUNT(*) INTO v_total, v_lines
    FROM public.partner_self_earnings WHERE payout_cycle_id = v_cycle_id AND status <> 'void';

    UPDATE public.partner_self_payout_cycles
       SET total_amount = v_total, lines_count = v_lines, updated_at = now()
     WHERE id = v_cycle_id;

    UPDATE public.partner_self_commitments
       SET next_payout_at = next_payout_at + interval '1 month',
           total_earned = total_earned + v_total,
           status = CASE WHEN term_end_at IS NOT NULL AND (next_payout_at + interval '1 month') > term_end_at
                         THEN 'matured' ELSE status END,
           updated_at = now()
     WHERE id = r.id;

    v_commitments := v_commitments + 1;
    v_recognised := v_recognised + v_total;

    PERFORM public.psm_audit(NULL, r.partner_id, 'returns_recognised',
      'partner_self_payout_cycles', v_cycle_id,
      jsonb_build_object('cycle_end', v_cycle_end, 'amount', v_total, 'lines', v_lines));
  END LOOP;

  RETURN jsonb_build_object('commitments_processed', v_commitments, 'total_recognised', v_recognised, 'as_of', v_as_of);
END;
$fn$;