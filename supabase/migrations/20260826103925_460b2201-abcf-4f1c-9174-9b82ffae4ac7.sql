BEGIN;

CREATE OR REPLACE FUNCTION public.credit_proxy_agent_portfolio_commission(
  p_partner_id uuid,
  p_base_amount numeric,
  p_kind text,
  p_source_table text,
  p_source_id uuid,
  p_dedupe_key text DEFAULT NULL::text
)
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
  v_group uuid;
  v_label text;
BEGIN
  IF p_partner_id IS NULL OR p_source_id IS NULL OR coalesce(p_base_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_base_amount');
  END IF;

  IF p_kind NOT IN ('portfolio_creation', 'portfolio_topup') THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'unsupported_kind');
  END IF;

  SELECT a.agent_id, a.id
    INTO v_proxy_agent_id, v_assignment_id
  FROM public.proxy_agent_assignments a
  WHERE a.beneficiary_id = p_partner_id
    AND a.is_active = true
    AND coalesce(a.is_managed_account, false) = true
    AND coalesce(a.approval_status, 'pending') = 'approved'
    AND a.agent_id IS NOT NULL
    AND a.agent_id <> p_partner_id
    AND (a.expires_at IS NULL OR a.expires_at > now())
  ORDER BY a.approved_at DESC NULLS LAST, a.created_at DESC NULLS LAST, a.id
  LIMIT 1;

  IF v_proxy_agent_id IS NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_active_managed_proxy');
  END IF;

  v_rate := CASE p_kind
    WHEN 'portfolio_creation' THEN 0.02
    WHEN 'portfolio_topup' THEN 0.01
    ELSE 0
  END;

  v_amount := round(p_base_amount * v_rate);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'amount_rounds_to_zero');
  END IF;

  v_idem := 'proxy_agent_portfolio_commission:' || p_kind || ':' || p_source_table || ':' || coalesce(p_dedupe_key, p_source_id::text);

  IF EXISTS (
    SELECT 1
    FROM public.general_ledger g
    WHERE g.idempotency_key = v_idem
      AND g.ledger_scope = 'wallet'
      AND g.direction = 'cash_in'
      AND g.category = 'partner_commission'
  ) THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'duplicate_source');
  END IF;

  v_label := CASE WHEN p_kind = 'portfolio_creation'
                  THEN 'Managed proxy portfolio activation commission ('
                  ELSE 'Managed proxy portfolio top-up commission (' END
             || to_char(v_rate * 100, 'FM999.99') || '%)';

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', v_proxy_agent_id,
        'amount', v_amount,
        'direction', 'cash_out',
        'category', 'partner_commission',
        'source_table', p_source_table,
        'source_id', p_source_id::text,
        'reference_id', v_idem,
        'description', 'Platform expense: ' || v_label,
        'ledger_scope', 'platform',
        'linked_party', p_partner_id::text
      ),
      jsonb_build_object(
        'user_id', v_proxy_agent_id,
        'amount', v_amount,
        'direction', 'cash_in',
        'category', 'partner_commission',
        'source_table', p_source_table,
        'source_id', p_source_id::text,
        'reference_id', v_idem,
        'description', v_label,
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'linked_party', p_partner_id::text
      )
    ),
    v_idem
  );

  INSERT INTO public.system_events (event_type, user_id, entity_type, entity_id, metadata)
  VALUES (
    'wallet_transfer',
    v_proxy_agent_id,
    'proxy_agent_portfolio_commission',
    p_source_id,
    jsonb_build_object(
      'kind', p_kind,
      'partner_id', p_partner_id,
      'proxy_agent_id', v_proxy_agent_id,
      'assignment_id', v_assignment_id,
      'base_amount', p_base_amount,
      'rate', v_rate,
      'commission_amount', v_amount,
      'source_table', p_source_table,
      'source_id', p_source_id,
      'idempotency_key', v_idem,
      'ledger_group_id', v_group
    )
  );

  RETURN jsonb_build_object(
    'status', 'paid',
    'amount', v_amount,
    'rate', v_rate,
    'agent_id', v_proxy_agent_id,
    'assignment_id', v_assignment_id,
    'ledger_group_id', v_group
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.try_credit_proxy_agent_portfolio_commission(
  p_partner_id uuid,
  p_base_amount numeric,
  p_kind text,
  p_source_table text,
  p_source_id uuid,
  p_dedupe_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.credit_proxy_agent_portfolio_commission(
    p_partner_id,
    p_base_amount,
    p_kind,
    p_source_table,
    p_source_id,
    p_dedupe_key
  );
  RETURN v_result;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.system_events (event_type, user_id, entity_type, entity_id, metadata)
  VALUES (
    'wallet_transfer',
    p_partner_id,
    'proxy_agent_portfolio_commission_failure',
    p_source_id,
    jsonb_build_object(
      'kind', p_kind,
      'partner_id', p_partner_id,
      'base_amount', p_base_amount,
      'source_table', p_source_table,
      'source_id', p_source_id,
      'dedupe_key', p_dedupe_key,
      'error_code', SQLSTATE,
      'error_message', SQLERRM
    )
  );
  RETURN jsonb_build_object('status', 'failed', 'error_code', SQLSTATE, 'error_message', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_proxy_agent_portfolio_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_delta numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'active' AND coalesce(NEW.investment_amount, 0) > 0 THEN
      PERFORM public.try_credit_proxy_agent_portfolio_commission(
        NEW.investor_id,
        NEW.investment_amount,
        'portfolio_creation',
        'investor_portfolios',
        NEW.id,
        NEW.id::text
      );
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.status = 'active'
     AND coalesce(OLD.status, '') <> 'active'
     AND coalesce(NEW.investment_amount, 0) > 0 THEN
    PERFORM public.try_credit_proxy_agent_portfolio_commission(
      NEW.investor_id,
      NEW.investment_amount,
      'portfolio_creation',
      'investor_portfolios',
      NEW.id,
      NEW.id::text
    );
    RETURN NULL;
  END IF;

  v_delta := coalesce(NEW.investment_amount, 0) - coalesce(OLD.investment_amount, 0);
  IF v_delta > 0 AND NEW.status = 'active' THEN
    PERFORM public.try_credit_proxy_agent_portfolio_commission(
      NEW.investor_id,
      v_delta,
      'portfolio_topup',
      'investor_portfolios',
      NEW.id,
      NEW.id::text || ':' || round(coalesce(NEW.investment_amount, 0))::text
    );
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_proxy_agent_portfolio_commission ON public.investor_portfolios;
CREATE TRIGGER trg_proxy_agent_portfolio_commission
AFTER INSERT OR UPDATE OF status, investment_amount ON public.investor_portfolios
FOR EACH ROW
EXECUTE FUNCTION public.trg_proxy_agent_portfolio_commission();

CREATE OR REPLACE FUNCTION public.trg_proxy_agent_portfolio_topup_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_partner_id uuid;
BEGIN
  IF NEW.operation_type = 'portfolio_topup'
     AND NEW.status = 'approved'
     AND (TG_OP = 'INSERT' OR coalesce(OLD.status, '') <> 'approved')
     AND coalesce(NEW.amount, 0) > 0 THEN

    SELECT p.investor_id
      INTO v_partner_id
    FROM public.investor_portfolios p
    WHERE p.id = NEW.source_id
    LIMIT 1;

    PERFORM public.try_credit_proxy_agent_portfolio_commission(
      coalesce(v_partner_id, NEW.user_id),
      NEW.amount,
      'portfolio_topup',
      'pending_wallet_operations',
      NEW.id,
      NEW.id::text
    );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_proxy_agent_portfolio_topup_commission ON public.pending_wallet_operations;
CREATE TRIGGER trg_proxy_agent_portfolio_topup_commission
AFTER INSERT OR UPDATE OF status ON public.pending_wallet_operations
FOR EACH ROW
EXECUTE FUNCTION public.trg_proxy_agent_portfolio_topup_commission();

REVOKE EXECUTE ON FUNCTION public.credit_proxy_agent_portfolio_commission(uuid,numeric,text,text,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.try_credit_proxy_agent_portfolio_commission(uuid,numeric,text,text,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_proxy_agent_portfolio_commission() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_proxy_agent_portfolio_topup_commission() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_proxy_agent_portfolio_commission(uuid,numeric,text,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.try_credit_proxy_agent_portfolio_commission(uuid,numeric,text,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.trg_proxy_agent_portfolio_commission() TO service_role;
GRANT EXECUTE ON FUNCTION public.trg_proxy_agent_portfolio_topup_commission() TO service_role;

COMMIT;