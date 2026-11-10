-- Self-support agent facilitation fee, Phase 2: the split at Partner Ops approval (owner design 2026-11-10).
--
-- When Partner Ops approves a self-support portfolio:
--   * the partner's float is debited the full principal (rent + fee), as before (approve_pending_portfolio);
--   * the rent goes to landlord float (Rent Plans) or stays as operational funding (empty houses):
--     psm_disburse_landlord_float and landlord_pool_reserve now use rent_amount;
--   * the fee is paid ONCE to the partner's proxy agent (self_support_pay_proxy_fee), fire and forget:
--       Dr X3 Agent Commission Expense (platform agent_commission_earned)
--       Cr agent wallet (agent_commission, or partner_commission for a managed proxy)
--     The partner's principal stays rent + fee, so Welile carries the fee; Phase 3 refills it from the
--     agent commission budget that is no longer paid out.
--   * no proxy agent at approval: nothing is paid, the fee stays as the partner's capital ("kept");
--     it is never paid later.
--   * the commission gate never pays a self-support portfolio that carries the fee (no double pay:
--     the gate's 2%/1% marketing-expense payment is skipped as not_commissionable).
-- Rejection before approval marks the fee cancelled (lines are deleted; houses cancelled).
-- While self_support_fee_policy is off every fee is 0 and none of this posts anything.

-- 1. Which fund-ins are covered by a fee paid (or kept) at approval ----------------------------
CREATE OR REPLACE FUNCTION public.self_support_fee_covers_fund_in(p_fund_in_key text, p_portfolio uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH k AS (
    SELECT CASE WHEN p_fund_in_key ~ '^pf:[0-9a-f-]{36}$'  THEN split_part(p_fund_in_key, ':', 2)::uuid END AS pf,
           CASE WHEN p_fund_in_key ~ '^psc:[0-9a-f-]{36}$' THEN split_part(p_fund_in_key, ':', 2)::uuid END AS psc
  ), c AS (
    SELECT fp.commitment_id
      FROM public.funder_pending_portfolios fp, k
     WHERE fp.source IN ('self_managed', 'self_managed_house')
       AND fp.commitment_id IS NOT NULL
       AND (fp.portfolio_id = COALESCE(p_portfolio, k.pf) OR fp.commitment_id = k.psc)
  )
  SELECT EXISTS (SELECT 1 FROM public.partner_self_funding_lines l JOIN c USING (commitment_id) WHERE l.proxy_fee > 0)
      OR EXISTS (SELECT 1 FROM public.partner_supported_houses s JOIN c USING (commitment_id) WHERE s.proxy_fee > 0);
$function$;
REVOKE ALL ON FUNCTION public.self_support_fee_covers_fund_in(text, uuid) FROM PUBLIC, anon, authenticated;

-- 2. Pay the fee once, at approval ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.self_support_pay_proxy_fee(p_commitment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid;
  v_fee     numeric;
  v_rent    numeric;
  v_code    text;
  v_e uuid; v_path text; v_note uuid; v_asg uuid; v_basis text;
  v_idem    text := 'ssfee-' || p_commitment_id::text;
  v_group   uuid;
  v_rate    numeric;
  v_label   text;
BEGIN
  SELECT c.partner_id INTO v_partner FROM public.partner_self_commitments c WHERE c.id = p_commitment_id;
  IF v_partner IS NULL THEN RETURN jsonb_build_object('status', 'skipped', 'reason', 'commitment_not_found'); END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_idem));

  SELECT COALESCE(SUM(x.fee), 0), COALESCE(SUM(x.rent), 0) INTO v_fee, v_rent FROM (
    SELECT l.proxy_fee AS fee, l.rent_amount AS rent FROM public.partner_self_funding_lines l
     WHERE l.commitment_id = p_commitment_id AND l.proxy_fee > 0 AND l.proxy_fee_status = 'pending'
    UNION ALL
    SELECT s.proxy_fee, s.rent_amount FROM public.partner_supported_houses s
     WHERE s.commitment_id = p_commitment_id AND s.proxy_fee > 0 AND s.proxy_fee_status = 'pending'
  ) x;
  IF v_fee <= 0 THEN RETURN jsonb_build_object('status', 'skipped', 'reason', 'no_pending_fee'); END IF;

  SELECT r.earner_id, r.earner_path, r.note_id, r.assignment_id, r.basis
    INTO v_e, v_path, v_note, v_asg, v_basis
    FROM public.commission_resolve_earner(v_partner, now(), true) r LIMIT 1;

  IF v_e IS NULL OR v_e = v_partner THEN
    -- No proxy agent: the fee stays as the partner's capital (owner: "the 2% goes nowhere").
    UPDATE public.partner_self_funding_lines SET proxy_fee_status = 'kept', updated_at = now()
     WHERE commitment_id = p_commitment_id AND proxy_fee > 0 AND proxy_fee_status = 'pending';
    UPDATE public.partner_supported_houses SET proxy_fee_status = 'kept', updated_at = now()
     WHERE commitment_id = p_commitment_id AND proxy_fee > 0 AND proxy_fee_status = 'pending';
    PERFORM public.psm_audit(auth.uid(), v_partner, 'proxy_fee_kept', 'partner_self_commitments', p_commitment_id,
      jsonb_build_object('fee', v_fee, 'rent', v_rent, 'reason', 'no_proxy_agent'));
    RETURN jsonb_build_object('status', 'kept', 'fee', v_fee);
  END IF;

  SELECT ip.portfolio_code INTO v_code
    FROM public.funder_pending_portfolios fp JOIN public.investor_portfolios ip ON ip.id = fp.portfolio_id
   WHERE fp.commitment_id = p_commitment_id ORDER BY fp.created_at LIMIT 1;
  v_rate := round(v_fee / NULLIF(v_rent, 0), 4);
  v_label := 'Agent facilitation fee (' || rtrim(rtrim(to_char(COALESCE(v_rate, 0) * 100, 'FM990.99'), '0'), '.')
             || '%) from self-support portfolio ' || COALESCE(v_code, p_commitment_id::text);

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object('user_id', v_e, 'amount', v_fee, 'direction', 'cash_out',
        'category', 'agent_commission_earned', 'ledger_scope', 'platform',
        'source_table', 'partner_self_commitments', 'source_id', p_commitment_id::text,
        'reference_id', v_idem, 'linked_party', v_partner::text,
        'description', 'Agent commission expense: ' || v_label),
      jsonb_build_object('user_id', v_e, 'amount', v_fee, 'direction', 'cash_in',
        'category', CASE WHEN v_path = 'managed_proxy' THEN 'partner_commission' ELSE 'agent_commission' END,
        'ledger_scope', 'wallet', 'recipient_type', 'user',
        'source_table', 'partner_self_commitments', 'source_id', p_commitment_id::text,
        'reference_id', v_idem, 'linked_party', v_partner::text,
        'description', v_label)),
    v_idem);

  UPDATE public.partner_self_funding_lines
     SET proxy_fee_status = 'paid', proxy_agent_id = v_e, proxy_fee_ledger_group_id = v_group, updated_at = now()
   WHERE commitment_id = p_commitment_id AND proxy_fee > 0 AND proxy_fee_status = 'pending';
  UPDATE public.partner_supported_houses
     SET proxy_fee_status = 'paid', proxy_agent_id = v_e, proxy_fee_ledger_group_id = v_group, updated_at = now()
   WHERE commitment_id = p_commitment_id AND proxy_fee > 0 AND proxy_fee_status = 'pending';

  -- The agent's commission history (same tables the commission gate writes).
  IF v_path = 'managed_proxy' THEN
    INSERT INTO public.proxy_commission_queue
      (kind, agent_id, partner_id, assignment_id, base_amount, rate, amount, source_table, source_id,
       idempotency_key, status, auto_approved, decided_at, decision_note, ledger_group_id)
    VALUES ('portfolio_creation', v_e, v_partner, v_asg, v_rent, COALESCE(NULLIF(v_rate, 0), 0.02), v_fee,
       'partner_self_commitments', p_commitment_id::text, v_idem, 'paid', true, now(), 'self_support_fee', v_group);
  ELSE
    INSERT INTO public.promissory_commission_events
      (note_id, agent_id, partner_id, kind, base_amount, rate, amount, source_table, source_id,
       idempotency_key, ledger_group_id, status)
    VALUES (v_note, v_e, v_partner, 'portfolio_creation', v_rent, COALESCE(NULLIF(v_rate, 0), 0.02), v_fee,
       'partner_self_commitments', p_commitment_id::text, v_idem, v_group, 'paid');
  END IF;

  PERFORM public.psm_audit(auth.uid(), v_partner, 'proxy_fee_paid', 'partner_self_commitments', p_commitment_id,
    jsonb_build_object('fee', v_fee, 'rent', v_rent, 'agent_id', v_e, 'earner_path', v_path, 'basis', v_basis,
                       'ledger_group_id', v_group, 'idempotency_key', v_idem));

  RETURN jsonb_build_object('status', 'paid', 'fee', v_fee, 'agent_id', v_e, 'earner_path', v_path,
                            'ledger_group_id', v_group);
END $function$;
REVOKE ALL ON FUNCTION public.self_support_pay_proxy_fee(uuid) FROM PUBLIC, anon, authenticated;

-- 3. Approval pays the fee after the partner debit.
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
  v_float jsonb;
  v_pool jsonb;  -- Landlord Float Pool
  v_fee jsonb;   -- self-support agent facilitation fee
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_partner_ops(v_caller) THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('approve-pending-portfolio-' || p_portfolio_id::text));

  SELECT status INTO v_status FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND'; END IF;

  IF v_status = 'active' AND EXISTS (
      SELECT 1 FROM public.funder_pending_portfolios
       WHERE portfolio_id = p_portfolio_id AND status = 'approved'
  ) THEN
    RETURN p_portfolio_id;
  END IF;

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
      -- Self-support operational funding for verified empty houses.
      -- No tenant exists, so NOTHING is released to landlord or agent float.
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

  -- Self-support agent facilitation fee: the partner debit has posted, so pay the fee to the
  -- proxy agent once (or keep it as partner capital when there is none). No-op without a fee.
  IF v_pending.id IS NOT NULL AND v_pending.commitment_id IS NOT NULL
     AND v_pending.source IN ('self_managed', 'self_managed_house') THEN
    v_fee := public.self_support_pay_proxy_fee(v_pending.commitment_id);
  END IF;

  -- Landlord Float Pool: the partner debit has now posted on every path, so
  -- reserve here. No-op unless the portfolio is pool_eligible; idempotent if
  -- the activation trigger already reserved it (pre-debited paths).
  v_pool := public.landlord_pool_reserve(p_portfolio_id, NULL, 'approve_pending_portfolio');

  IF v_pending.id IS NOT NULL THEN
    -- Tenant-bound self-managed only: principal becomes landlord float on the tenant's agent.
    -- House support has no tenant, so it never reaches this branch.
    IF v_pending.source = 'self_managed' AND v_pending.commitment_id IS NOT NULL THEN
      v_float := public.psm_disburse_landlord_float(v_pending.commitment_id, NULL, NULL);
    END IF;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_caller, 'approve_pending_portfolio', 'investor_portfolios', p_portfolio_id::text,
    'approve_pending_portfolio',
    'Partner Ops verified and activated pending funder portfolio',
    jsonb_build_object('reason','ops_approved_pending_funder_portfolio','prev_status',v_status,
                       'ledger_group_id', v_group, 'already_funded', v_already,
                       'source', v_pending.source,
                       'landlord_float', v_float,
                       'landlord_pool', v_pool,
                       'proxy_fee', v_fee));

  RETURN p_portfolio_id;
END;
$function$;

-- 4. Landlord float gets the rent.
CREATE OR REPLACE FUNCTION public.psm_disburse_landlord_float(p_commitment_id uuid, p_topup_id uuid DEFAULT NULL::uuid, p_rent_request_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid;
  v_line record;
  v_agent uuid;
  v_alloc uuid;
  v_alloc_ids uuid[] := ARRAY[]::uuid[];
  v_landlord_name text;
  v_ref text;
  v_funded integer := 0;
  v_skipped integer := 0;
  v_total numeric := 0;
  v_notices integer := 0;
  v_treasury jsonb;
  v_treasury_recognised integer := 0;
  v_pool_entry uuid;          -- Landlord Float Pool
  v_pool_drawn numeric := 0;  -- Landlord Float Pool
  v_pool_pid uuid;            -- Landlord Float Pool (self-managed top-ups)
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.psm_is_topup_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT partner_id INTO v_partner FROM public.partner_self_commitments WHERE id = p_commitment_id;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'commitment_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-float-' || p_commitment_id::text));

  -- Landlord Float Pool: a self-managed top-up's new tenant lines are reserved
  -- as self-support TOP-UP entries — only once the top-up's own wallet debit
  -- (key psm-topup-<id>) exists, and only for a pool_eligible portfolio
  -- (checked inside landlord_pool_reserve_increment).
  IF p_topup_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.general_ledger g
                  WHERE g.idempotency_key = 'psm-topup-' || p_topup_id::text) THEN
    SELECT fp.portfolio_id INTO v_pool_pid FROM public.funder_pending_portfolios fp
     WHERE fp.commitment_id = p_commitment_id ORDER BY fp.created_at DESC LIMIT 1;
  END IF;

  FOR v_line IN
    SELECT l.id AS line_id,
           -- the rent goes to landlord float; the partner's principal may include the agent fee
           COALESCE(l.rent_amount, l.principal) AS principal,
           l.rent_request_id,
           rr.status AS rr_status,
           rr.tenant_id,
           rr.landlord_id,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           ld.name AS landlord_name,
           COALESCE(ld.mobile_money_number, ld.phone) AS landlord_phone
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.landlords ld ON ld.id = rr.landlord_id
     WHERE l.commitment_id = p_commitment_id
       AND (p_rent_request_ids IS NULL OR l.rent_request_id = ANY(p_rent_request_ids))
     ORDER BY l.created_at
  LOOP
    v_agent := v_line.agent_id;

    IF v_agent IS NULL THEN
      v_skipped := v_skipped + 1;
      PERFORM public.psm_audit(auth.uid(), v_partner, 'float_disbursement_skipped',
        'partner_self_funding_lines', v_line.line_id,
        jsonb_build_object('reason', 'no_agent_assigned', 'rent_request_id', v_line.rent_request_id));
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.agent_landlord_float_allocations a
       WHERE a.rent_request_id = v_line.rent_request_id
         AND a.status IN ('open','partially_paid')
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_landlord_name := COALESCE(v_line.landlord_name, 'Unknown Landlord');
    v_ref := 'PSF-' || upper(substr(replace(v_line.line_id::text, '-', ''), 1, 8));

    INSERT INTO public.agent_landlord_float_allocations (
      agent_id, tenant_id, rent_request_id, landlord_id,
      landlord_name, landlord_phone, allocated_amount, source,
      funded_by_partner_id, funding_reference
    ) VALUES (
      v_agent, v_line.tenant_id, v_line.rent_request_id, v_line.landlord_id,
      v_landlord_name, v_line.landlord_phone, v_line.principal, 'partner_self_funding',
      v_partner, v_ref
    )
    RETURNING id INTO v_alloc;

    v_alloc_ids := v_alloc_ids || v_alloc;

    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'direction','cash_out','amount', v_line.principal,
          'category','rent_disbursement','ledger_scope','platform',
          'source_table','partner_self_funding_lines','source_id', v_line.line_id,
          'reference_id', v_ref,
          'user_id', v_agent,
          'linked_party', v_partner::text,
          'description','Partner self-managed funding released to agent landlord float for ' || v_landlord_name
        ),
        jsonb_build_object(
          'direction','cash_in','amount', v_line.principal,
          'category','rent_receivable_created','ledger_scope','bridge',
          'source_table','partner_self_funding_lines','source_id', v_line.line_id,
          'reference_id', v_ref,
          'user_id', v_agent,
          'linked_party', v_partner::text,
          'description','Landlord float credited (partner-funded) - ' || v_landlord_name
        )
      ),
      idempotency_key := 'psm-float-' || v_line.line_id::text
    );

    -- Landlord Float Pool (self-managed top-ups): reserve this top-up line first.
    IF v_pool_pid IS NOT NULL THEN
      BEGIN
        PERFORM public.landlord_pool_reserve_increment(v_pool_pid, 'topup', v_line.principal,
          'partner_self_funding_lines', v_line.line_id, 'psm_self_topup');
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
        VALUES (v_pool_pid, 'reserve', 'psm_self_topup', SQLERRM,
                jsonb_build_object('sqlstate', SQLSTATE, 'topup_id', p_topup_id, 'line_id', v_line.line_id));
      END;
    END IF;

    -- Landlord Float Pool: this tenant line was reserved as self-support, so
    -- the money leaves the pool now, beside the rent_disbursement above.
    v_pool_entry := NULL;
    SELECT e.id INTO v_pool_entry FROM public.landlord_pool_entries e
     WHERE e.source_table = 'partner_self_funding_lines' AND e.source_id = v_line.line_id
       AND e.status = 'open' AND e.in_pool > 0;
    IF v_pool_entry IS NOT NULL THEN
      v_pool_drawn := v_pool_drawn + coalesce((public.landlord_pool_deploy(
        v_line.rent_request_id, v_line.principal, 'self_support', v_alloc, v_pool_entry,
        'psm_disburse_landlord_float') ->> 'drawn')::numeric, 0);
    END IF;

    INSERT INTO public.agent_float_funding (agent_id, amount, funded_by, rent_request_id, notes)
    VALUES (v_agent, v_line.principal, auth.uid(), v_line.rent_request_id,
            'Partner-funded landlord float for ' || v_landlord_name)
    ON CONFLICT DO NOTHING;

    UPDATE public.rent_requests
       SET status = 'funded',
           funded_at = COALESCE(funded_at, now()),
           self_funding_partner_id = COALESCE(self_funding_partner_id, v_partner),
           self_funding_line_id = COALESCE(self_funding_line_id, v_line.line_id),
           updated_at = now()
     WHERE id = v_line.rent_request_id
       AND status IN ('approved','coo_approved','pending','agent_ops_approved',
                      'tenant_ops_approved','landlord_ops_approved','cfo_approved');

    v_treasury := public.recognise_funding_treasury(v_line.rent_request_id);
    IF (v_treasury->>'status') = 'recognised' THEN
      v_treasury_recognised := v_treasury_recognised + 1;
    END IF;

    v_funded := v_funded + 1;
    v_total := v_total + v_line.principal;
  END LOOP;

  WITH grouped AS (
    SELECT a.agent_id, a.landlord_id,
           MIN(a.landlord_name) AS landlord_name,
           SUM(a.allocated_amount) AS amount,
           COUNT(DISTINCT a.rent_request_id)::int AS tenant_count,
           array_agg(DISTINCT a.rent_request_id) AS rent_request_ids
      FROM public.agent_landlord_float_allocations a
     WHERE a.id = ANY(v_alloc_ids)
       AND a.status NOT IN ('cancelled','reversed')
     GROUP BY a.agent_id, a.landlord_id
  ), ins AS (
    INSERT INTO public.partner_float_agent_notices (
      commitment_id, topup_id, partner_id, agent_id, landlord_id,
      landlord_name, amount, tenant_count, rent_request_ids
    )
    SELECT p_commitment_id, p_topup_id, v_partner, g.agent_id, g.landlord_id,
           COALESCE(g.landlord_name,'the landlord'), g.amount, g.tenant_count, g.rent_request_ids
      FROM grouped g
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_notices FROM ins;

  -- Landlord SMS queue (5a). One row per agent+landlord, like the agent notices.
  -- The landlord is told their rent is approved and who will pay them, because
  -- the money now sits on the agent's dashboard. Never blocks the approval.
  BEGIN
    INSERT INTO public.partner_float_landlord_notices (
      commitment_id, topup_id, partner_id, agent_id, agent_name, landlord_id,
      landlord_name, landlord_phone, amount, tenant_count, tenant_first_names, rent_request_ids
    )
    SELECT p_commitment_id, p_topup_id, v_partner, g.agent_id, g.agent_name, g.landlord_id,
           COALESCE(g.landlord_name, 'the landlord'), g.landlord_phone, g.amount, g.tenant_count,
           COALESCE(g.tenant_names, '{}'::text[]), g.rent_request_ids
      FROM (
        SELECT a.agent_id, a.landlord_id,
               MIN(pa.full_name)                       AS agent_name,
               MIN(a.landlord_name)                    AS landlord_name,
               MIN(ld.phone)                           AS landlord_phone,
               SUM(a.allocated_amount)                 AS amount,
               COUNT(DISTINCT a.rent_request_id)::int  AS tenant_count,
               array_agg(DISTINCT initcap(split_part(btrim(pt.full_name), ' ', 1)))
                 FILTER (WHERE btrim(COALESCE(pt.full_name, '')) <> '') AS tenant_names,
               array_agg(DISTINCT a.rent_request_id)   AS rent_request_ids
          FROM public.agent_landlord_float_allocations a
          LEFT JOIN public.profiles  pa ON pa.id = a.agent_id
          LEFT JOIN public.profiles  pt ON pt.id = a.tenant_id
          LEFT JOIN public.landlords ld ON ld.id = a.landlord_id
         WHERE a.id = ANY(v_alloc_ids)
           AND a.status NOT IN ('cancelled', 'reversed')
         GROUP BY a.agent_id, a.landlord_id
      ) g
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.psm_audit(auth.uid(), v_partner, 'landlord_sms_queue_failed',
      'partner_self_commitments', p_commitment_id, jsonb_build_object('error', SQLERRM));
  END;

  PERFORM public.psm_audit(auth.uid(), v_partner, 'landlord_float_disbursed',
    'partner_self_commitments', p_commitment_id,
    jsonb_build_object('funded_lines', v_funded, 'skipped_lines', v_skipped,
                       'total_amount', v_total, 'notices_queued', v_notices,
                       'treasury_recognised', v_treasury_recognised,
                       'topup_id', p_topup_id,
                       'landlord_pool_drawn', v_pool_drawn));

  RETURN jsonb_build_object('funded', v_funded, 'skipped', v_skipped,
                            'total_amount', v_total, 'notices_queued', v_notices,
                            'treasury_recognised', v_treasury_recognised,
                            'landlord_pool_drawn', v_pool_drawn);
END;
$function$;

-- 5. The Landlord Float Pool holds the rent.
CREATE OR REPLACE FUNCTION public.landlord_pool_reserve(p_portfolio_id uuid, p_funding_group_ids uuid[] DEFAULT NULL::uuid[], p_caller text DEFAULT 'unknown'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cut     timestamptz := public.landlord_pool_cutover();
  p         public.investor_portfolios%ROWTYPE;
  fp        public.funder_pending_portfolios%ROWTYPE;
  v_origin  text;
  v_targets jsonb;
  v_total   numeric;
  v_funded  numeric;
  v_ids     uuid[];
  t         jsonb;
  v_group   uuid;
  v_entry   uuid;
  v_out     jsonb := '[]'::jsonb;
  v_new     integer := 0;
BEGIN
  IF v_cut IS NULL THEN RETURN jsonb_build_object('status', 'pool_off'); END IF;

  SELECT * INTO p FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND' USING HINT = p_portfolio_id::text; END IF;

  IF NOT p.pool_eligible THEN RETURN jsonb_build_object('status', 'pre_cutover'); END IF;
  IF p.status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('status', 'not_active', 'portfolio_status', p.status);
  END IF;
  IF p.locked_from_portfolio_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'split_child');
  END IF;

  SELECT * INTO fp FROM public.funder_pending_portfolios
   WHERE portfolio_id = p.id ORDER BY created_at DESC LIMIT 1;

  IF fp.source = 'self_managed' AND fp.commitment_id IS NOT NULL THEN
    v_origin := 'self_support';
    SELECT jsonb_agg(jsonb_build_object('st', 'partner_self_funding_lines', 'id', l.id, 'amt', COALESCE(l.rent_amount, l.principal)))
      INTO v_targets
      FROM public.partner_self_funding_lines l
     WHERE l.commitment_id = fp.commitment_id AND COALESCE(l.rent_amount, l.principal) > 0;
  ELSIF fp.source = 'self_managed_house' AND fp.commitment_id IS NOT NULL THEN
    v_origin := 'self_support';
    SELECT jsonb_agg(jsonb_build_object('st', 'partner_supported_houses', 'id', s.id, 'amt', COALESCE(s.rent_amount, s.principal)))
      INTO v_targets
      FROM public.partner_supported_houses s
     WHERE s.commitment_id = fp.commitment_id AND COALESCE(s.rent_amount, s.principal) > 0;
  ELSE
    v_origin := 'company_managed';
    v_targets := jsonb_build_array(jsonb_build_object('st', 'investor_portfolios', 'id', p.id, 'amt', p.investment_amount));
  END IF;

  IF v_targets IS NULL OR jsonb_array_length(v_targets) = 0 THEN
    RAISE EXCEPTION 'LANDLORD_POOL_NO_ATTACHMENTS'
      USING HINT = format('portfolio %s source %s has no tenant lines or houses', p.id, fp.source);
  END IF;

  SELECT coalesce(sum((x->>'amt')::numeric), 0), array_agg((x->>'id')::uuid)
    INTO v_total, v_ids FROM jsonb_array_elements(v_targets) x;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_targets) x
     WHERE NOT EXISTS (SELECT 1 FROM public.landlord_pool_entries e
                        WHERE e.source_table = x->>'st' AND e.source_id = (x->>'id')::uuid)
  ) THEN
    RETURN jsonb_build_object('status', 'already_reserved', 'origin', v_origin, 'total', v_total);
  END IF;

  SELECT coalesce(sum(gl.amount), 0) INTO v_funded
    FROM public.general_ledger gl
   WHERE gl.ledger_scope = 'wallet'
     AND gl.direction = 'cash_out'
     AND gl.category IN ('partner_funding', 'supporter_rent_fund')
     AND (
          (p_funding_group_ids IS NOT NULL AND gl.transaction_group_id = ANY(p_funding_group_ids))
       OR (p_funding_group_ids IS NULL AND (
              (gl.source_table = 'investor_portfolios' AND gl.source_id = p.id)
           OR (p.portfolio_code IS NOT NULL AND gl.reference_id = p.portfolio_code)
           OR gl.idempotency_key = 'portfolio-funding-' || p.id::text
           OR (fp.id IS NOT NULL AND gl.idempotency_key = 'funder-pending-' || fp.id::text)
           OR (fp.commitment_id IS NOT NULL AND gl.idempotency_key IN
                 ('psm-commit-' || fp.commitment_id::text, 'psh-commit-' || fp.commitment_id::text))
           OR (gl.source_table IN ('partner_self_funding_lines', 'partner_supported_houses')
               AND gl.source_id = ANY(v_ids))))
     );

  -- Staff salary reinvestment (WSR): first-month capital is booked
  -- platform-to-platform (salary_payout -> partner_funding) by
  -- hr_pay_post_staff_reinvestment, never through a wallet, so the wallet
  -- query above finds nothing. Count that platform leg instead.
  IF public.hr_pay_is_staff_reinvest_portfolio(p.id) THEN
    v_funded := v_funded + coalesce((
      SELECT sum(gl.amount) FROM public.general_ledger gl
       WHERE gl.ledger_scope = 'platform'
         AND gl.direction = 'cash_in'
         AND gl.category = 'partner_funding'
         AND gl.source_table = 'investor_portfolios'
         AND gl.source_id = p.id
         AND gl.idempotency_key LIKE 'staff-reinvest-%'), 0);
  END IF;

  IF v_funded + 0.5 < v_total THEN
    RETURN jsonb_build_object('status', 'not_funded', 'origin', v_origin,
                              'principal', v_total, 'funded', v_funded);
  END IF;

  FOR t IN SELECT * FROM jsonb_array_elements(v_targets) LOOP
    IF EXISTS (SELECT 1 FROM public.landlord_pool_entries e
                WHERE e.source_table = t->>'st' AND e.source_id = (t->>'id')::uuid) THEN
      CONTINUE;
    END IF;

    v_group := public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'ledger_scope', 'platform', 'category', 'landlord_pool_reserve_' || v_origin,
          'direction', 'cash_in', 'amount', (t->>'amt')::numeric, 'currency', 'UGX',
          'source_table', t->>'st', 'source_id', t->>'id', 'reference_id', p.portfolio_code,
          'linked_party', p.investor_id::text,
          'description', format('Landlord Float Pool reserve (%s) — portfolio %s', replace(v_origin, '_', '-'), p.portfolio_code)),
        jsonb_build_object(
          'ledger_scope', 'platform', 'category', 'landlord_pool_reserve_source',
          'direction', 'cash_out', 'amount', (t->>'amt')::numeric, 'currency', 'UGX',
          'source_table', t->>'st', 'source_id', t->>'id', 'reference_id', p.portfolio_code,
          'linked_party', p.investor_id::text,
          'description', format('Treasury cash reserved into the Landlord Float Pool — portfolio %s', p.portfolio_code))),
      idempotency_key := 'lp-reserve-' || (t->>'st') || '-' || (t->>'id'));

    INSERT INTO public.landlord_pool_entries
      (portfolio_id, partner_id, origin, source_table, source_id, principal, reserve_group_id)
    VALUES (p.id, p.investor_id, v_origin, t->>'st', (t->>'id')::uuid, (t->>'amt')::numeric, v_group)
    ON CONFLICT (source_table, source_id) DO NOTHING
    RETURNING id INTO v_entry;

    IF v_entry IS NOT NULL THEN
      INSERT INTO public.landlord_pool_movements (pool_entry_id, kind, amount, ledger_group_id, created_by)
      VALUES (v_entry, 'reserve', (t->>'amt')::numeric, v_group, auth.uid())
      ON CONFLICT (pool_entry_id, ledger_group_id) DO NOTHING;
      v_new := v_new + 1;
      v_out := v_out || jsonb_build_object('entry_id', v_entry, 'source_table', t->>'st',
                                           'source_id', t->>'id', 'amount', (t->>'amt')::numeric);
    END IF;
  END LOOP;

  UPDATE public.investor_portfolios SET pool_origin = v_origin
   WHERE id = p.id AND pool_origin IS DISTINCT FROM v_origin;

  RETURN jsonb_build_object('status', 'reserved', 'origin', v_origin, 'total', v_total,
                            'new_entries', v_new, 'entries', v_out, 'caller', p_caller);
END;
$function$;

-- 6. The commission gate skips fee-bearing self-support portfolios.
CREATE OR REPLACE FUNCTION public.commission_pay_fund_in(p_fund_in_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  fi public.commission_fund_ins%ROWTYPE;
  v_e uuid; v_path text; v_note uuid; v_asg uuid; v_basis text;
  v_kind text; v_rate numeric; v_amt numeric; v_idem text; v_group uuid; v_label text; v_legacy uuid;
BEGIN
  SELECT * INTO fi FROM public.commission_fund_ins WHERE id = p_fund_in_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','skipped','reason','not_found'); END IF;
  IF fi.status <> 'unattributed' THEN RETURN jsonb_build_object('status','skipped','reason','status_' || fi.status); END IF;

  -- Self-support portfolios that carry the agent facilitation fee pay the proxy agent at approval
  -- (self_support_pay_proxy_fee), or keep the fee when there is none. Never pay a second time.
  IF public.self_support_fee_covers_fund_in(fi.fund_in_key, fi.portfolio_id) THEN
    UPDATE public.commission_fund_ins SET status = 'not_commissionable' WHERE id = fi.id;
    RETURN jsonb_build_object('status','skipped','reason','self_support_fee_at_approval');
  END IF;

  -- Top-ups deposited before the gate cutover were commissioned by the old engine at approval
  -- (or are settled by the recompute). The gate never pays them, even if they complete later.
  IF fi.fund_in_key LIKE 'pwo:%' AND EXISTS (
       SELECT 1 FROM public.pending_wallet_operations w
        WHERE w.id::text = split_part(fi.fund_in_key, ':', 2)
          AND w.created_at < (SELECT s.cutover_at FROM public.commission_gate_settings s WHERE s.id)) THEN
    UPDATE public.commission_fund_ins SET status = 'not_commissionable' WHERE id = fi.id;
    RETURN jsonb_build_object('status','skipped','reason','pre_gate_topup');
  END IF;

  UPDATE public.commission_fund_ins SET attempts = attempts + 1, last_attempt_at = now() WHERE id = fi.id;

  SELECT r.earner_id, r.earner_path, r.note_id, r.assignment_id, r.basis
    INTO v_e, v_path, v_note, v_asg, v_basis
    FROM public.commission_resolve_earner(fi.partner_id, fi.occurred_at, true) r LIMIT 1;
  IF v_e IS NULL THEN RETURN jsonb_build_object('status','skipped','reason','no_earner_yet'); END IF;

  v_kind := CASE WHEN public.commission_partner_has_prior_fund_in(fi.partner_id, fi.fund_in_key, fi.occurred_at)
                 THEN 'portfolio_topup' ELSE 'portfolio_creation' END;
  v_rate := public.promissory_commission_rate(v_kind, fi.occurred_at);
  IF coalesce(v_rate,0) <= 0 THEN RETURN jsonb_build_object('status','skipped','reason','no_rate_in_force'); END IF;

  v_amt := round(fi.amount * v_rate);
  IF v_amt <= 0 THEN
    UPDATE public.commission_fund_ins SET status = 'not_commissionable' WHERE id = fi.id;
    RETURN jsonb_build_object('status','skipped','reason','amount_rounds_to_zero');
  END IF;

  v_idem := 'fund_in_commission:' || fi.fund_in_key;
  IF EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key = v_idem) THEN
    RAISE EXCEPTION 'fund-in % already has a commission posting', fi.fund_in_key;
  END IF;

  v_label := CASE v_kind WHEN 'portfolio_creation' THEN 'Partner first fund-in commission ('
                         ELSE 'Partner repeat fund-in commission (' END
             || rtrim(to_char(v_rate * 100, 'FM990.99'), '.') || '%)';

  v_group := public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object('user_id', v_e, 'amount', v_amt, 'direction','cash_out',
        'category','marketing_expense', 'source_table', fi.source_table, 'source_id', fi.source_id::text,
        'reference_id', v_idem, 'linked_party', fi.partner_id::text,
        'description', 'Marketing expense: ' || v_label, 'ledger_scope','platform'),
      jsonb_build_object('user_id', v_e, 'amount', v_amt, 'direction','cash_in',
        'category', CASE WHEN v_path = 'managed_proxy' THEN 'partner_commission' ELSE 'agent_commission' END,
        'source_table', fi.source_table, 'source_id', fi.source_id::text,
        'reference_id', v_idem, 'linked_party', fi.partner_id::text,
        'description', v_label, 'ledger_scope','wallet', 'recipient_type','user')),
    v_idem);

  IF v_path = 'managed_proxy' THEN
    INSERT INTO public.proxy_commission_queue
      (kind, agent_id, partner_id, assignment_id, base_amount, rate, amount, source_table, source_id,
       idempotency_key, status, auto_approved, decided_at, decision_note, ledger_group_id)
    VALUES (v_kind, v_e, fi.partner_id, v_asg, fi.amount, v_rate, v_amt, fi.source_table, fi.source_id::text,
       v_idem, 'paid', true, now(), 'fund_in_gate', v_group)
    RETURNING id INTO v_legacy;
  ELSE
    INSERT INTO public.promissory_commission_events
      (note_id, agent_id, partner_id, kind, base_amount, rate, amount, source_table, source_id,
       idempotency_key, ledger_group_id, status)
    VALUES (v_note, v_e, fi.partner_id, v_kind, fi.amount, v_rate, v_amt, fi.source_table, fi.source_id::text,
       v_idem, v_group, 'paid')
    RETURNING id INTO v_legacy;
  END IF;

  INSERT INTO public.system_events (event_type, user_id, entity_type, entity_id, metadata)
  VALUES ('wallet_transfer', v_e, 'commission_fund_ins', fi.id,
    jsonb_build_object('fund_in_key', fi.fund_in_key, 'partner_id', fi.partner_id, 'earner_path', v_path,
      'basis', v_basis, 'kind', v_kind, 'base_amount', fi.amount, 'rate', v_rate, 'commission_amount', v_amt,
      'idempotency_key', v_idem, 'ledger_group_id', v_group));

  UPDATE public.commission_fund_ins
     SET status = 'paid', earner_id = v_e, earner_path = v_path, note_id = v_note, assignment_id = v_asg,
         kind = v_kind, rate = v_rate, commission = v_amt, ledger_group_id = v_group,
         legacy_table = CASE WHEN v_path = 'managed_proxy' THEN 'proxy_commission_queue' ELSE 'promissory_commission_events' END,
         legacy_id = v_legacy, paid_at = now()
   WHERE id = fi.id;

  RETURN jsonb_build_object('status','paid','amount',v_amt,'rate',v_rate,'kind',v_kind,
                            'earner_id',v_e,'earner_path',v_path,'basis',v_basis,'ledger_group_id',v_group);
END $function$;

-- 7. Rejected house support cancels its fee.
CREATE OR REPLACE FUNCTION public.sync_supported_houses_on_review()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.source <> 'self_managed_house' OR NEW.commitment_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'approved' AND COALESCE(OLD.status,'') <> 'approved' THEN
    UPDATE public.partner_supported_houses
       SET status='active', activated_at=now(), updated_at=now()
     WHERE commitment_id = NEW.commitment_id AND status='pending';
    UPDATE public.partner_self_commitments
       SET status='active', updated_at=now()
     WHERE id = NEW.commitment_id AND status <> 'active';
  ELSIF NEW.status = 'rejected' AND COALESCE(OLD.status,'') <> 'rejected' THEN
    UPDATE public.partner_supported_houses
       SET status='cancelled', cancelled_at=now(), updated_at=now(),
           proxy_fee_status = CASE WHEN proxy_fee_status = 'pending' THEN 'cancelled' ELSE proxy_fee_status END
     WHERE commitment_id = NEW.commitment_id AND status='pending';
    UPDATE public.partner_self_commitments
       SET status='cancelled', updated_at=now()
     WHERE id = NEW.commitment_id AND status='pending_ops_approval';
  END IF;
  RETURN NEW;
END;
$function$;
