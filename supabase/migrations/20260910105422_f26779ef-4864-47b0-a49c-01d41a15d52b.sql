CREATE OR REPLACE FUNCTION public.get_merchant_agent_movements(p_desk_id uuid DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows json;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  WITH desks AS (
    SELECT ca.id AS desk_id, ca.agent_id, ca.label,
           COALESCE(p.full_name, 'Merchant agent') AS name,
           regexp_replace(COALESCE(ca.float_phone, ''), '\D', '', 'g') AS fp,
           regexp_replace(COALESCE(ca.personal_phone, ''), '\D', '', 'g') AS pp
    FROM public.cashout_agents ca
    LEFT JOIN public.profiles p ON p.id = ca.agent_id
    WHERE ca.is_active = true
      AND (p_desk_id IS NULL OR ca.id = p_desk_id)
  ), phones AS (
    SELECT desk_id, name, right(x, 9) AS p9
    FROM desks, unnest(ARRAY[fp, pp]) AS x
    WHERE length(x) >= 9
  ), emails AS (
    SELECT gt.id, gt.amount, gt.direction, gt.channel, gt.subject, gt.snippet,
           gt.transaction_id, gt.counterparty,
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
  )
  SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json)
  INTO v_rows
  FROM (
    SELECT DISTINCT ON (e.id, ph.desk_id)
           e.id::text AS id,
           ph.desk_id,
           ph.name AS agent_name,
           e.direction,
           e.amount,
           e.channel,
           e.at,
           e.transaction_id,
           e.counterparty,
           e.subject,
           e.snippet
    FROM emails e
    JOIN phones ph ON ph.p9 = e.p9
    ORDER BY e.id, ph.desk_id, e.at DESC
  ) x;

  RETURN json_build_object(
    'movements', v_rows,
    'definition', 'Individual MTN / Airtel email movements matched to an active merchant agent desk phone. Read-only.'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_merchant_agent_movements(uuid) FROM public;
REVOKE ALL ON FUNCTION public.get_merchant_agent_movements(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_merchant_agent_movements(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_merchant_agent_movements(uuid) TO service_role;