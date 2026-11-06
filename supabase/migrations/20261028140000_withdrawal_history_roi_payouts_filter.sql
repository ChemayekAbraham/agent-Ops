-- Withdrawal History (Financial Ops): an "ROI payouts" filter.
--
-- WHAT COUNTS AS AN ROI PAYOUT: a withdrawal delivered to a partner's portfolio by a proxy agent. The managed ROI payout is credited to the proxy
-- agent's wallet and then paid out to the partner; those withdrawals carry proxy_partner_id and a reason starting "[Proxy initiated by agent ...]"
-- ("Proxy payout delivery for <partner> (Portfolio: ...)"). In the last 30 days that is 1,000 of about 2,000 withdrawals, UGX 1.26 billion.
--
-- WHAT CHANGES: get_withdrawal_history gains
--   * a fourth argument p_roi_only boolean DEFAULT false. When true only ROI payouts are returned, counted and paged on the server (so the total
--     and "load more" are right, not just the 50 rows on screen).
--   * a last column is_roi_payout boolean, true for those rows.
-- Everything else is as it was: the same role check, the same search, the same balance before and after, landlord payouts still left out. The web
-- calls it with three named arguments and ignores the new column, so it keeps working.
-- The old three-argument function is dropped first because a function cannot change what it returns in place; grants are set again below.
-- Roll back with 20261028140000_withdrawal_history_roi_payouts_filter.rollback.sql.

DROP FUNCTION IF EXISTS public.get_withdrawal_history(text, integer, integer);

CREATE FUNCTION public.get_withdrawal_history(p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_roi_only boolean DEFAULT false)
 RETURNS TABLE(withdrawal_id uuid, user_id uuid, user_name text, user_phone text, amount numeric, status text, payout_method text, transaction_id text, mobile_money_number text, mobile_money_provider text, bank_name text, bank_account_number text, created_at timestamp with time zone, processed_at timestamp with time zone, balance_before numeric, balance_after numeric, total_count bigint, is_roi_payout boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'coo')
    OR public.has_role(auth.uid(), 'ceo')
    OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'operations')
    OR public.has_role(auth.uid(), 'super_admin')
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  RETURN QUERY
  WITH filtered AS (
    SELECT wr.id, wr.user_id, wr.amount, wr.status, wr.payout_method,
           wr.transaction_id, wr.mobile_money_number, wr.mobile_money_provider,
           wr.bank_name, wr.bank_account_number,
           wr.created_at, wr.processed_at,
           p.full_name, p.phone,
           (wr.proxy_partner_id IS NOT NULL OR COALESCE(wr.reason, '') ILIKE '[Proxy initiated%') AS roi
    FROM public.withdrawal_requests wr
    LEFT JOIN public.profiles p ON p.id = wr.user_id
    WHERE wr.landlord_payout_id IS NULL
      AND COALESCE(wr.reason, '') NOT ILIKE 'Landlord float payout%'
      AND (
        NOT COALESCE(p_roi_only, false)
        OR wr.proxy_partner_id IS NOT NULL OR COALESCE(wr.reason, '') ILIKE '[Proxy initiated%'
      )
      AND (
        p_search IS NULL OR p_search = ''
        OR p.full_name ILIKE '%' || p_search || '%'
        OR p.phone ILIKE '%' || p_search || '%'
        OR wr.transaction_id ILIKE '%' || p_search || '%'
        OR wr.mobile_money_number ILIKE '%' || p_search || '%'
        OR wr.id::text = p_search
      )
  ),
  counted AS (SELECT COUNT(*) AS n FROM filtered),
  page AS (
    SELECT * FROM filtered ORDER BY created_at DESC
    LIMIT GREATEST(p_limit, 1) OFFSET GREATEST(p_offset, 0)
  ),
  with_balance AS (
    SELECT pg.*,
      COALESCE((
        SELECT SUM(CASE WHEN gl.direction = 'cash_in' THEN gl.amount ELSE -gl.amount END)
        FROM public.general_ledger gl
        WHERE gl.user_id = pg.user_id
          AND gl.ledger_scope = 'wallet'
          AND gl.classification <> 'admin_correction'
          AND gl.category <> 'system_balance_correction'
          AND gl.transaction_date <= COALESCE(pg.processed_at, pg.created_at)
      ), 0) AS balance_after_calc
    FROM page pg
  )
  SELECT
    wb.id, wb.user_id, wb.full_name, wb.phone, wb.amount, wb.status, wb.payout_method,
    wb.transaction_id, wb.mobile_money_number, wb.mobile_money_provider,
    wb.bank_name, wb.bank_account_number, wb.created_at, wb.processed_at,
    CASE WHEN wb.status IN ('completed','approved','paid','processed','fin_ops_approved')
      THEN wb.balance_after_calc + wb.amount ELSE wb.balance_after_calc END,
    CASE WHEN wb.status IN ('completed','approved','paid','processed','fin_ops_approved')
      THEN wb.balance_after_calc ELSE wb.balance_after_calc - wb.amount END,
    (SELECT n FROM counted),
    wb.roi
  FROM with_balance wb
  ORDER BY wb.created_at DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_withdrawal_history(text, integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_withdrawal_history(text, integer, integer, boolean) TO authenticated, service_role;
