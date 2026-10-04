CREATE OR REPLACE FUNCTION public.get_merchant_agent_money_owed()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bank json;
  v_bayo numeric := 0;
  v_agents json;
  v_merchant_total numeric := 0;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  v_bank := public.get_money_at_bank_reconciliation();
  v_bayo := COALESCE((v_bank->>'money_at_bank_total')::numeric, 0);

  WITH desks AS (
    SELECT ca.id AS desk_id, ca.agent_id, ca.label,
           COALESCE(p.full_name, 'Merchant agent') AS name,
           COALESCE(ca.float_phone, p.phone, '') AS display_phone,
           regexp_replace(COALESCE(ca.float_phone, ''), '\D', '', 'g') AS fp,
           regexp_replace(COALESCE(ca.personal_phone, ''), '\D', '', 'g') AS pp
    FROM public.cashout_agents ca
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
    WHERE ca.is_active = true
  ), phones AS (
    SELECT desk_id, right(x, 9) AS p9
    FROM desks, unnest(ARRAY[fp, pp]) AS x
    WHERE length(x) >= 9
  ), emails AS (
    SELECT gt.id, gt.amount, gt.direction, gt.channel, gt.subject, gt.snippet,
           gt.transaction_id,
           COALESCE(gt.internal_date, gt.created_at) AS at,
           COALESCE(
             NULLIF(right(regexp_replace(COALESCE(gt.counterparty, ''), '\D', '', 'g'), 9), ''),
             NULLIF(right(regexp_replace(COALESCE(substring(gt.snippet from 'Mobile Number: *([0-9]{9,13})'), ''), '\D', '', 'g'), 9), ''),
             NULLIF(right(regexp_replace(COALESCE(substring(gt.snippet from 'to [^,]+, *([0-9]{9,13})'), ''), '\D', '', 'g'), 9), '')
           ) AS p9
    FROM public.gmail_transactions gt
    WHERE gt.channel IN ('mtn_momo', 'airtel_money')
      AND gt.amount IS NOT NULL
      AND gt.direction IN ('in', 'out')
  ), matched AS (
    SELECT ph.desk_id, e.*
    FROM emails e
    JOIN phones ph ON ph.p9 = e.p9
  ), agg AS (
    SELECT desk_id,
           COALESCE(SUM(amount) FILTER (WHERE direction = 'out'), 0) AS sent,
           COALESCE(SUM(amount) FILTER (WHERE direction = 'in'), 0) AS returned,
           COUNT(*) FILTER (WHERE direction = 'out') AS sent_count,
           COUNT(*) FILTER (WHERE direction = 'in') AS returned_count,
           MAX(at) FILTER (WHERE direction = 'out') AS last_sent_at
    FROM matched GROUP BY desk_id
  ), paid AS (
    SELECT d.desk_id, COALESCE(SUM(w.amount), 0) AS paid_out
    FROM desks d
    LEFT JOIN public.withdrawal_requests w
      ON w.status IN ('completed', 'paid')
     AND (w.assigned_cashout_agent_id = d.desk_id OR w.processed_by = d.agent_id)
    GROUP BY d.desk_id
  ), claimed AS (
    -- Claimed for payout but not yet completed: the desk has taken the request
    -- on, so the cash is already leaving their hands.
    SELECT d.desk_id,
           COALESCE(SUM(w.amount), 0) AS claimed_pending,
           COUNT(w.id) AS claimed_pending_count
    FROM desks d
    LEFT JOIN public.withdrawal_requests w
      ON w.status NOT IN ('completed', 'paid', 'rejected', 'cancelled', 'expired', 'failed')
     AND (
           w.assigned_cashout_agent_id = d.desk_id
           OR w.dispatch_claimed_by = d.agent_id
           OR w.processed_by = d.agent_id
         )
     AND (w.dispatch_claimed_at IS NOT NULL OR w.assigned_cashout_agent_id = d.desk_id)
    GROUP BY d.desk_id
  ), rows AS (
    SELECT d.desk_id, d.agent_id, d.name, d.label, d.display_phone,
           COALESCE(a.sent, 0) AS sent,
           COALESCE(a.returned, 0) AS returned,
           p.paid_out,
           c.claimed_pending,
           c.claimed_pending_count,
           GREATEST(
             COALESCE(a.sent, 0) - COALESCE(a.returned, 0) - p.paid_out - c.claimed_pending,
             0
           ) AS still_held,
           COALESCE(a.sent_count, 0) AS sent_count,
           COALESCE(a.returned_count, 0) AS returned_count,
           a.last_sent_at
    FROM desks d
    LEFT JOIN agg a ON a.desk_id = d.desk_id
    JOIN paid p ON p.desk_id = d.desk_id
    JOIN claimed c ON c.desk_id = d.desk_id
  )
  SELECT COALESCE(SUM(still_held), 0),
         COALESCE(json_agg(json_build_object(
           'desk_id', desk_id,
           'agent_id', agent_id,
           'agent_name', name,
           'label', label,
           'phone', display_phone,
           'email_sent_total', sent,
           'email_returned_total', returned,
           'paid_out_total', paid_out,
           'claimed_pending_total', claimed_pending,
           'claimed_pending_count', claimed_pending_count,
           'still_held', still_held,
           'email_sent_count', sent_count,
           'email_returned_count', returned_count,
           'last_sent_at', last_sent_at
         ) ORDER BY still_held DESC, name), '[]'::json)
  INTO v_merchant_total, v_agents
  FROM rows;

  RETURN json_build_object(
    'definition', 'Money still in merchant agent hands = money sent to their MTN/Airtel numbers in the extracted emails, less money they sent back, less payouts they have already completed for us, less withdrawal requests they have claimed but not yet completed (floored at zero per agent). Bayo Mercy account balance comes from the same email extractor and already nets every extracted payout out of her account.',
    'merchant_agent_total', v_merchant_total,
    'bayo_mercy_total', v_bayo,
    'total', v_merchant_total + v_bayo,
    'agents', v_agents,
    'computed_at', now()
  );
END;
$function$;