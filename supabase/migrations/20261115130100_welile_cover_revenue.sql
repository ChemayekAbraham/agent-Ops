-- Welile Cover on self-support approval.
--
-- When no proxy agent is resolved, self_support_pay_proxy_fee used to mark the
-- fee kept and post nothing. It now books a platform pair: partner capital
-- down (partner_funding) and Welile Cover revenue up (welile_cover_fee, R1).
-- When a proxy agent is paid, the same person still receives the same wallet
-- credit (agent_commission or partner_commission). The platform leg is tagged
-- welile_cover_fee so the cover has one name. Who is paid does not change.
--
-- This file is not applied by the pull request.

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
    -- No proxy agent: book Welile Cover as platform revenue. Nobody is paid.
    v_group := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'amount', v_fee, 'direction', 'cash_out',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'partner_self_commitments', 'source_id', p_commitment_id::text,
          'reference_id', v_idem, 'linked_party', v_partner::text,
          'description', 'Welile Cover reclassed out of partner capital (no proxy agent)'),
        jsonb_build_object(
          'amount', v_fee, 'direction', 'cash_in',
          'category', 'welile_cover_fee', 'ledger_scope', 'platform',
          'source_table', 'partner_self_commitments', 'source_id', p_commitment_id::text,
          'reference_id', v_idem, 'linked_party', v_partner::text,
          'description', 'Welile Cover revenue (no proxy agent)')
      ),
      v_idem);
    UPDATE public.partner_self_funding_lines
       SET proxy_fee_status = 'kept', proxy_fee_ledger_group_id = v_group, updated_at = now()
     WHERE commitment_id = p_commitment_id AND proxy_fee > 0 AND proxy_fee_status = 'pending';
    UPDATE public.partner_supported_houses
       SET proxy_fee_status = 'kept', proxy_fee_ledger_group_id = v_group, updated_at = now()
     WHERE commitment_id = p_commitment_id AND proxy_fee > 0 AND proxy_fee_status = 'pending';
    PERFORM public.psm_audit(auth.uid(), v_partner, 'proxy_fee_kept', 'partner_self_commitments', p_commitment_id,
      jsonb_build_object('fee', v_fee, 'rent', v_rent, 'reason', 'no_proxy_agent', 'ledger_group_id', v_group));
    RETURN jsonb_build_object('status', 'kept', 'fee', v_fee, 'ledger_group_id', v_group);
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
        'category', 'welile_cover_fee', 'ledger_scope', 'platform',
        'source_table', 'partner_self_commitments', 'source_id', p_commitment_id::text,
        'reference_id', v_idem, 'linked_party', v_partner::text,
        'description', 'Welile Cover: ' || v_label),
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

INSERT INTO public.ledger_account_map (ledger_scope, category, wallet_bucket, account_code, debit_when, notes)
SELECT 'platform', 'welile_cover_fee', NULL, 'R1', 'cash_out',
       'Welile Cover. Cash in is revenue when no proxy agent is paid. Cash out is the same cover when it is paid to a proxy agent.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.ledger_account_map m
   WHERE m.ledger_scope = 'platform' AND m.category = 'welile_cover_fee'
     AND m.wallet_bucket IS NULL
);

INSERT INTO public.fin_pnl_lines (account_code, category, section, line_label, sort, flag)
SELECT 'R1', 'welile_cover_fee', 'revenue', 'Welile Cover', 125, NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.fin_pnl_lines l
   WHERE l.account_code = 'R1' AND l.category = 'welile_cover_fee'
);
