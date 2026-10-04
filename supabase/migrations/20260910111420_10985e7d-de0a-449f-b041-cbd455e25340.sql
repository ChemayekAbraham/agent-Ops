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
    SELECT right(regexp_replace(x, '\D', '', 'g'), 9) AS p9,
           bool_or(ca.is_active) AS any_active,
           (array_agg(ca.id ORDER BY ca.is_active DESC))[1] AS desk_id
    FROM public.cashout_agents ca,
         unnest(ARRAY[COALESCE(ca.float_phone,''), COALESCE(ca.personal_phone,'')]) AS x
    WHERE length(regexp_replace(x, '\D', '', 'g')) >= 9
    GROUP BY 1
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
  ), joined AS (
    SELECT e.*, d.p9 AS desk_p9, d.any_active, d.desk_id
    FROM emails e
    LEFT JOIN desk_phones d ON d.p9 = e.p9
  ), flagged AS (
    SELECT j.*,
           (SELECT p.full_name FROM public.profiles p
             WHERE j.p9 IS NOT NULL
               AND right(regexp_replace(COALESCE(p.phone,''), '\D', '', 'g'), 9) = j.p9
             LIMIT 1) AS profile_name,
           (SELECT p.email FROM public.profiles p
             WHERE j.p9 IS NOT NULL
               AND right(regexp_replace(COALESCE(p.phone,''), '\D', '', 'g'), 9) = j.p9
             LIMIT 1) AS profile_email,
           (SELECT p.id FROM public.profiles p
             WHERE j.p9 IS NOT NULL
               AND right(regexp_replace(COALESCE(p.phone,''), '\D', '', 'g'), 9) = j.p9
             LIMIT 1) AS profile_id,
           CASE
             WHEN j.p9 IS NULL THEN 'no_recipient_number'
             WHEN j.desk_p9 IS NULL THEN 'no_desk_match'
             WHEN j.any_active IS NOT TRUE THEN 'inactive_desk_match'
           END AS reason_code
    FROM joined j
    WHERE j.p9 IS NULL
       OR j.desk_p9 IS NULL
       OR j.any_active IS NOT TRUE
  )
  SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json), COALESCE(SUM(x.amount), 0)
  INTO v_rows, v_total
  FROM (
    SELECT f.id::text AS id, f.amount, f.channel, f.at, f.transaction_id,
           f.counterparty, f.subject, f.snippet, f.p9 AS recipient_phone,
           f.profile_name, f.profile_email, f.profile_id::text AS profile_id,
           f.reason_code,
           f.desk_id::text AS matched_desk_id,
           CASE
             WHEN f.p9 IS NULL THEN 'no_number_found'
             WHEN f.desk_p9 IS NULL THEN 'not_a_merchant_agent'
             ELSE 'inactive_merchant_desk'
           END AS merchant_match_status,
           CASE f.reason_code
             WHEN 'no_recipient_number' THEN 'No recipient number could be read from this email, so it cannot be matched to a merchant agent desk.'
             WHEN 'no_desk_match' THEN 'The recipient number does not belong to any merchant agent desk, active or inactive.'
             ELSE 'The recipient number belongs to a merchant agent desk that is no longer active.'
           END AS reason
    FROM flagged f
  ) x;

  RETURN json_build_object(
    'transfers', v_rows,
    'total', v_total,
    'definition', 'Money-out MTN / Airtel email transfers that could not be matched to an active merchant agent desk, each with the reason for exclusion. Read-only flag.'
  );
END;
$function$;