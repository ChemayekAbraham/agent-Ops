CREATE OR REPLACE FUNCTION public.get_landlord_float_management_split(p_as_at date DEFAULT CURRENT_DATE)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_total numeric := 0;
  v_self numeric := 0;
  v_company numeric := 0;
  v_unresolved numeric := 0;
BEGIN
  IF v_uid IS NULL
     OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
       OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
       OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
     ) THEN
    RAISE EXCEPTION 'Not authorised to view the landlord float breakdown';
  END IF;

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
           -- Self-managed means the rent plan was funded directly by a funder
           -- (rent_requests.self_funding_partner_id). Reach it through the
           -- subscription the leg references, then that tenant's rent plan.
           CASE
             WHEN s.id IS NULL THEN NULL -- unresolved: party is not a known subscription
             WHEN EXISTS (
               SELECT 1 FROM rent_requests rr
               WHERE rr.tenant_id = s.tenant_id
                 AND rr.self_funding_partner_id IS NOT NULL
                 AND rr.status IN ('funded','repaying','completed')
             ) THEN true
             ELSE false
           END AS self_managed
    FROM legs l
    LEFT JOIN welile_homes_subscriptions s ON s.id::text = l.party
  )
  SELECT COALESCE(SUM(credit_net),0),
         COALESCE(SUM(credit_net) FILTER (WHERE self_managed IS TRUE),0),
         COALESCE(SUM(credit_net) FILTER (WHERE self_managed IS FALSE),0),
         COALESCE(SUM(credit_net) FILTER (WHERE self_managed IS NULL),0)
  INTO v_total, v_self, v_company, v_unresolved
  FROM tagged;

  RETURN jsonb_build_object(
    'as_at', p_as_at,
    'total', ROUND(v_total),
    'self_managed', ROUND(v_self),
    'company_managed', ROUND(v_company),
    'unresolved', ROUND(v_unresolved)
  );
END;
$$;