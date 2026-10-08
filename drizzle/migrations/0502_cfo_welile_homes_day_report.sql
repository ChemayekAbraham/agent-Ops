CREATE OR REPLACE FUNCTION public.cfo_welile_homes_day_report(p_day date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_from timestamptz := (p_day::timestamp AT TIME ZONE 'Africa/Kampala');
  v_to   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'Africa/Kampala');
  v_payments jsonb;
BEGIN
  IF NOT (public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'cto') OR public.has_role(auth.uid(),'ceo')) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;
  -- One row per tag (unique per ledger group); the expense leg supplies date and category, so the two legs never count twice.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'tag_id', t.id, 'posted_at', g.transaction_date, 'payment_reference', t.payment_reference,
      'requisition_ref', t.requisition_ref, 'recipient', t.original_recipient_name, 'amount', t.amount,
      'ledger_category', g.category, 'purpose', t.purpose, 'review_flag', t.review_flag,
      'status', 'Posted') ORDER BY g.transaction_date), '[]'::jsonb)
    INTO v_payments
  FROM cfo_reporting_cost_tags t
  JOIN general_ledger g ON g.id = t.expense_ledger_entry_id
  WHERE t.business_line = 'Welile Homes' AND g.transaction_date >= v_from AND g.transaction_date < v_to;

  RETURN jsonb_build_object(
    'day', p_day,
    'payments', v_payments,
    'payments_total', (SELECT coalesce(sum((p->>'amount')::numeric),0) FROM jsonb_array_elements(v_payments) p),
    'payments_count', jsonb_array_length(v_payments),
    'rent_collected', (SELECT coalesce(sum(amount_collected),0) FROM welile_homes_monthly_dues
                        WHERE amount_collected > 0 AND updated_at >= v_from AND updated_at < v_to),
    'amount_owed_due_today', (SELECT coalesce(sum(greatest(amount_due-amount_collected,0)),0) FROM welile_homes_monthly_dues
                        WHERE period_month::date = p_day),
    'arrears_to_date', (SELECT coalesce(sum(greatest(amount_due-amount_collected,0)),0) FROM welile_homes_monthly_dues
                        WHERE period_month::date <= p_day)
  );
END $$;
REVOKE ALL ON FUNCTION public.cfo_welile_homes_day_report(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_welile_homes_day_report(date) TO authenticated;