-- Self-support agent facilitation fee, Phase 4: top-up rules and the switch (owner design 2026-11-10).
--
--   1. Self-support portfolios are not topped up once the fee is on: a partner supports more tenants or
--      houses with a NEW portfolio each time (each new portfolio carries its own fee, paid at approval).
--      partner_self_topup_eligibility says so; partner_self_top_up and the house top-up overload of
--      partner_support_houses already refuse when it does (PSM_TOPUP_WINDOW_CLOSED). Top-ups already
--      pending (none on 2026-11-10) can still be approved.
--   2. set_self_support_fee_policy(enabled, note): the one switch, CEO only (or a database-owner session),
--      audited. Switching ON also raises the proxy agent rate on company-managed top-ups and on new
--      portfolios from promissory notes from 1% to 2% (owner: "all will earn 2% on top-ups and new
--      portfolios"), as a new promissory_commission_rates row effective at that moment, paid by the
--      commission gate as marketing expense like today. Switching OFF stops the fee on new self-support
--      portfolios and re-opens self top-ups; it does not lower the top-up rate (finance changes rates).

-- 1. Self top-ups close while the fee is on.
CREATE OR REPLACE FUNCTION public.self_support_topups_closed()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((SELECT p.enabled FROM public.self_support_fee_policy p WHERE p.id), false);
$function$;
REVOKE ALL ON FUNCTION public.self_support_topups_closed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.self_support_topups_closed() TO authenticated;

-- 2. The switch.
CREATE OR REPLACE FUNCTION public.set_self_support_fee_policy(p_enabled boolean, p_note text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_old  public.self_support_fee_policy%ROWTYPE;
  v_topup numeric;
  v_rate_row uuid;
BEGIN
  IF v_uid IS NOT NULL AND NOT public._has_enabled_role(v_uid, ARRAY['ceo']) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only the CEO can switch the self-support agent fee' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'ENABLED_REQUIRED'; END IF;

  SELECT * INTO v_old FROM public.self_support_fee_policy WHERE id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'POLICY_ROW_MISSING'; END IF;
  IF v_old.enabled = p_enabled THEN
    RETURN public.get_self_support_fee_policy() || jsonb_build_object('changed', false);
  END IF;

  UPDATE public.self_support_fee_policy
     SET enabled = p_enabled,
         enabled_at = CASE WHEN p_enabled THEN now() ELSE enabled_at END,
         updated_by = v_uid, updated_at = now(),
         note = COALESCE(NULLIF(btrim(p_note), ''), note)
   WHERE id;

  IF p_enabled THEN
    v_topup := public.promissory_commission_rate('portfolio_topup', now());
    IF COALESCE(v_topup, 0) < 0.02 THEN
      INSERT INTO public.promissory_commission_rates (kind, rate, effective_from, set_by, reason)
      VALUES ('portfolio_topup', 0.02, now(), v_uid,
              'Owner design 2026-11-10: proxy agent earns 2% on company-managed top-ups and new portfolios from promissory notes (self-support agent fee switched on)')
      RETURNING id INTO v_rate_row;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, old_values, new_values, reason)
  VALUES (v_uid, 'set_self_support_fee_policy', 'self_support_fee_policy', 'singleton',
          jsonb_build_object('enabled', v_old.enabled, 'rate', v_old.rate),
          jsonb_build_object('enabled', p_enabled, 'rate', v_old.rate, 'topup_rate_row', v_rate_row,
                             'topup_rate_before', v_topup),
          COALESCE(NULLIF(btrim(p_note), ''),
                   CASE WHEN p_enabled THEN 'Self-support agent facilitation fee switched on'
                        ELSE 'Self-support agent facilitation fee switched off' END));

  RETURN public.get_self_support_fee_policy()
      || jsonb_build_object('changed', true, 'topup_rate_row', v_rate_row);
END $function$;
REVOKE ALL ON FUNCTION public.set_self_support_fee_policy(boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_self_support_fee_policy(boolean, text) TO authenticated;

-- 3. Eligibility (read by both self top-up paths).
CREATE OR REPLACE FUNCTION public.partner_self_topup_eligibility(p_commitment_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  c public.partner_self_commitments%ROWTYPE;
  v_days_remaining integer;
  v_cycles_remaining integer;
  v_cycle_start date;
  v_cycle_end date;
  v_days_in_cycle integer;
  v_days_left_in_cycle integer;
  v_allow boolean;
  v_reason text;
  v_lockout_days integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO c FROM public.partner_self_commitments
   WHERE id = p_commitment_id AND partner_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Portfolio not found' USING ERRCODE = 'no_data_found';
  END IF;

  v_lockout_days := CASE WHEN COALESCE(c.term_months, public.psm_contract_term_months()) <= 3 THEN 5 ELSE 90 END;
  v_days_remaining   := GREATEST(0, COALESCE(c.term_end_at::date, CURRENT_DATE) - CURRENT_DATE);
  v_cycles_remaining := GREATEST(0, floor(v_days_remaining::numeric / 30)::integer);

  v_cycle_end   := COALESCE(c.next_payout_at::date, CURRENT_DATE + 30);
  v_cycle_start := (COALESCE(c.next_payout_at, now() + interval '1 month') - interval '1 month')::date;
  v_days_in_cycle      := GREATEST(1, v_cycle_end - v_cycle_start);
  v_days_left_in_cycle := GREATEST(0, v_cycle_end - CURRENT_DATE);

  IF public.self_support_topups_closed() THEN
    -- Owner design 2026-11-10: each self-support portfolio carries its own agent facilitation fee,
    -- so new capital opens a new portfolio instead of topping one up.
    v_allow := false;
    v_reason := 'Self-support portfolios are not topped up. Support more tenants or houses with a new portfolio.';
  ELSIF c.status <> 'active' THEN
    v_allow := false;
    v_reason := 'This portfolio is ' || c.status || '. New capital starts a fresh monthly portfolio.';
  ELSIF c.term_end_at IS NOT NULL AND v_days_remaining <= v_lockout_days THEN
    v_allow := false;
    v_reason := 'This portfolio matures in ' || v_days_remaining
             || ' days. The final ' || v_lockout_days || ' days are reserved for returning principal, so new capital starts a fresh monthly portfolio.';
  ELSE
    v_allow := true;
    v_reason := NULL;
  END IF;

  RETURN jsonb_build_object(
    'commitment_id', c.id,
    'status', c.status,
    'committed_amount', c.committed_amount,
    'monthly_rate', c.monthly_rate,
    'term_end_at', c.term_end_at,
    'next_payout_at', c.next_payout_at,
    'days_remaining', v_days_remaining,
    'cycles_remaining', v_cycles_remaining,
    'days_in_cycle', v_days_in_cycle,
    'days_left_in_cycle', v_days_left_in_cycle,
    'allow_topup', v_allow,
    'block_reason', v_reason,
    'available_balance', public.funder_float_available(v_uid)
  );
END;
$function$;
