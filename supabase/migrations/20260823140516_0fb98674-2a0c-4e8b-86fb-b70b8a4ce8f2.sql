CREATE OR REPLACE FUNCTION public.get_merchant_float_email_movements(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days integer := GREATEST(1, LEAST(COALESCE(p_days, 30), 365));
  v_result jsonb;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  WITH mer AS (
    SELECT
      ca.agent_id,
      COALESCE(p.full_name, 'Unknown merchant') AS name,
      ca.float_phone,
      ca.is_active,
      RIGHT(regexp_replace(COALESCE(ca.float_phone, ''), '\D', '', 'g'), 9) AS float_tail,
      ARRAY_REMOVE(ARRAY[
        RIGHT(regexp_replace(COALESCE(ca.float_phone, ''), '\D', '', 'g'), 9),
        RIGHT(regexp_replace(COALESCE(ca.personal_phone, ''), '\D', '', 'g'), 9),
        RIGHT(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 9)
      ], '') AS tails
    FROM public.cashout_agents ca
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
  ),
  tx AS (
    SELECT
      g.id, g.amount, g.fee, g.channel, g.internal_date, g.snippet, g.subject,
      g.transaction_id, g.counterparty,
      regexp_replace(COALESCE(g.snippet, '') || ' ' || COALESCE(g.subject, '') || ' ' || COALESCE(g.counterparty, ''), '\D', '', 'g') AS digits
    FROM public.gmail_transactions g
    WHERE g.direction = 'out'
      AND COALESCE(g.amount, 0) > 0
      AND g.internal_date >= now() - (v_days || ' days')::interval
  ),
  matched AS (
    SELECT DISTINCT ON (t.id)
      m.agent_id, m.name, m.float_phone, m.is_active,
      t.id AS tx_id, t.amount, t.fee, t.channel, t.internal_date,
      t.snippet, t.transaction_id,
      (tl = m.float_tail) AS matched_float_line
    FROM tx t
    JOIN mer m ON TRUE
    CROSS JOIN LATERAL unnest(m.tails) AS tl
    WHERE length(tl) = 9 AND position(tl IN t.digits) > 0
    ORDER BY t.id, (tl = m.float_tail) DESC, m.is_active DESC, m.name
  ),
  grouped AS (
    SELECT
      agent_id, name, float_phone, is_active,
      SUM(amount)::numeric AS total_sent,
      SUM(COALESCE(fee, 0))::numeric AS total_fees,
      COUNT(*)::int AS transfer_count,
      MAX(internal_date) AS last_sent_at,
      jsonb_agg(
        jsonb_build_object(
          'tx_id', tx_id,
          'amount', amount,
          'fee', COALESCE(fee, 0),
          'channel', channel,
          'sent_at', internal_date,
          'reference', transaction_id,
          'snippet', snippet,
          'matched_float_line', matched_float_line
        ) ORDER BY internal_date DESC
      ) AS transfers
    FROM matched
    GROUP BY agent_id, name, float_phone, is_active
  )
  SELECT jsonb_build_object(
    'days', v_days,
    'computed_at', now(),
    'grand_total', COALESCE((SELECT SUM(total_sent) FROM grouped), 0),
    'grand_fees', COALESCE((SELECT SUM(total_fees) FROM grouped), 0),
    'transfer_count', COALESCE((SELECT SUM(transfer_count) FROM grouped), 0),
    'merchants', COALESCE((
      SELECT jsonb_agg(to_jsonb(g) ORDER BY g.total_sent DESC) FROM grouped g
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_merchant_float_email_movements(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_merchant_float_email_movements(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_merchant_float_email_movements(integer) TO service_role;