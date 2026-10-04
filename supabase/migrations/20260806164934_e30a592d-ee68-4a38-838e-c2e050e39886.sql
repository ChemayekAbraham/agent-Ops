-- 1. Pending funder portfolio review records
CREATE TABLE IF NOT EXISTS public.funder_pending_portfolios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL UNIQUE REFERENCES public.investor_portfolios(id) ON DELETE CASCADE,
  funder_id uuid NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  source text NOT NULL CHECK (source IN ('rent_pool','self_managed')),
  summary_id uuid,
  commitment_id uuid,
  term_months integer NOT NULL DEFAULT 12,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.funder_pending_portfolios TO authenticated;
GRANT ALL ON public.funder_pending_portfolios TO service_role;
ALTER TABLE public.funder_pending_portfolios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Funders view own pending portfolios"
  ON public.funder_pending_portfolios FOR SELECT TO authenticated
  USING (funder_id = auth.uid());

CREATE POLICY "Partner ops view pending portfolios"
  ON public.funder_pending_portfolios FOR SELECT TO authenticated
  USING (public.is_partner_ops(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_funder_pending_portfolios_status
  ON public.funder_pending_portfolios(status, created_at);
CREATE INDEX IF NOT EXISTS idx_funder_pending_portfolios_funder
  ON public.funder_pending_portfolios(funder_id, status);

CREATE TRIGGER trg_funder_pending_portfolios_updated_at
  BEFORE UPDATE ON public.funder_pending_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- allow self-managed commitments to sit in review
ALTER TABLE public.partner_self_commitments
  DROP CONSTRAINT IF EXISTS partner_self_commitments_status_check;
ALTER TABLE public.partner_self_commitments
  ADD CONSTRAINT partner_self_commitments_status_check
  CHECK (status = ANY (ARRAY['pending_ops_approval'::text,'active'::text,'matured'::text,'cancelled'::text]));

-- 2. Agreement gate helper
CREATE OR REPLACE FUNCTION public.funder_has_signed_agreement(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.partner_agreements pa
    WHERE pa.partner_id = p_user_id
      AND (pa.countersigned_at IS NOT NULL
           OR pa.status IN ('signed','active','completed','countersigned','verified'))
  ) OR EXISTS (
    SELECT 1 FROM public.supporter_agreement_acceptance sa
    WHERE sa.supporter_id = p_user_id AND sa.status = 'accepted'
  );
$$;

-- 3. Reserved (awaiting review) capital
CREATE OR REPLACE FUNCTION public.funder_pending_committed(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(amount), 0)::numeric
  FROM public.funder_pending_portfolios
  WHERE funder_id = p_user_id AND status = 'pending';
$$;

GRANT EXECUTE ON FUNCTION public.funder_has_signed_agreement(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.funder_pending_committed(uuid) TO authenticated;

-- 4. Create a pending (inactive) rent-pool portfolio: no ledger, no wallet movement
CREATE OR REPLACE FUNCTION public.funder_create_pending_portfolio(
  p_amount numeric,
  p_summary_id uuid DEFAULT NULL,
  p_term_months integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_available numeric;
  v_reserved numeric;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  IF NOT public.funder_has_signed_agreement(v_uid) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'Sign your partner agreement before creating a portfolio.';
  END IF;

  IF COALESCE(p_amount,0) < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000.' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('funder-pending-' || v_uid::text));

  v_available := public.get_user_available_balance(v_uid);
  v_reserved := public.funder_pending_committed(v_uid);

  IF p_amount > (v_available - v_reserved) THEN
    RAISE EXCEPTION 'You have UGX % available (UGX % already awaiting approval).',
      round(GREATEST(v_available - v_reserved, 0)), round(v_reserved)
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_uid ORDER BY created_at LIMIT 1;

  v_code := 'WPF-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_uid, COALESCE(v_agent, v_uid), v_code, p_amount,
    GREATEST(1, LEAST(COALESCE(p_term_months,12), 60)),
    15, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, summary_id, term_months
  ) VALUES (
    v_portfolio_id, v_uid, p_amount, 'rent_pool', p_summary_id,
    GREATEST(1, LEAST(COALESCE(p_term_months,12), 60))
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_uid, 'funder_pending_portfolio_created', 'investor_portfolios', v_portfolio_id,
    jsonb_build_object('reason','funder_created_pending_portfolio_awaiting_ops','amount',p_amount));

  RETURN jsonb_build_object(
    'portfolio_id', v_portfolio_id,
    'portfolio_code', v_code,
    'status', 'pending_ops_approval',
    'amount', p_amount
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.funder_create_pending_portfolio(numeric, uuid, integer) TO authenticated;

-- 5. Self-managed commitment now creates a pending portfolio and posts NO ledger
CREATE OR REPLACE FUNCTION public.partner_self_confirm_commitment(
  p_rent_request_ids uuid[],
  p_term_months integer DEFAULT 1,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := COALESCE(NULLIF(p_idempotency_key,''), 'psm-' || v_uid::text || '-' || md5(array_to_string(p_rent_request_ids,',')));
  v_existing public.partner_self_commitments%ROWTYPE;
  v_commitment_id uuid;
  v_total numeric;
  v_count integer;
  v_min numeric;
  v_available numeric;
  v_reserved numeric;
  v_rate numeric := 15;
  v_term integer := GREATEST(1, LEAST(COALESCE(p_term_months,1), 12));
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for self-managed funding' USING ERRCODE = '42501';
  END IF;

  IF NOT public.funder_has_signed_agreement(v_uid) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'Sign your partner agreement before creating a portfolio.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || v_uid::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
                              'committed_amount', v_existing.committed_amount,
                              'lines', v_existing.lines_count,
                              'status', v_existing.status);
  END IF;

  SELECT COUNT(*), COALESCE(SUM(amount),0), COALESCE(MIN(amount),0)
  INTO v_count, v_total, v_min
  FROM public.partner_self_plan_claims
  WHERE partner_id = v_uid AND status = 'held' AND expires_at > now()
    AND rent_request_id = ANY(p_rent_request_ids);

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_rent_request_ids,1),0) THEN
    RAISE EXCEPTION 'Some selections are no longer held by you. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_min < 50000 THEN
    RAISE EXCEPTION 'Each plan you fund must be at least UGX 50,000.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. Your selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.get_user_available_balance(v_uid);
  v_reserved := public.funder_pending_committed(v_uid);
  IF v_total > (v_available - v_reserved) THEN
    RAISE EXCEPTION 'Selected plans total UGX %. You have UGX % available (UGX % already awaiting approval).',
      round(v_total), round(GREATEST(v_available - v_reserved,0)), round(v_reserved)
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (
    v_uid, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval'
  ) RETURNING id INTO v_commitment_id;

  INSERT INTO public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months
  )
  SELECT v_commitment_id, v_uid, c.rent_request_id, c.amount, v_rate, v_term
  FROM public.partner_self_plan_claims c
  WHERE c.partner_id = v_uid AND c.status='held' AND c.rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.partner_self_plan_claims
     SET status='confirmed', confirmed_at=now(), commitment_id=v_commitment_id, updated_at=now()
   WHERE partner_id = v_uid AND status='held' AND rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.rent_requests rr
     SET self_funding_partner_id = v_uid,
         self_funding_line_id = l.id,
         updated_at = now()
  FROM public.partner_self_funding_lines l
  WHERE l.commitment_id = v_commitment_id AND rr.id = l.rent_request_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_uid ORDER BY created_at LIMIT 1;

  v_code := 'WSP-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_uid, COALESCE(v_agent, v_uid), v_code, v_total, v_term,
    v_rate, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, v_uid, v_total, 'self_managed', v_commitment_id, v_term);

  PERFORM public.psm_audit(v_uid, v_uid, 'commitment_pending_ops_approval', 'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'lines', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'available_before', v_available));

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'committed_amount', v_total, 'lines', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'portfolio_id', v_portfolio_id,
    'status', 'pending_ops_approval',
    'available_balance', public.get_user_available_balance(v_uid)
  );
END;
$$;

-- 6. Approval now performs the deferred money movement
CREATE OR REPLACE FUNCTION public.approve_pending_portfolio(p_portfolio_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_status text;
  v_pending public.funder_pending_portfolios%ROWTYPE;
  v_entries jsonb;
  v_group uuid;
  v_ref text;
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
    IF v_pending.source = 'self_managed' THEN
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
                       'ledger_group_id', v_group));

  RETURN p_portfolio_id;
END;
$$;

-- 7. Rejection releases everything
CREATE OR REPLACE FUNCTION public.reject_pending_portfolio(p_portfolio_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_status text;
  v_pending public.funder_pending_portfolios%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_partner_ops(v_caller) THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;
  IF length(COALESCE(btrim(p_reason),'')) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT status INTO v_status FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND'; END IF;
  IF v_status <> 'pending_ops_approval' THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING HINT = v_status;
  END IF;

  SELECT * INTO v_pending FROM public.funder_pending_portfolios
   WHERE portfolio_id = p_portfolio_id AND status = 'pending' FOR UPDATE;

  UPDATE public.investor_portfolios SET status = 'cancelled' WHERE id = p_portfolio_id;

  IF v_pending.id IS NOT NULL AND v_pending.source = 'self_managed' THEN
    UPDATE public.rent_requests rr
       SET self_funding_partner_id = NULL, self_funding_line_id = NULL, updated_at = now()
      FROM public.partner_self_funding_lines l
     WHERE l.commitment_id = v_pending.commitment_id AND rr.id = l.rent_request_id;

    UPDATE public.partner_self_plan_claims
       SET status = 'released', updated_at = now()
     WHERE commitment_id = v_pending.commitment_id;

    DELETE FROM public.partner_self_funding_lines WHERE commitment_id = v_pending.commitment_id;

    UPDATE public.partner_self_commitments
       SET status = 'cancelled', updated_at = now()
     WHERE id = v_pending.commitment_id;
  END IF;

  IF v_pending.id IS NOT NULL THEN
    UPDATE public.funder_pending_portfolios
       SET status = 'rejected', reviewed_by = v_caller, reviewed_at = now(),
           review_reason = btrim(p_reason), updated_at = now()
     WHERE id = v_pending.id;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'reject_pending_portfolio', 'investor_portfolios', p_portfolio_id,
    jsonb_build_object('reason', btrim(p_reason), 'prev_status', v_status));

  RETURN p_portfolio_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_pending_portfolio(uuid, text) TO authenticated;

-- 8. Partner Ops queue + summary
CREATE OR REPLACE FUNCTION public.partner_ops_pending_portfolios()
RETURNS TABLE (
  pending_id uuid,
  portfolio_id uuid,
  portfolio_code text,
  funder_id uuid,
  funder_name text,
  funder_email text,
  funder_phone text,
  amount numeric,
  source text,
  term_months integer,
  lines_count integer,
  created_at timestamptz,
  waiting_days integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT fp.id, fp.portfolio_id, ip.portfolio_code, fp.funder_id,
         p.full_name, p.email, p.phone,
         fp.amount, fp.source, fp.term_months,
         COALESCE(c.lines_count, 0),
         fp.created_at,
         GREATEST(0, EXTRACT(DAY FROM (now() - fp.created_at))::int)
  FROM public.funder_pending_portfolios fp
  JOIN public.investor_portfolios ip ON ip.id = fp.portfolio_id
  LEFT JOIN public.profiles p ON p.id = fp.funder_id
  LEFT JOIN public.partner_self_commitments c ON c.id = fp.commitment_id
  WHERE fp.status = 'pending'
    AND public.is_partner_ops(auth.uid())
  ORDER BY fp.created_at ASC;
$$;

CREATE OR REPLACE FUNCTION public.partner_ops_pending_portfolio_summary()
RETURNS TABLE (
  pending_count integer,
  pending_value numeric,
  oldest_wait_days integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::int,
         COALESCE(SUM(amount),0)::numeric,
         COALESCE(MAX(GREATEST(0, EXTRACT(DAY FROM (now() - created_at))::int)), 0)
  FROM public.funder_pending_portfolios
  WHERE status = 'pending' AND public.is_partner_ops(auth.uid());
$$;

GRANT EXECUTE ON FUNCTION public.partner_ops_pending_portfolios() TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_ops_pending_portfolio_summary() TO authenticated;