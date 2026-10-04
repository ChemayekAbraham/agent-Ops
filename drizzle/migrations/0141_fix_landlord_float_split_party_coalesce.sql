CREATE OR REPLACE FUNCTION public.get_landlord_float_management_split(p_as_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_total numeric := 0;
  v_self numeric := 0;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the landlord float breakdown';
  END IF;

  -- Presentation split only: the same legs the statement of financial position
  -- reports under L4 (Landlord Rent Payable), grouped by the landlord record's
  -- existing management flag. Nothing is written and no amount is invented.
  -- linked_party is text while user_id/source_id are uuid, so the party key is
  -- built in text to keep the COALESCE type-consistent.
  WITH grp AS (
    SELECT gl.transaction_group_id,
           bool_or(gl.classification IN ('production','legacy_real')) AS reportable
    FROM general_ledger gl
    WHERE gl.transaction_group_id IS NOT NULL
    GROUP BY 1
  ), legs AS (
    SELECT gl.id,
           CASE WHEN gl.direction = 'cash_in' THEN -gl.amount ELSE gl.amount END AS credit_net,
           COALESCE(gl.linked_party, gl.user_id::text, gl.source_id::text) AS party
    FROM general_ledger gl
    LEFT JOIN grp g ON g.transaction_group_id = gl.transaction_group_id
    JOIN ledger_account_map m
      ON m.ledger_scope = gl.ledger_scope
     AND m.category = gl.category
     AND (m.wallet_bucket IS NULL OR m.wallet_bucket = gl.wallet_bucket)
    WHERE m.account_code = 'L4'
      AND gl.transaction_date <= p_as_at
      AND CASE
            WHEN gl.transaction_group_id IS NULL THEN gl.classification IN ('production','legacy_real')
            ELSE COALESCE(g.reportable, false)
          END
  ), tagged AS (
    SELECT l.credit_net,
           EXISTS (
             SELECT 1 FROM landlords ld
             WHERE ld.id::text = l.party
               AND COALESCE(ld.is_agent_managed, false) = false
           ) AS self_managed
    FROM legs l
  )
  SELECT COALESCE(SUM(credit_net),0),
         COALESCE(SUM(credit_net) FILTER (WHERE self_managed),0)
  INTO v_total, v_self
  FROM tagged;

  RETURN jsonb_build_object(
    'as_at', p_as_at,
    'total', ROUND(v_total),
    'self_managed', ROUND(v_self),
    'company_managed', ROUND(v_total) - ROUND(v_self)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_landlord_float_management_split(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_landlord_float_management_split(timestamptz) TO authenticated, service_role;