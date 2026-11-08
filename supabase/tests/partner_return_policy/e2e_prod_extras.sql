-- Phase 6 e2e: production functions the e2e suite drives that the Phase 1-4 stubs do not carry.
-- LOCAL THROWAWAY CLUSTER ONLY. Loaded by run_phase4_tests.sh e2e after its load (stubs + real Phase 1/2/4/4b) and sec_link_security_load.sql.
-- Function bodies below are copied VERBATIM from production (byrzshwlentqvktcksem, read 2026-11-07 with
-- pg_get_functiondef); the stub only gains the columns and no-op helpers those bodies reference.
--   split_portfolio_principal(uuid,numeric,text)   (owner-run split tool)
--   lock_portfolio_principal(uuid,numeric,text)    (owner-run lock tool)
--   apply_portfolio_renewal(uuid,uuid,text,text,boolean)  md5 ba3a13f55504742e3b9a6dea15656cfa (replaces the stub's copy)
--   approve_pending_portfolio(uuid)                md5 3fb98fd4302c5fc3935a53cb1c29db28
SET client_min_messages = warning;

-- Columns production has and these bodies read or write.
ALTER TABLE public.investor_portfolios
  ADD COLUMN IF NOT EXISTS account_name text, ADD COLUMN IF NOT EXISTS mobile_network text,
  ADD COLUMN IF NOT EXISTS mobile_money_number text, ADD COLUMN IF NOT EXISTS bank_name text,
  ADD COLUMN IF NOT EXISTS account_number text, ADD COLUMN IF NOT EXISTS bank_account_name text,
  ADD COLUMN IF NOT EXISTS display_currency text, ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by uuid, ADD COLUMN IF NOT EXISTS lock_reason text,
  ADD COLUMN IF NOT EXISTS principal_allocated numeric, ADD COLUMN IF NOT EXISTS principal_unallocated numeric,
  ADD COLUMN IF NOT EXISTS pending_renewal_request_id uuid, ADD COLUMN IF NOT EXISTS pending_renewal_duration_months integer,
  ADD COLUMN IF NOT EXISTS pending_renewal_effective_date date, ADD COLUMN IF NOT EXISTS allocation_note text;
ALTER TABLE public.portfolio_renewals
  ADD COLUMN IF NOT EXISTS renewed_by uuid, ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS old_created_at timestamptz, ADD COLUMN IF NOT EXISTS new_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS old_maturity_date text, ADD COLUMN IF NOT EXISTS new_maturity_date text,
  ADD COLUMN IF NOT EXISTS old_duration_months integer, ADD COLUMN IF NOT EXISTS new_duration_months integer,
  ADD COLUMN IF NOT EXISTS top_up_amount numeric, ADD COLUMN IF NOT EXISTS is_auto boolean,
  ADD COLUMN IF NOT EXISTS source text, ADD COLUMN IF NOT EXISTS old_status text,
  ADD COLUMN IF NOT EXISTS old_next_roi_date date, ADD COLUMN IF NOT EXISTS old_total_roi_earned numeric,
  ADD COLUMN IF NOT EXISTS old_investment_amount numeric, ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid, ADD COLUMN IF NOT EXISTS reversal_reason text;
ALTER TABLE public.funder_pending_portfolios ADD COLUMN IF NOT EXISTS reviewed_by uuid;

-- No-op stand-ins for production helpers outside the Returns rate (ledger/pool side effects).
CREATE OR REPLACE FUNCTION public.can_act_pinned_finance_action(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.landlord_pool_reserve(uuid, uuid, text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE OR REPLACE FUNCTION public.psm_disburse_landlord_float(uuid, uuid, uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;

-- ---------------------------------------------------------------- production text (verbatim)
CREATE OR REPLACE FUNCTION public.lock_portfolio_principal(p_portfolio_id uuid, p_locked_amount numeric, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_p record;
  v_locked numeric;
  v_remainder numeric;
  v_child_id uuid;
  v_suffix int;
  v_code text;
BEGIN
  -- Partner Operations is allow-listed for locking; everyone else still needs the pinned finance authority.
  IF auth.uid() IS NOT NULL
     AND NOT public.has_role(auth.uid(), 'partner_ops')
     AND NOT public.can_act_pinned_finance_action(auth.uid()) THEN
    RAISE EXCEPTION 'Only the Chief Finance Officer, a designated super admin or Partner Operations can do this.'
      USING ERRCODE = '42501';
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'manager')
    OR public.has_role(v_actor, 'ceo')
    OR public.has_role(v_actor, 'coo')
    OR public.has_role(v_actor, 'cfo')
    OR public.has_role(v_actor, 'super_admin')
    OR public.has_role(v_actor, 'partner_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorized to lock portfolios';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_p FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Portfolio not found';
  END IF;

  IF v_p.status = 'locked' THEN
    RAISE EXCEPTION 'Portfolio is already locked';
  END IF;

  v_locked := round(coalesce(p_locked_amount, 0));
  IF v_locked <= 0 THEN
    RAISE EXCEPTION 'Locked amount must be greater than zero';
  END IF;
  IF v_locked > round(v_p.investment_amount) THEN
    RAISE EXCEPTION 'Locked amount cannot exceed the portfolio principal';
  END IF;

  v_remainder := round(v_p.investment_amount) - v_locked;

  IF v_remainder < 1 THEN
    UPDATE public.investor_portfolios
       SET status = 'locked',
           locked_at = now(),
           locked_by = v_actor,
           lock_reason = btrim(p_reason)
     WHERE id = p_portfolio_id;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (v_actor, 'portfolio_locked_full', 'investor_portfolios', p_portfolio_id::text, btrim(p_reason),
            jsonb_build_object('locked_amount', v_locked, 'remaining_amount', 0, 'portfolio_code', v_p.portfolio_code));

    RETURN jsonb_build_object('mode', 'full', 'locked_amount', v_locked, 'remaining_amount', 0,
                              'locked_portfolio_id', p_portfolio_id);
  END IF;

  SELECT count(*)::int + 1 INTO v_suffix
    FROM public.investor_portfolios
   WHERE locked_from_portfolio_id = p_portfolio_id;
  v_code := coalesce(v_p.portfolio_code, 'WIP') || '-L' || v_suffix;

  INSERT INTO public.investor_portfolios (
    investor_id, invite_id, agent_id, portfolio_code, portfolio_pin, investment_amount, duration_months,
    roi_percentage, roi_mode, payment_method, mobile_network, mobile_money_number,
    bank_name, account_name, account_number, bank_account_name, status, payout_day,
    display_currency, maturity_date, next_roi_date, total_roi_earned,
    locked_at, locked_by, lock_reason, locked_from_portfolio_id
  ) VALUES (
    v_p.investor_id, v_p.invite_id, v_p.agent_id, v_code,
    coalesce(nullif(btrim(coalesce(v_p.portfolio_pin, '')), ''), lpad((floor(random() * 9000) + 1000)::int::text, 4, '0')),
    v_locked, v_p.duration_months,
    v_p.roi_percentage, v_p.roi_mode, v_p.payment_method, v_p.mobile_network, v_p.mobile_money_number,
    v_p.bank_name, v_p.account_name, v_p.account_number, v_p.bank_account_name, 'locked', v_p.payout_day,
    v_p.display_currency, v_p.maturity_date, v_p.next_roi_date, 0,
    now(), v_actor, btrim(p_reason), p_portfolio_id
  )
  RETURNING id INTO v_child_id;

  UPDATE public.investor_portfolios
     SET investment_amount = v_remainder
   WHERE id = p_portfolio_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, 'portfolio_locked_partial', 'investor_portfolios', p_portfolio_id::text, btrim(p_reason),
          jsonb_build_object('locked_amount', v_locked, 'remaining_amount', v_remainder,
                             'locked_portfolio_id', v_child_id, 'locked_portfolio_code', v_code,
                             'original_amount', round(v_p.investment_amount),
                             'portfolio_code', v_p.portfolio_code));

  RETURN jsonb_build_object('mode', 'partial', 'locked_amount', v_locked, 'remaining_amount', v_remainder,
                            'locked_portfolio_id', v_child_id, 'locked_portfolio_code', v_code);
END;
$function$;

CREATE OR REPLACE FUNCTION public.split_portfolio_principal(p_portfolio_id uuid, p_split_amount numeric, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_p record; v_split numeric; v_remainder numeric;
  v_child_id uuid; v_suffix int; v_code text;
  v_alloc numeric; v_need numeric; v_moved numeric := 0; v_moved_n int := 0; r record; v_ids uuid[] := '{}';
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.has_role(v_actor,'partner_ops') OR public.has_role(v_actor,'manager') OR public.has_role(v_actor,'coo')
       OR public.has_role(v_actor,'cfo') OR public.has_role(v_actor,'ceo') OR public.has_role(v_actor,'super_admin')) THEN
    RAISE EXCEPTION 'Not authorized to split portfolios' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN RAISE EXCEPTION 'A reason of at least 10 characters is required'; END IF;

  SELECT * INTO v_p FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Portfolio not found'; END IF;
  IF v_p.status <> 'active' THEN RAISE EXCEPTION 'Only active portfolios can be split'; END IF;
  IF v_p.pending_renewal_request_id IS NOT NULL THEN RAISE EXCEPTION 'Portfolio has a pending renewal'; END IF;

  v_split := round(coalesce(p_split_amount,0));
  IF v_split <= 0 THEN RAISE EXCEPTION 'Split amount must be greater than zero'; END IF;
  v_remainder := round(v_p.investment_amount) - v_split;
  IF v_remainder < 1 THEN RAISE EXCEPTION 'Split amount must be less than the portfolio principal'; END IF;

  v_alloc := round(coalesce(v_p.principal_allocated,0));
  v_need := v_alloc - v_remainder;
  -- Reservations on houses not yet funded travel with the split money.
  IF v_need > 0 THEN
    FOR r IN SELECT id, claimed_amount FROM public.portfolio_allocations
              WHERE portfolio_id = p_portfolio_id AND status = 'reserved'
              ORDER BY created_at DESC, claimed_amount DESC FOR UPDATE
    LOOP
      EXIT WHEN v_moved >= v_need;
      IF v_moved + coalesce(r.claimed_amount,0) <= v_split THEN
        v_ids := v_ids || r.id; v_moved := v_moved + coalesce(r.claimed_amount,0); v_moved_n := v_moved_n + 1;
      END IF;
    END LOOP;
    IF v_moved < v_need THEN
      RAISE EXCEPTION 'Split would leave less than the principal already placed on Rent Plans (UGX %). Only UGX % of house reservations could move with this amount — try a different amount.', v_alloc, v_moved;
    END IF;
  END IF;

  SELECT count(*)::int + 1 INTO v_suffix FROM public.investor_portfolios
   WHERE locked_from_portfolio_id = p_portfolio_id AND portfolio_code LIKE coalesce(v_p.portfolio_code,'WIP') || '-S%';
  v_code := coalesce(v_p.portfolio_code,'WIP') || '-S' || v_suffix;

  PERFORM set_config('app.portfolio_action', 'portfolio_split', true);

  INSERT INTO public.investor_portfolios (
    investor_id, invite_id, agent_id, portfolio_code, portfolio_pin, investment_amount, duration_months,
    roi_percentage, roi_mode, payment_method, mobile_network, mobile_money_number,
    bank_name, account_name, account_number, bank_account_name, status, payout_day,
    display_currency, maturity_date, next_roi_date, total_roi_earned, auto_reinvest,
    created_at, cfo_verified, cfo_verified_at, cfo_verified_by, investment_reference,
    locked_from_portfolio_id, allocation_note
  ) VALUES (
    v_p.investor_id, v_p.invite_id, v_p.agent_id, v_code,
    coalesce(nullif(btrim(coalesce(v_p.portfolio_pin,'')),''), lpad((floor(random()*9000)+1000)::int::text,4,'0')),
    v_split, v_p.duration_months, v_p.roi_percentage, v_p.roi_mode, v_p.payment_method, v_p.mobile_network,
    v_p.mobile_money_number, v_p.bank_name, v_p.account_name, v_p.account_number, v_p.bank_account_name,
    'locked', v_p.payout_day, v_p.display_currency, v_p.maturity_date, v_p.next_roi_date, 0, v_p.auto_reinvest,
    v_p.created_at, v_p.cfo_verified, v_p.cfo_verified_at, v_p.cfo_verified_by, v_p.investment_reference,
    p_portfolio_id, 'Split from ' || coalesce(v_p.portfolio_code,'portfolio')
  ) RETURNING id INTO v_child_id;

  UPDATE public.investor_portfolios SET status = 'active' WHERE id = v_child_id;

  IF v_moved_n > 0 THEN
    UPDATE public.portfolio_allocations SET portfolio_id = v_child_id WHERE id = ANY(v_ids);
  END IF;

  UPDATE public.investor_portfolios
     SET principal_allocated = v_moved, principal_unallocated = v_split - v_moved
   WHERE id = v_child_id;
  UPDATE public.investor_portfolios
     SET investment_amount = v_remainder,
         principal_allocated = v_alloc - v_moved,
         principal_unallocated = GREATEST(0, v_remainder - (v_alloc - v_moved))
   WHERE id = p_portfolio_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, 'portfolio_split', 'investor_portfolios', p_portfolio_id::text, btrim(p_reason),
    jsonb_build_object('split_amount', v_split, 'remaining_amount', v_remainder, 'original_amount', round(v_p.investment_amount),
      'new_portfolio_id', v_child_id, 'new_portfolio_code', v_code, 'portfolio_code', v_p.portfolio_code,
      'reservations_moved', v_moved_n, 'reserved_amount_moved', v_moved, 'moved_allocation_ids', to_jsonb(v_ids)));

  RETURN jsonb_build_object('new_portfolio_id', v_child_id, 'new_portfolio_code', v_code,
                            'split_amount', v_split, 'remaining_amount', v_remainder,
                            'reservations_moved', v_moved_n, 'reserved_amount_moved', v_moved);
END $function$;

CREATE OR REPLACE FUNCTION public.apply_portfolio_renewal(p_portfolio_id uuid, p_renewed_by uuid, p_reason text DEFAULT 'Auto-renewal at maturity'::text, p_source text DEFAULT 'manual'::text, p_is_auto boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_port record;
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_start_date date;
  v_new_start timestamptz;
  v_new_maturity date;
  v_new_next_roi date;
  v_duration int;
  v_renewal_id uuid;
  v_dupe uuid;
  v_is_compounding boolean;
BEGIN
  SELECT * INTO v_port FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'portfolio_not_found';
  END IF;

  -- Idempotency: never renew the same portfolio twice on the same day
  SELECT id INTO v_dupe
  FROM public.portfolio_renewals
  WHERE portfolio_id = p_portfolio_id
    AND reversed_at IS NULL
    AND created_at >= date_trunc('day', now())
  LIMIT 1;
  IF v_dupe IS NOT NULL THEN
    RETURN jsonb_build_object(
      'portfolio_id', p_portfolio_id,
      'skipped', true,
      'reason', 'already_renewed_today',
      'renewal_id', v_dupe
    );
  END IF;

  -- Final-payout gate: payout-mode portfolios wait until the payout nearest
  -- maturity has been credited (next_roi_date advanced past maturity + 15d).
  v_is_compounding := lower(COALESCE(v_port.roi_mode, '')) IN ('monthly_compounding', 'compound', 'compounding');
  IF NOT v_is_compounding
     AND (v_port.next_roi_date IS NULL
          OR v_port.next_roi_date <= COALESCE(v_port.maturity_date, v_today) + 15) THEN
    RETURN jsonb_build_object(
      'portfolio_id', p_portfolio_id,
      'portfolio_code', v_port.portfolio_code,
      'skipped', true,
      'reason', 'awaiting_final_payout',
      'cycle_date', v_port.next_roi_date,
      'maturity_date', v_port.maturity_date
    );
  END IF;

  -- Date the new term from the old maturity date when renewing shortly after
  -- it, so the wait for the final payout does not shift the partner's dates.
  IF v_port.maturity_date IS NOT NULL
     AND v_port.maturity_date <= v_today
     AND v_port.maturity_date >= v_today - 31 THEN
    v_start_date := v_port.maturity_date;
  ELSE
    v_start_date := v_today;
  END IF;
  v_new_start := CASE
    WHEN v_start_date = v_today THEN now()
    ELSE v_start_date::timestamp AT TIME ZONE 'Africa/Kampala'
  END;

  v_duration := COALESCE(v_port.pending_renewal_duration_months, v_port.duration_months, 12);
  v_new_maturity := (v_start_date + make_interval(months => v_duration))::date;
  v_new_next_roi := (v_start_date + interval '1 month')::date;
  IF v_port.payout_day IS NOT NULL THEN
    v_new_next_roi := (date_trunc('month', v_new_next_roi)::date + (v_port.payout_day - 1));
  END IF;

  UPDATE public.investor_portfolios SET
    created_at = v_new_start,
    maturity_date = v_new_maturity,
    next_roi_date = v_new_next_roi,
    total_roi_earned = 0,
    duration_months = v_duration,
    status = 'active',
    pending_renewal_effective_date = NULL,
    pending_renewal_duration_months = NULL,
    pending_renewal_request_id = NULL
  WHERE id = p_portfolio_id;

  INSERT INTO public.portfolio_renewals (
    portfolio_id, renewed_by, reason,
    old_created_at, new_created_at,
    old_maturity_date, new_maturity_date,
    old_roi_percentage, new_roi_percentage,
    old_duration_months, new_duration_months,
    top_up_amount,
    is_auto, source,
    old_status, old_next_roi_date, old_total_roi_earned, old_investment_amount
  ) VALUES (
    p_portfolio_id, p_renewed_by, p_reason,
    v_port.created_at, v_new_start,
    v_port.maturity_date::text, v_new_maturity::text,
    v_port.roi_percentage, v_port.roi_percentage,
    COALESCE(v_port.duration_months, v_duration), v_duration,
    0,
    p_is_auto, COALESCE(p_source, 'manual'),
    v_port.status, v_port.next_roi_date, COALESCE(v_port.total_roi_earned, 0), v_port.investment_amount
  )
  RETURNING id INTO v_renewal_id;

  RETURN jsonb_build_object(
    'portfolio_id', p_portfolio_id,
    'renewal_id', v_renewal_id,
    'portfolio_code', v_port.portfolio_code,
    'account_name', v_port.account_name,
    'investor_id', v_port.investor_id,
    'investment_amount', v_port.investment_amount,
    'roi_percentage', v_port.roi_percentage,
    'new_start', v_new_start,
    'new_maturity_date', v_new_maturity,
    'duration_months', v_duration,
    'skipped', false
  );
END;
$function$;

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
      RAISE EXCEPTION 'e2e: self_managed_house approval not modelled';
    ELSIF v_pending.source = 'self_managed' THEN
      RAISE EXCEPTION 'e2e: self_managed approval not modelled';
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

  v_pool := public.landlord_pool_reserve(p_portfolio_id, NULL, 'approve_pending_portfolio');

  IF v_pending.id IS NOT NULL THEN
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
                       'landlord_pool', v_pool));

  RETURN p_portfolio_id;
END;
$function$;
-- (approve_pending_portfolio: the two self-managed ledger branches are cut to a RAISE; the suite never
--  reaches them. Every other line is production's.)

REVOKE ALL ON FUNCTION public.split_portfolio_principal(uuid, numeric, text), public.lock_portfolio_principal(uuid, numeric, text),
  public.approve_pending_portfolio(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.split_portfolio_principal(uuid, numeric, text), public.lock_portfolio_principal(uuid, numeric, text),
  public.approve_pending_portfolio(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_portfolio_renewal(uuid, uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_portfolio_renewal(uuid, uuid, text, text, boolean) TO service_role;
-- Production's service_role has BYPASSRLS; the stub role does not (and the role is cluster-wide, so it is not altered).
-- A permissive service_role policy stands in on the tables the edge paths write through the admin client.
DO $p$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['investor_portfolios', 'promissory_notes', 'rent_requests', 'pending_wallet_operations', 'notifications'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL
       AND (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)
       AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ('public.' || t)::regclass AND polname = 'e2e_service_role_bypass') THEN
      EXECUTE format('CREATE POLICY e2e_service_role_bypass ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END $p$;
SELECT 'e2e prod extras ready';
