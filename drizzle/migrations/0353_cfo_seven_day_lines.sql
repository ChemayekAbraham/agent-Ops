-- Read-only: full per-day, per-product totals for CFO Home 7-day cards (no top-100 cap).
CREATE OR REPLACE FUNCTION public.get_cfo_seven_day_lines(p_side text)
RETURNS TABLE(day_offset int, due_day date, category_label text, product_label text, amount numeric, item_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF p_side = 'payables' THEN
    PERFORM payables_guard();
    RETURN QUERY SELECT (l.due_date::date - v_today)::int, l.due_date::date, l.category_label::text, l.product_label::text,
      ROUND(SUM(l.outstanding_amount),2), COUNT(*)
    FROM v_payables_lines l
    WHERE l.due_date IS NOT NULL AND l.due_date::date >= v_today - 7 AND l.due_date::date < v_today + 7
    GROUP BY 1,2,3,4;
  ELSIF p_side = 'receivables' THEN
    PERFORM receivables_guard();
    RETURN QUERY SELECT (l.due_date::date - v_today)::int, l.due_date::date, l.category_label::text, l.product_label::text,
      ROUND(SUM(l.outstanding_amount),2), COUNT(*)
    FROM v_receivables_lines l
    WHERE l.due_date IS NOT NULL AND l.due_date::date >= v_today - 7 AND l.due_date::date < v_today + 7
    GROUP BY 1,2,3,4;
  ELSE
    RAISE EXCEPTION 'p_side must be payables or receivables';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.get_cfo_seven_day_lines(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_seven_day_lines(text) TO authenticated;