CREATE OR REPLACE FUNCTION public._approve_pending_portfolio_core(p_portfolio_id uuid, p_actor uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := p_actor;
  v_status text;
  v_pending public.funder_pending_portfolios%ROWTYPE;
  v_entries jsonb;
  v_group uuid;
  v_ref text;
  v_already boolean := false;
  v_float jsonb;
  v_pool jsonb;
  v_fee jsonb;
  v_direct boolean := coalesce(current_setting('app.funder_direct_release', true), '') = 'on';
  v_prev_owner text := current_setting('psm.owner_release', true);
  v_line record;
BEGIN
  -- Busy stops the float-credit trigger from calling this again while the
  -- ledger rows of this same release are being inserted.
  PERFORM set_config('app.funder_direct_release_busy', 'on', true);
  -- psm_disburse_landlord_float allows the caller when psm.owner_release is on.
  -- Direct release runs as the funder, who is not a Partner Ops reviewer.
  IF v_direct THEN
    PERFORM set_config('psm.owner_release', 'on', true);
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('approve-pending-portfolio-' || p_portfolio_id::text));

  SELECT status INTO v_status FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND'; END IF;

  IF v_status = 'active' AND EXISTS (
      SELECT 1 FROM public.funder_pending_portfolios
       WHERE portfolio_id = p_portfolio_id AND status = 'approved'
  ) THEN
    IF v_direct THEN
      PERFORM set_config('psm.owner_release', coalesce(v_prev_owner, ''), true);
    END IF;
    PERFORM set_config('app.funder_direct_release_busy', '', true);
    RETURN p_portfolio_id;
  END IF;

  -- awaiting_funder_deposit is a direct-release promise. It is not an approval queue.
  IF v_status NOT IN ('pending_ops_approval','awaiting_partner_details','awaiting_funder_deposit') THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING HINT = v_status;
  END IF;

  SELECT * INTO v_pending FROM public.funder_pending_portfolios
   WHERE portfolio_id = p_portfolio_id AND status = 'pending' FOR UPDATE;

  -- Direct release never funds a Rent Plan that has no assigned agent.
  -- The debit has not happened yet, so this raise leaves no money moved.
  IF v_direct
     AND v_pending.id IS NOT NULL
     AND v_pending.source = 'self_managed'
     AND v_pending.commitment_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.partner_self_funding_lines l
         JOIN public.rent_requests rr ON rr.id = l.rent_request_id
        WHERE l.commitment_id = v_pending.commitment_id
          AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NULL
     ) THEN
    RAISE EXCEPTION 'NO_AGENT_ASSIGNED: This Rent Plan has no assigned agent, so it cannot be funded.'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.investor_portfolios
     SET status = 'active',
         next_roi_date = COALESCE(next_roi_date, (now() + interval '30 days')::date),
         maturity_date = COALESCE(maturity_date, (now() + interval '12 months')::date)
   WHERE id = p_portfolio_id;

  IF v_pending.id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.general_ledger g
       WHERE g.ledger_scope = 'wallet'
         AND g.direction = 'cash_out'
         AND g.category IN ('partner_funding','supporter_rent_fund','portfolio_topup')
         AND (
              g.idempotency_key = 'portfolio-funding-' || p_portfolio_id::text
           OR g.idempotency_key = 'funder-pending-' || v_pending.id::text
           OR (v_pending.commitment_id IS NOT NULL
               AND g.idempotency_key = 'psm-commit-' || v_pending.commitment_id::text)
           OR (v_pending.commitment_id IS NOT NULL
               AND g.idempotency_key = 'psh-commit-' || v_pending.commitment_id::text)
           OR (g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id)
           OR (v_pending.commitment_id IS NOT NULL
               AND g.source_table = 'partner_self_funding_lines'
               AND g.source_id IN (
                    SELECT l.id FROM public.partner_self_funding_lines l
                     WHERE l.commitment_id = v_pending.commitment_id))
           OR (v_pending.commitment_id IS NOT NULL
               AND g.source_table = 'partner_supported_houses'
               AND g.source_id IN (
                    SELECT s.id FROM public.partner_supported_houses s
                     WHERE s.commitment_id = v_pending.commitment_id))
         )
    ) INTO v_already;

    IF v_already THEN
      IF v_pending.source IN ('self_managed','self_managed_house')
         AND v_pending.commitment_id IS NOT NULL THEN
        UPDATE public.partner_self_commitments
           SET status = 'active', updated_at = now()
         WHERE id = v_pending.commitment_id;
      END IF;
    ELSIF v_pending.source = 'self_managed_house' THEN
      SELECT jsonb_agg(e) INTO v_entries FROM (
        SELECT jsonb_build_object(
          'user_id', v_pending.funder_id, 'amount', s.principal, 'direction', 'cash_out',
          'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'source_table', 'partner_supported_houses', 'source_id', s.id,
          'reference_id', s.house_id::text,
          'description', 'Partner self-support operational funding for verified house (self_support_operational_house; float_usage=house_support_funding)'
        ) AS e
        FROM public.partner_supported_houses s WHERE s.commitment_id = v_pending.commitment_id
        UNION ALL
        SELECT jsonb_build_object(
          'amount', s.principal, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'partner_supported_houses', 'source_id', s.id,
          'reference_id', s.house_id::text,
          'linked_party', v_pending.funder_id::text,
          'description', 'Self-support operational capital received for verified house (self_support_operational_house; float_usage=house_support_funding)'
        )
        FROM public.partner_supported_houses s WHERE s.commitment_id = v_pending.commitment_id
      ) sq;

      v_group := public.create_ledger_transaction(
        entries := v_entries,
        idempotency_key := 'psh-commit-' || v_pending.commitment_id::text
      );

      UPDATE public.partner_self_commitments
         SET status = 'active', ledger_group_id = v_group, updated_at = now()
       WHERE id = v_pending.commitment_id;
    ELSIF v_pending.source = 'self_managed' THEN
      SELECT jsonb_agg(e) INTO v_entries FROM (
        SELECT jsonb_build_object(
          'user_id', v_pending.funder_id, 'amount', l.principal, 'direction', 'cash_out',
          'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'source_table', 'partner_self_funding_lines', 'source_id', l.id,
          'reference_id', l.rent_request_id::text,
          'description', 'Self-managed partner funding approved (self_managed_partner; float_usage=self_portfolio_funding)'
        ) AS e
        FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_pending.commitment_id
        UNION ALL
        SELECT jsonb_build_object(
          'amount', l.principal, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'partner_self_funding_lines', 'source_id', l.id,
          'reference_id', l.rent_request_id::text,
          'linked_party', v_pending.funder_id::text,
          'description', 'Self-managed partner capital received (self_managed_partner; float_usage=self_portfolio_funding)'
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
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
          'reference_id', v_ref,
          'linked_party', 'Rent Management Pool',
          'description', 'Partner rent pool funding approved by Partner Ops (rent_pool; float_usage=portfolio_funding)'
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

  IF v_pending.id IS NOT NULL AND v_pending.commitment_id IS NOT NULL
     AND v_pending.source IN ('self_managed', 'self_managed_house') THEN
    v_fee := public.self_support_pay_proxy_fee(v_pending.commitment_id);
  END IF;

  v_pool := public.landlord_pool_reserve(p_portfolio_id, NULL, 'approve_pending_portfolio');

  IF v_pending.id IS NOT NULL THEN
    IF v_pending.source = 'self_managed' AND v_pending.commitment_id IS NOT NULL THEN
      v_float := public.psm_disburse_landlord_float(v_pending.commitment_id, NULL, NULL);
    END IF;
  END IF;

  IF v_direct AND v_pending.commitment_id IS NOT NULL AND v_pending.source = 'self_managed' THEN
    FOR v_line IN
      SELECT al.id AS allocation_id, al.agent_id, al.rent_request_id
        FROM public.agent_landlord_float_allocations al
        JOIN public.partner_self_funding_lines l ON l.rent_request_id = al.rent_request_id
       WHERE l.commitment_id = v_pending.commitment_id
         AND al.source = 'partner_self_funding'
         AND al.funded_by_partner_id = v_pending.funder_id
         AND al.status IN ('open', 'partially_paid')
    LOOP
      BEGIN
        PERFORM public._funder_direct_release_note(v_line.rent_request_id, v_line.agent_id, v_line.allocation_id);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'funder direct release flag failed for plan %: %', v_line.rent_request_id, SQLERRM;
      END;
    END LOOP;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
    VALUES (v_caller, 'funder_direct_release', 'investor_portfolios', p_portfolio_id::text,
      'funder_direct_release',
      'Partner float released straight to the agent landlord float',
      jsonb_build_object(
        'direct_release', true,
        'portfolio_id', p_portfolio_id,
        'commitment_id', v_pending.commitment_id,
        'actor_id', v_caller,
        'landlord_float', v_float
      ));
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_caller, 'approve_pending_portfolio', 'investor_portfolios', p_portfolio_id::text,
    'approve_pending_portfolio',
    CASE WHEN v_direct
         THEN 'Direct funder release activated the portfolio'
         ELSE 'Partner Ops verified and activated pending funder portfolio' END,
    jsonb_build_object('reason', CASE WHEN v_direct THEN 'funder_direct_release' ELSE 'ops_approved_pending_funder_portfolio' END,
                       'prev_status', v_status,
                       'ledger_group_id', v_group, 'already_funded', v_already,
                       'source', v_pending.source,
                       'landlord_float', v_float,
                       'landlord_pool', v_pool,
                       'proxy_fee', v_fee,
                       'direct_release', v_direct));

  IF v_direct THEN
    PERFORM set_config('psm.owner_release', coalesce(v_prev_owner, ''), true);
  END IF;
  PERFORM set_config('app.funder_direct_release_busy', '', true);
  RETURN p_portfolio_id;
END;
$function$
