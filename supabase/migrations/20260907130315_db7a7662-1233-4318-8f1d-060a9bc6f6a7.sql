-- 1. Earner now always pays immediately (no manual approval, switch no longer gates payment).
CREATE OR REPLACE FUNCTION public.credit_proxy_agent_portfolio_commission(
  p_partner_id uuid, p_base_amount numeric, p_kind text,
  p_source_table text, p_source_id uuid, p_dedupe_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_proxy_agent_id uuid;
  v_assignment_id uuid;
  v_rate numeric;
  v_amount numeric;
  v_idem text;
  v_queue_id uuid;
BEGIN
  IF p_partner_id IS NULL OR p_source_id IS NULL OR COALESCE(p_base_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','no_base_amount');
  END IF;

  IF p_kind NOT IN ('portfolio_creation','portfolio_topup') THEN
    RETURN jsonb_build_object('status','skipped','reason','unsupported_kind');
  END IF;

  SELECT a.agent_id, a.id
    INTO v_proxy_agent_id, v_assignment_id
  FROM public.proxy_agent_assignments a
  WHERE a.beneficiary_id = p_partner_id
    AND a.is_active = true
    AND COALESCE(a.is_managed_account, false) = true
    AND COALESCE(a.approval_status, 'pending') = 'approved'
    AND a.agent_id IS NOT NULL
    AND a.agent_id <> p_partner_id
    AND (a.expires_at IS NULL OR a.expires_at > now())
  ORDER BY a.approved_at DESC NULLS LAST, a.created_at DESC NULLS LAST, a.id
  LIMIT 1;

  IF v_proxy_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_active_managed_proxy');
  END IF;

  v_rate := CASE p_kind
    WHEN 'portfolio_creation' THEN 0.02
    WHEN 'portfolio_topup' THEN 0.01
    ELSE 0 END;

  v_amount := round(p_base_amount * v_rate);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('status','skipped','reason','amount_rounds_to_zero');
  END IF;

  v_idem := 'proxy_agent_portfolio_commission:' || p_kind || ':' || p_source_table || ':'
            || COALESCE(p_dedupe_key, p_source_id::text);

  IF EXISTS (SELECT 1 FROM public.proxy_commission_queue q WHERE q.idempotency_key = v_idem) THEN
    RETURN jsonb_build_object('status','skipped','reason','duplicate_source');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.general_ledger g
    WHERE g.idempotency_key = v_idem
      AND g.ledger_scope = 'wallet'
      AND g.direction = 'cash_in'
  ) THEN
    RETURN jsonb_build_object('status','skipped','reason','duplicate_source');
  END IF;

  INSERT INTO public.proxy_commission_queue
    (kind, agent_id, partner_id, assignment_id, base_amount, rate, amount,
     source_table, source_id, idempotency_key, status, auto_approved)
  VALUES (p_kind, v_proxy_agent_id, p_partner_id, v_assignment_id, p_base_amount, v_rate, v_amount,
          p_source_table, p_source_id::text, v_idem, 'pending', true)
  RETURNING id INTO v_queue_id;

  RETURN public.pay_proxy_commission_queue_item(v_queue_id)
         || jsonb_build_object('queue_id', v_queue_id, 'auto_approved', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.credit_proxy_agent_portfolio_commission(uuid,numeric,text,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_proxy_agent_portfolio_commission(uuid,numeric,text,text,uuid,text) TO service_role;

-- 2. Tracking read model for the Partner Ops Commissions page (read-only, no payment side effects).
CREATE OR REPLACE FUNCTION public.get_proxy_commission_tracker(
  p_search text DEFAULT NULL,
  p_kind text DEFAULT 'all',
  p_status text DEFAULT 'all',
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_rows jsonb;
  v_totals jsonb;
  v_total_count bigint;
  v_q text := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF NOT public.is_proxy_commission_admin() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _pct_scope (LIKE public.proxy_commission_queue) ON COMMIT DROP;

  WITH base AS (
    SELECT
      q.*,
      COALESCE(
        p_direct.id,
        p_via_op.id
      ) AS portfolio_id,
      COALESCE(p_direct.portfolio_code, p_via_op.portfolio_code) AS portfolio_code,
      COALESCE(p_direct.investment_amount, p_via_op.investment_amount) AS portfolio_amount,
      ap.full_name AS agent_name,
      ap.phone AS agent_phone,
      pp.full_name AS partner_name,
      pp.phone AS partner_phone
    FROM public.proxy_commission_queue q
    LEFT JOIN public.profiles ap ON ap.id = q.agent_id
    LEFT JOIN public.profiles pp ON pp.id = q.partner_id
    LEFT JOIN public.investor_portfolios p_direct
      ON q.source_table = 'investor_portfolios'
     AND p_direct.id = NULLIF(split_part(q.source_id, ':', 1), '')::uuid
    LEFT JOIN public.pending_wallet_operations op
      ON q.source_table = 'pending_wallet_operations'
     AND op.id = NULLIF(split_part(q.source_id, ':', 1), '')::uuid
    LEFT JOIN public.investor_portfolios p_via_op ON p_via_op.id = op.source_id
    WHERE (p_kind IS NULL OR p_kind = 'all' OR q.kind = p_kind)
      AND (p_status IS NULL OR p_status = 'all' OR q.status = p_status)
      AND (p_from IS NULL OR COALESCE(q.decided_at, q.created_at) >= p_from)
      AND (p_to IS NULL OR COALESCE(q.decided_at, q.created_at) < p_to)
  ), filtered AS (
    SELECT * FROM base
    WHERE v_q IS NULL
       OR agent_name ILIKE '%' || v_q || '%'
       OR partner_name ILIKE '%' || v_q || '%'
       OR COALESCE(agent_phone, '') ILIKE '%' || v_q || '%'
       OR COALESCE(partner_phone, '') ILIKE '%' || v_q || '%'
       OR COALESCE(portfolio_code, '') ILIKE '%' || v_q || '%'
       OR portfolio_id::text ILIKE '%' || v_q || '%'
       OR agent_id::text ILIKE '%' || v_q || '%'
       OR partner_id::text ILIKE '%' || v_q || '%'
       OR source_id ILIKE '%' || v_q || '%'
  )
  SELECT
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', f.id,
        'kind', f.kind,
        'kind_label', CASE WHEN f.kind = 'portfolio_creation'
                           THEN 'Portfolio created'
                           ELSE 'Portfolio topped up' END,
        'rate', f.rate,
        'status', f.status,
        'auto_approved', f.auto_approved,
        'portfolio_id', f.portfolio_id,
        'portfolio_code', f.portfolio_code,
        'portfolio_amount', f.portfolio_amount,
        'base_amount', f.base_amount,
        'commission_amount', f.amount,
        'paid_at', CASE WHEN f.status = 'paid' THEN f.decided_at END,
        'earned_at', f.created_at,
        'agent_id', f.agent_id,
        'agent_name', f.agent_name,
        'partner_id', f.partner_id,
        'partner_name', f.partner_name,
        'source_table', f.source_table,
        'source_id', f.source_id,
        'ledger_group_id', f.ledger_group_id
      ) ORDER BY COALESCE(f.decided_at, f.created_at) DESC)
      FROM (
        SELECT * FROM filtered
        ORDER BY COALESCE(decided_at, created_at) DESC
        LIMIT GREATEST(COALESCE(p_limit, 50), 1)
        OFFSET GREATEST(COALESCE(p_offset, 0), 0)
      ) f
    ), '[]'::jsonb),
    (SELECT COUNT(*) FROM filtered),
    (SELECT jsonb_build_object(
        'paid_count', COUNT(*) FILTER (WHERE status = 'paid'),
        'paid_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0),
        'creation_paid_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'paid' AND kind = 'portfolio_creation'), 0),
        'topup_paid_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'paid' AND kind = 'portfolio_topup'), 0),
        'pending_count', COUNT(*) FILTER (WHERE status = 'pending'),
        'pending_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0),
        'rejected_count', COUNT(*) FILTER (WHERE status = 'rejected'),
        'portfolio_volume', COALESCE(SUM(base_amount) FILTER (WHERE status = 'paid'), 0)
      ) FROM filtered)
  INTO v_rows, v_total_count, v_totals;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'total_count', v_total_count,
    'totals', v_totals
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_proxy_commission_tracker(text, text, text, timestamptz, timestamptz, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_proxy_commission_tracker(text, text, text, timestamptz, timestamptz, int, int) TO authenticated, service_role;