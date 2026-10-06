-- CFO withdrawable credits report: paged rows + a totals branch for the money-drilldown totals RPC.
-- Read-only, role-gated, ledger-only. No data is written.

-- Friendly source group for a ledger category. Mirrors src/lib/withdrawableCreditsGroups.ts — keep in sync.
CREATE OR REPLACE FUNCTION public._cfo_credit_type(p_category text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_category IN ('roi_wallet_credit','roi_payout') THEN 'Supporter returns'
    WHEN p_category = 'wallet_deposit' THEN 'Deposits'
    WHEN p_category = 'wallet_transfer' THEN 'Wallet transfers in'
    WHEN p_category = 'bucket_reclass_in' THEN 'Float moved to withdrawable'
    WHEN p_category IN ('agent_commission','agent_commission_earned','partner_commission','proxy_investment_commission','agent_investment_commission') THEN 'Commissions'
    WHEN p_category = 'agent_advance_credit' THEN 'Agent advances'
    WHEN p_category = 'system_balance_correction' THEN 'Corrections'
    WHEN p_category LIKE '%bonus%' THEN 'Bonuses'
    WHEN p_category LIKE '%salary%' OR p_category LIKE '%payroll%' THEN 'Salary & payroll'
    WHEN p_category LIKE '%correction%' THEN 'Corrections'
    WHEN p_category LIKE '%commission%' THEN 'Commissions'
    ELSE 'Other'
  END;
$function$;
REVOKE ALL ON FUNCTION public._cfo_credit_type(text) FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_cfo_withdrawable_credits_page(
  p_from timestamptz, p_to timestamptz,
  p_type text DEFAULT NULL, p_person text DEFAULT NULL,
  p_offset int DEFAULT 0, p_limit int DEFAULT 50)
 RETURNS TABLE(created_at timestamptz, id uuid, category text, credit_type text,
   full_name text, phone text, description text, reference_id text, amount numeric, ledger_reference text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'ceo') OR has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY
  SELECT g.created_at, g.id, g.category::text, public._cfo_credit_type(g.category),
         COALESCE(p.full_name,'Unknown')::text, p.phone::text,
         g.description::text, g.reference_id::text, g.amount,
         g.transaction_group_id::text
  FROM general_ledger g
  LEFT JOIN profiles p ON p.id = g.user_id
  WHERE g.wallet_bucket = 'withdrawable'
    AND g.direction = 'cash_in'
    AND g.created_at >= p_from
    AND (p_to IS NULL OR g.created_at < p_to)
    AND (p_type IS NULL OR public._cfo_credit_type(g.category) = p_type)
    AND (p_person IS NULL OR COALESCE(p.full_name,'Unknown') ILIKE '%' || p_person || '%'
         OR p.phone ILIKE '%' || p_person || '%')
  ORDER BY g.created_at DESC, g.id
  OFFSET GREATEST(COALESCE(p_offset,0), 0)
  LIMIT LEAST(GREATEST(COALESCE(p_limit,50), 1), 1000);
END
$function$;
REVOKE ALL ON FUNCTION public.get_cfo_withdrawable_credits_page(timestamptz, timestamptz, text, text, int, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_cfo_withdrawable_credits_page(timestamptz, timestamptz, text, text, int, int) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_cfo_money_drilldown_totals(p_kind text, p_from timestamptz, p_to timestamptz, p_status text DEFAULT NULL, p_method text DEFAULT NULL, p_type text DEFAULT NULL, p_person text DEFAULT NULL)
 RETURNS TABLE(match_count bigint, confirmed_count bigint, pending_count bigint, confirmed_amount numeric, pending_amount numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (has_role(auth.uid(),'cfo') OR has_role(auth.uid(),'ceo') OR has_role(auth.uid(),'super_admin')) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_kind = 'paid_out' THEN
    RETURN QUERY
    SELECT count(*), count(*) FILTER (WHERE b.status <> 'pending'), count(*) FILTER (WHERE b.status = 'pending'),
      COALESCE(sum(b.amount) FILTER (WHERE b.status <> 'pending'),0), COALESCE(sum(b.amount) FILTER (WHERE b.status = 'pending'),0)
    FROM public._cfo_paid_out_base(p_from, p_to, p_status, p_method, p_type, p_person) b;
  ELSIF p_kind = 'received' THEN
    RETURN QUERY
    SELECT count(*), count(*) FILTER (WHERE b.status <> 'pending'), count(*) FILTER (WHERE b.status = 'pending'),
      COALESCE(sum(b.amount) FILTER (WHERE b.status <> 'pending'),0), COALESCE(sum(b.amount) FILTER (WHERE b.status = 'pending'),0)
    FROM public._cfo_received_base(p_from, p_to, p_status, p_method, p_type, p_person) b;
  ELSIF p_kind = 'credits' THEN
    -- Ledger credits into the withdrawable bucket. No pending concept: every row is confirmed.
    RETURN QUERY
    SELECT count(*), count(*), 0::bigint,
      COALESCE(sum(g.amount),0), 0::numeric
    FROM general_ledger g
    LEFT JOIN profiles p ON p.id = g.user_id
    WHERE g.wallet_bucket = 'withdrawable'
      AND g.direction = 'cash_in'
      AND g.created_at >= p_from
      AND (p_to IS NULL OR g.created_at < p_to)
      AND (p_type IS NULL OR public._cfo_credit_type(g.category) = p_type)
      AND (p_person IS NULL OR COALESCE(p.full_name,'Unknown') ILIKE '%' || p_person || '%'
           OR p.phone ILIKE '%' || p_person || '%');
  ELSE
    RAISE EXCEPTION 'unknown kind';
  END IF;
END
$function$;