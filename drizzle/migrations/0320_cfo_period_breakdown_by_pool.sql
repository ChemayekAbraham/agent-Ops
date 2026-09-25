-- CFO period breakdown: "what the transactions were for", labeled by money pool.
--
-- Mirrors get_cfo_daily_cash_flow's population (classification production +
-- legacy_real, ALL ledger scopes, same Kampala day windows) so that every
-- expanded period's breakdown reconciles exactly with its Money In / Money
-- Out totals. The previous breakdown source (get_wallet_ledger_category_sums)
-- only read wallet-scope legs, so landlord float credits — which post to the
-- bridge scope as "Landlord float credited – <landlord>" — never appeared.
--
-- Pools (plain language for the CFO dashboard):
--   'Landlord Float'             landlord float credits, landlord float payouts,
--                                landlord receivable legs, landlord rent payments
--   'Agent & Operational Float'  float-bucket wallet legs + agent_float_* categories
--   'Wallet (withdrawable)'      withdrawable-bucket wallet legs
--   'Platform & custody'         everything else (platform income/expense, bridge
--                                custody, advance credits, unscoped legs)

CREATE OR REPLACE FUNCTION public.get_cfo_period_breakdown(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(pool text, category text, direction text, amount numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
  WITH legs AS (
    SELECT
      CASE
        WHEN g.ledger_scope = 'bridge' AND g.description ILIKE 'Landlord float credited%'
          THEN 'landlord_float_credited'
        ELSE g.category::text
      END AS cat,
      g.wallet_bucket,
      g.direction::text AS dir,
      g.amount
    FROM public.general_ledger g
    WHERE g.classification IN ('production', 'legacy_real')
      AND g.transaction_date >= p_from
      AND g.transaction_date < p_to
  )
  SELECT
    CASE
      WHEN l.cat IN (
        'landlord_float_credited',
        'agent_landlord_payout',
        'rent_float_funding',
        'landlord_receivable_created',
        'landlord_receivable_obligation',
        'landlord_receivable_collected',
        'landlord_rent_payment'
      ) THEN 'Landlord Float'
      WHEN l.wallet_bucket = 'float' THEN 'Agent & Operational Float'
      WHEN l.wallet_bucket = 'withdrawable' THEN 'Wallet (withdrawable)'
      WHEN l.cat LIKE 'agent_float%' THEN 'Agent & Operational Float'
      ELSE 'Platform & custody'
    END AS pool,
    l.cat AS category,
    l.dir AS direction,
    sum(l.amount)::numeric AS amount
  FROM legs l
  GROUP BY 1, 2, 3;
$$;

REVOKE ALL ON FUNCTION public.get_cfo_period_breakdown(timestamptz, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_period_breakdown(timestamptz, timestamptz)
  TO authenticated, service_role;
