-- Presentation-only fix: the L4 (landlord float / rent payable) legs carry a
-- welile_homes_subscriptions id as their party, never a landlords id, so the
-- previous landlord lookup matched nothing and the whole balance defaulted to
-- "company managed". Resolve the landlord through the subscription instead:
--   1. subscription.landlord_id -> landlords.is_agent_managed
--   2. otherwise, a UNIQUE landlord phone match on the subscription's
--      landlord_phone (ambiguous or absent matches stay unresolved)
--   3. legs whose landlord cannot be identified are reported as unresolved
--      rather than silently counted as company managed.
-- Reads only; nothing is written and no amount is invented.
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
  ), resolved AS (
    SELECT l.credit_net,
           -- landlord record reached directly by party, or through the
           -- subscription the leg actually references.
           COALESCE(
             (SELECT ld.id FROM landlords ld WHERE ld.id::text = l.party),
             (SELECT s.landlord_id FROM welile_homes_subscriptions s
               WHERE s.id::text = l.party AND s.landlord_id IS NOT NULL),
             (SELECT m.id FROM welile_homes_subscriptions s
               JOIN landlords m
                 ON right(regexp_replace(COALESCE(m.phone,''),'\D','','g'),9)
                  = right(regexp_replace(COALESCE(s.landlord_phone,''),'\D','','g'),9)
              WHERE s.id::text = l.party
                AND COALESCE(s.landlord_phone,'') <> ''
                AND (SELECT COUNT(*) FROM landlords m2
                      WHERE right(regexp_replace(COALESCE(m2.phone,''),'\D','','g'),9)
                          = right(regexp_replace(COALESCE(s.landlord_phone,''),'\D','','g'),9)) = 1
              LIMIT 1)
           ) AS landlord_id
    FROM legs l
  ), tagged AS (
    SELECT r.credit_net,
           r.landlord_id IS NULL AS unresolved,
           COALESCE((SELECT COALESCE(ld.is_agent_managed,false) = false
                       FROM landlords ld WHERE ld.id = r.landlord_id), false) AS self_managed
    FROM resolved r
  )
  SELECT COALESCE(SUM(credit_net),0),
         COALESCE(SUM(credit_net) FILTER (WHERE NOT unresolved AND self_managed),0),
         COALESCE(SUM(credit_net) FILTER (WHERE NOT unresolved AND NOT self_managed),0),
         COALESCE(SUM(credit_net) FILTER (WHERE unresolved),0)
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
$function$;