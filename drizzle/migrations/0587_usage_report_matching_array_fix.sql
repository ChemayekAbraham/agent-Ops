CREATE OR REPLACE FUNCTION public._usage_report_evaluate(p_approved numeric, p_used numeric, p_receipt numeric,
  p_mismatch text, p_unspent text, p_over text, p_refund text, p_refund_evidence int, p_refund_reason text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE reasons text[] := '{}'; problems text[] := '{}'; v_unspent numeric;
BEGIN
  IF p_receipt IS NULL THEN
    reasons := array_append(reasons, 'receipt_total_unverified'::text);
    RETURN jsonb_build_object('flag', true, 'reasons', to_jsonb(reasons), 'problems', to_jsonb(problems));
  END IF;
  IF round(p_receipt) <> round(p_used) THEN
    reasons := array_append(reasons, 'receipt_vs_used_mismatch'::text);
    IF coalesce(char_length(btrim(p_mismatch)),0) < 10 THEN problems := array_append(problems, 'Explain why the receipt total differs from the amount used (at least 10 characters).'::text); END IF;
  END IF;
  v_unspent := round(coalesce(p_approved,0)) - round(p_receipt);
  IF v_unspent > 0 THEN
    reasons := array_append(reasons, 'unspent_balance'::text);
    IF coalesce(char_length(btrim(p_unspent)),0) < 10 THEN problems := array_append(problems, 'Explain the unspent balance (at least 10 characters).'::text); END IF;
    IF p_refund IS NULL THEN problems := array_append(problems, 'Choose the refund status for the unspent balance.'::text);
    ELSIF p_refund = 'made' AND coalesce(p_refund_evidence,0) = 0 THEN problems := array_append(problems, 'Attach proof of the refund.'::text);
    ELSIF p_refund = 'not_required' AND coalesce(char_length(btrim(p_refund_reason)),0) < 10 THEN problems := array_append(problems, 'Explain why no refund is required (at least 10 characters).'::text);
    END IF;
  ELSIF v_unspent < 0 THEN
    reasons := array_append(reasons, 'overspend'::text);
    IF coalesce(char_length(btrim(p_over)),0) < 10 THEN problems := array_append(problems, 'Explain the amount spent above the approved amount (at least 10 characters).'::text); END IF;
  END IF;
  RETURN jsonb_build_object('flag', cardinality(reasons) > 0, 'reasons', to_jsonb(reasons), 'problems', to_jsonb(problems));
END $$;