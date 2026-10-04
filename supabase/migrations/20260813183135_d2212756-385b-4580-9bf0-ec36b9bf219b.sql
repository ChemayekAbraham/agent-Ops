CREATE OR REPLACE FUNCTION public.enforce_portfolio_funding_at_creation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing integer;
  v_idem text;
BEGIN
  IF NEW.investor_id IS NULL OR NEW.investment_amount IS NULL OR NEW.investment_amount <= 0 THEN
    RETURN NEW;
  END IF;

  -- Pending-first portfolios must NOT debit at creation; the capital moves
  -- only when Partner Ops approves (approve_pending_portfolio posts the legs).
  IF NEW.status IN ('pending_ops_approval','awaiting_partner_details','cancelled','rejected') THEN
    RETURN NEW;
  END IF;

  v_idem := 'portfolio-funding-' || NEW.id::text;

  SELECT COUNT(*) INTO v_existing
  FROM public.general_ledger g
  WHERE g.idempotency_key = v_idem
     OR (
          g.ledger_scope = 'wallet'
          AND g.direction = 'cash_out'
          AND g.category IN ('partner_funding','portfolio_topup')
          AND (
            (g.source_table = 'investor_portfolios' AND g.source_id = NEW.id)
            OR (NEW.portfolio_code IS NOT NULL AND g.reference_id = NEW.portfolio_code)
            OR (
                 g.user_id = NEW.investor_id
                 AND g.amount = NEW.investment_amount
                 AND g.created_at >= now() - interval '30 minutes'
                 AND g.created_at <= now() + interval '30 minutes'
               )
          )
        );

  IF v_existing > 0 THEN
    RETURN NEW;
  END IF;

  PERFORM public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'user_id', NEW.investor_id,
        'amount', NEW.investment_amount,
        'direction', 'cash_out',
        'category', 'partner_funding',
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'description', 'Wallet deduction for portfolio ' || COALESCE(NEW.portfolio_code,'') || ' (auto — creation trigger)',
        'source_table', 'investor_portfolios',
        'source_id', NEW.id::text,
        'reference_id', NEW.portfolio_code,
        'linked_party', 'platform'
      ),
      jsonb_build_object(
        'amount', NEW.investment_amount,
        'direction', 'cash_in',
        'category', 'partner_funding',
        'ledger_scope', 'platform',
        'description', 'Platform capital received for portfolio ' || COALESCE(NEW.portfolio_code,'') || ' (auto — creation trigger)',
        'source_table', 'investor_portfolios',
        'source_id', NEW.id::text,
        'reference_id', NEW.portfolio_code,
        'linked_party', NEW.investor_id::text
      )
    ),
    idempotency_key := v_idem
  );

  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.approve_pending_portfolio(p_portfolio_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_status text;
  v_pending public.funder_pending_portfolios%ROWTYPE;
  v_entries jsonb;
  v_group uuid;
  v_ref text;
  v_already boolean := false;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_partner_ops(v_caller) THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

  SELECT status INTO v_status FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND'; END IF;
  IF v_status NOT IN ('pending_ops_approval','awaiting_partner_details') THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING HINT = v_status;
  END IF;

  SELECT * INTO v_pending FROM public.funder_pending_portfolios
   WHERE portfolio_id = p_portfolio_id AND status = 'pending' FOR UPDATE;

  UPDATE public.investor_portfolios
     SET status = 'active',
         next_roi_date = COALESCE(next_roi_date, (now() + interval '30 days')::date),
         maturity_date = COALESCE(maturity_date, (now() + interval '12 months')::date)
   WHERE id = p_portfolio_id;

  IF v_pending.id IS NOT NULL THEN
    -- Legacy safety: if the capital was already debited (old creation trigger,
    -- or a prior partial approval), do not debit a second time.
    SELECT EXISTS (
      SELECT 1 FROM public.general_ledger g
       WHERE g.ledger_scope = 'wallet'
         AND g.direction = 'cash_out'
         AND g.category IN ('partner_funding','supporter_rent_fund','portfolio_topup')
         AND (
              g.idempotency_key = 'portfolio-funding-' || p_portfolio_id::text
           OR (g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id)
           OR (v_pending.commitment_id IS NOT NULL
               AND g.source_table = 'partner_self_funding_lines'
               AND g.source_id IN (
                    SELECT l.id FROM public.partner_self_funding_lines l
                     WHERE l.commitment_id = v_pending.commitment_id))
         )
    ) INTO v_already;

    IF v_already THEN
      IF v_pending.source = 'self_managed' AND v_pending.commitment_id IS NOT NULL THEN
        UPDATE public.partner_self_commitments
           SET status = 'active', updated_at = now()
         WHERE id = v_pending.commitment_id;
      END IF;
    ELSIF v_pending.source = 'self_managed' THEN
      SELECT jsonb_agg(e) INTO v_entries FROM (
        SELECT jsonb_build_object(
          'user_id', v_pending.funder_id, 'amount', l.principal, 'direction', 'cash_out',
          'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
          'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
          'source_table', 'partner_self_funding_lines', 'source_id', l.id,
          'reference_id', l.rent_request_id::text,
          'description', 'Self-managed partner funding approved (self_managed_partner)'
        ) AS e
        FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_pending.commitment_id
        UNION ALL
        SELECT jsonb_build_object(
          'amount', l.principal, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'partner_self_funding_lines', 'source_id', l.id,
          'reference_id', l.rent_request_id::text,
          'linked_party', v_pending.funder_id::text,
          'description', 'Self-managed partner capital received (self_managed_partner)'
        )
        FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_pending.commitment_id
      ) s;

      v_group := public.create_ledger_transaction(
        entries := v_entries,
        idempotency_key := 'psm-commit-' || v_pending.commitment_id::text
      );

      UPDATE public.partner_self_commitments
         SET status = 'active', ledger_group_id = v_group, updated_at = now()
       WHERE id = v_pending.commitment_id;
    ELSE
      v_ref := 'WRF' || to_char(now(), 'YYMMDD') || lpad((floor(random()*9000)+1000)::int::text, 4, '0');
      v_entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_pending.funder_id, 'amount', v_pending.amount, 'direction', 'cash_out',
          'category', 'partner_funding', 'ledger_scope', 'wallet',
          'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
          'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
          'reference_id', v_ref,
          'linked_party', 'Rent Management Pool',
          'description', 'Partner rent pool funding approved by Partner Ops'
        ),
        jsonb_build_object(
          'amount', v_pending.amount, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
          'reference_id', v_ref,
          'linked_party', v_pending.funder_id::text,
          'description', 'Partner capital received into Rent Management Pool'
        )
      );

      v_group := public.create_ledger_transaction(
        entries := v_entries,
        idempotency_key := 'funder-pending-' || v_pending.id::text
      );
    END IF;

    UPDATE public.funder_pending_portfolios
       SET status = 'approved', reviewed_by = v_caller, reviewed_at = now(), updated_at = now()
     WHERE id = v_pending.id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'approve_pending_portfolio', 'investor_portfolios', p_portfolio_id,
    jsonb_build_object('reason','ops_approved_pending_funder_portfolio','prev_status',v_status,
                       'ledger_group_id', v_group, 'already_funded', v_already));

  RETURN p_portfolio_id;
END;
$function$;