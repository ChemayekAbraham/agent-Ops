-- get_landlord_float_due_today (2026-09-18): follow-up to
-- 20260918140000_wallet_bucket_totals_landlord_float_due_today.sql. That
-- migration fixed the Wallet Buckets *list* tile to show today's obligation
-- (~4M) instead of the total float held (~80M). Clicking into the tile opens
-- WalletBucketHoldersPanel's "Landlord Float — Holders" drilldown, which
-- reads agent_landlord_float.balance directly (every agent's running float
-- balance, unrelated to today) and confused Josh when it kept showing ~80M
-- right next to a tile that now said ~4M.
--
-- Josh confirmed he wants the holders drilldown scoped to "today" too. The
-- per-agent source for that is agent_landlord_float_allocations (open/
-- partially_paid earmarks, already linked to a specific rent_request_id and
-- agent_id) joined to rent_requests.funded_at -- the same definition as the
-- tile fix, just grouped by agent instead of summed platform-wide. This RPC
-- returns both the per-agent holder rows and the company-vs-funder source
-- split in one call so the drilldown's summary cards and its list can never
-- disagree with each other.
CREATE OR REPLACE FUNCTION public.get_landlord_float_due_today()
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_finance boolean;
  v_holders json;
  v_company numeric := 0;
  v_company_count integer := 0;
  v_funder numeric := 0;
  v_funder_count integer := 0;
BEGIN
  v_is_finance := public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'financial_ops')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'coo');

  IF NOT v_is_finance THEN
    RAISE EXCEPTION 'Landlord float due-today detail is only visible to finance roles';
  END IF;

  WITH due_today AS (
    SELECT a.agent_id, a.landlord_name, a.remaining_amount, a.source
    FROM public.agent_landlord_float_allocations a
    JOIN public.rent_requests rr ON rr.id = a.rent_request_id
    WHERE a.status IN ('open', 'partially_paid')
      AND rr.funded_at IS NOT NULL
      AND (rr.funded_at AT TIME ZONE 'Africa/Kampala')::date = (now() AT TIME ZONE 'Africa/Kampala')::date
  )
  SELECT COALESCE(json_agg(x ORDER BY (x->>'amount')::numeric DESC), '[]'::json)
  INTO v_holders
  FROM (
    SELECT json_build_object(
             'agent_id', agent_id,
             'amount', SUM(remaining_amount),
             'landlord_names', array_agg(DISTINCT landlord_name),
             'rent_request_count', COUNT(*)
           ) AS x
    FROM due_today
    GROUP BY agent_id
  ) g;

  SELECT
    COALESCE(SUM(remaining_amount) FILTER (WHERE source = 'partner_self_funding'), 0),
    COUNT(*) FILTER (WHERE source = 'partner_self_funding'),
    COALESCE(SUM(remaining_amount) FILTER (WHERE source <> 'partner_self_funding'), 0),
    COUNT(*) FILTER (WHERE source <> 'partner_self_funding')
  INTO v_funder, v_funder_count, v_company, v_company_count
  FROM due_today;

  RETURN json_build_object(
    'holders', v_holders,
    'company_amount', v_company,
    'company_count', v_company_count,
    'funder_amount', v_funder,
    'funder_count', v_funder_count,
    'computed_at', now()
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_landlord_float_due_today() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_landlord_float_due_today() TO authenticated;
