CREATE OR REPLACE FUNCTION public.get_unregistered_recipient_transfers(p_days integer DEFAULT 120)
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows json;
  v_total numeric := 0;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'financial_ops')
  ) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  WITH desk_phones AS (
    SELECT DISTINCT right(regexp_replace(x, '\D', '', 'g'), 9) AS p9
    FROM public.cashout_agents ca,
         unnest(ARRAY[COALESCE(ca.float_phone,''), COALESCE(ca.personal_phone,'')]) AS x
    WHERE ca.is_active = true
      AND length(regexp_replace(x, '\D', '', 'g')) >= 9
  ), emails AS (
    SELECT gt.id, gt.amount, gt.channel, gt.subject, gt.snippet,
           gt.transaction_id, gt.counterparty,
           COALESCE(gt.internal_date, gt.created_at) AS at,
           COALESCE(
             NULLIF(right(regexp_replace(COALESCE(gt.counterparty, ''), '\D', '', 'g'), 9), ''),
             NULLIF(right(regexp_replace(COALESCE(substring(gt.snippet from 'Mobile Number: *([0-9]{9,13})'), ''), '\D', '', 'g'), 9), ''),
             NULLIF(right(regexp_replace(COALESCE(substring(gt.snippet from 'to [^,]+, *([0-9]{9,13})'), ''), '\D', '', 'g'), 9), '')
           ) AS p9
    FROM public.gmail_transactions gt
    WHERE gt.channel IN ('mtn_momo', 'airtel_money')
      AND gt.direction = 'out'
      AND gt.amount IS NOT NULL
      AND COALESCE(gt.internal_date, gt.created_at) >= now() - (GREATEST(COALESCE(p_days, 120), 1) || ' days')::interval
  ), flagged AS (
    SELECT e.*,
           (SELECT p.full_name FROM public.profiles p
             WHERE right(regexp_replace(COALESCE(p.phone,''), '\D', '', 'g'), 9) = e.p9
             LIMIT 1) AS profile_name,
           (SELECT p.id FROM public.profiles p
             WHERE right(regexp_replace(COALESCE(p.phone,''), '\D', '', 'g'), 9) = e.p9
             LIMIT 1) AS profile_id
    FROM emails e
    WHERE e.p9 IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM desk_phones d WHERE d.p9 = e.p9)
  )
  SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json), COALESCE(SUM(x.amount), 0)
  INTO v_rows, v_total
  FROM (
    SELECT f.id::text AS id, f.amount, f.channel, f.at, f.transaction_id,
           f.counterparty, f.subject, f.snippet, f.p9 AS recipient_phone,
           f.profile_name, f.profile_id::text AS profile_id
    FROM flagged f
  ) x;

  RETURN json_build_object(
    'transfers', v_rows,
    'total', v_total,
    'definition', 'Money-out MTN / Airtel email transfers whose recipient number is not on any active merchant agent desk. Read-only flag.'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_unregistered_recipient_transfers(integer) FROM public;
REVOKE ALL ON FUNCTION public.get_unregistered_recipient_transfers(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_unregistered_recipient_transfers(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_unregistered_recipient_transfers(integer) TO service_role;