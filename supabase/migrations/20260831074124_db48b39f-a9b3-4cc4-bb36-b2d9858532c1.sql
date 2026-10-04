-- 1. Allow the new pending-portfolio source
ALTER TABLE public.funder_pending_portfolios
  DROP CONSTRAINT IF EXISTS funder_pending_portfolios_source_check;
ALTER TABLE public.funder_pending_portfolios
  ADD CONSTRAINT funder_pending_portfolios_source_check
  CHECK (source = ANY (ARRAY['rent_pool'::text,'self_managed'::text,'self_managed_house'::text]));

-- 2. Partner ↔ house support relationship (the metadata carrier)
CREATE TABLE IF NOT EXISTS public.partner_supported_houses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  house_id uuid NOT NULL REFERENCES public.house_listings(id) ON DELETE RESTRICT,
  commitment_id uuid REFERENCES public.partner_self_commitments(id) ON DELETE SET NULL,
  portfolio_id uuid REFERENCES public.investor_portfolios(id) ON DELETE SET NULL,
  principal numeric NOT NULL CHECK (principal > 0),
  monthly_rate numeric NOT NULL DEFAULT 15 CHECK (monthly_rate >= 0 AND monthly_rate <= 100),
  term_months integer NOT NULL DEFAULT 1 CHECK (term_months >= 1 AND term_months <= 60),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status = ANY (ARRAY['pending'::text,'active'::text,'matured'::text,'cancelled'::text])),
  funding_tag text NOT NULL DEFAULT 'self_support_operational_house',
  landlord_id uuid,
  listing_agent_id uuid,
  supported_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  cancelled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.partner_supported_houses TO authenticated;
GRANT ALL ON public.partner_supported_houses TO service_role;

ALTER TABLE public.partner_supported_houses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Partners view own supported houses"
  ON public.partner_supported_houses FOR SELECT TO authenticated
  USING (partner_id = auth.uid());

CREATE POLICY "Ops and finance view supported houses"
  ON public.partner_supported_houses FOR SELECT TO authenticated
  USING (
    public.is_partner_ops(auth.uid())
    OR public.has_role(auth.uid(),'cfo')
    OR public.has_role(auth.uid(),'ceo')
    OR public.has_role(auth.uid(),'coo')
    OR public.has_role(auth.uid(),'financial_ops')
    OR public.has_role(auth.uid(),'manager')
    OR public.has_role(auth.uid(),'super_admin')
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_psh_house_live
  ON public.partner_supported_houses (house_id)
  WHERE status IN ('pending','active');
CREATE INDEX IF NOT EXISTS idx_psh_partner_status
  ON public.partner_supported_houses (partner_id, status);
CREATE INDEX IF NOT EXISTS idx_psh_commitment
  ON public.partner_supported_houses (commitment_id);
CREATE INDEX IF NOT EXISTS idx_psh_portfolio
  ON public.partner_supported_houses (portfolio_id);

DROP TRIGGER IF EXISTS trg_psh_updated_at ON public.partner_supported_houses;
CREATE TRIGGER trg_psh_updated_at BEFORE UPDATE ON public.partner_supported_houses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Partner submits a house-support portfolio (pending by default, no disbursement)
CREATE OR REPLACE FUNCTION public.partner_support_houses(
  p_house_ids uuid[],
  p_term_months integer DEFAULT 1,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := GREATEST(1, LEAST(COALESCE(p_term_months,1), 12));
  v_rate numeric := 15;
  v_key text;
  v_total numeric := 0;
  v_count integer := 0;
  v_available numeric;
  v_commitment_id uuid;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_existing public.partner_self_commitments%ROWTYPE;
BEGIN
  IF v_partner IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED';
  END IF;

  v_key := COALESCE(NULLIF(p_idempotency_key,''),
    'psh-' || v_partner::text || '-' || md5(array_to_string(p_house_ids,',')));

  IF NOT public.funder_has_signed_agreement(v_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psh-commit-' || v_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
      'committed_amount', v_existing.committed_amount, 'houses', v_existing.lines_count,
      'status', v_existing.status);
  END IF;

  CREATE TEMP TABLE _psh_pick ON COMMIT DROP AS
  SELECT h.id AS house_id, h.monthly_rent::numeric AS principal,
         h.landlord_id, h.agent_id
  FROM public.house_listings h
  WHERE h.id = ANY(p_house_ids)
    AND h.verified = true
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden,false) = false
    AND COALESCE(h.monthly_rent,0) > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.partner_supported_houses s
       WHERE s.house_id = h.id AND s.status IN ('pending','active')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.promissory_note_house_intents i
       WHERE i.house_id = h.id AND i.status = 'reserved'
    );

  SELECT COUNT(*), COALESCE(SUM(principal),0) INTO v_count, v_total FROM _psh_pick;

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_house_ids,1),0) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some houses are no longer verified, empty or free. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.get_user_available_balance(v_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: houses total UGX %, partner has UGX % available.',
      round(v_total), round(GREATEST(v_available,0)) USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    v_rate, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house', v_commitment_id, v_term);

  INSERT INTO public.partner_supported_houses (
    partner_id, house_id, commitment_id, portfolio_id, principal, monthly_rate, term_months,
    status, landlord_id, listing_agent_id, metadata
  )
  SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, v_rate, v_term,
         'pending', p.landlord_id, p.agent_id,
         jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key)
  FROM _psh_pick p;

  PERFORM public.psm_audit(v_partner, v_partner, 'house_support_pending_ops_approval',
    'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'houses', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'funding_tag','self_support_operational_house',
                       'idempotency_key', v_key));

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('portfolio_topup', v_partner, 'investor_portfolios', v_portfolio_id,
            'Partner submitted a verified-house self-support portfolio',
            jsonb_build_object('commitment_id', v_commitment_id, 'amount', v_total,
                               'houses', v_count, 'source','self_managed_house'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
    'committed_amount', v_total, 'houses', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'status', 'pending_ops_approval',
    'available_balance', public.get_user_available_balance(v_partner)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.partner_support_houses(uuid[],integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_support_houses(uuid[],integer,text) TO authenticated;

-- 4. Keep house support rows in step with the pending-portfolio decision
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
       SET status='cancelled', cancelled_at=now(), updated_at=now()
     WHERE commitment_id = NEW.commitment_id AND status='pending';
    UPDATE public.partner_self_commitments
       SET status='cancelled', updated_at=now()
     WHERE id = NEW.commitment_id AND status='pending_ops_approval';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_supported_houses_on_review ON public.funder_pending_portfolios;
CREATE TRIGGER trg_sync_supported_houses_on_review
  AFTER UPDATE OF status ON public.funder_pending_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.sync_supported_houses_on_review();

-- 5. Approval: house source posts tagged legs and NEVER touches landlord float
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
          'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
          'source_table', 'partner_supported_houses', 'source_id', s.id,
          'reference_id', s.house_id::text,
          'description', 'Partner self-support operational funding for verified house (self_support_operational_house)'
        ) AS e
        FROM public.partner_supported_houses s WHERE s.commitment_id = v_pending.commitment_id
        UNION ALL
        SELECT jsonb_build_object(
          'amount', s.principal, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'partner_supported_houses', 'source_id', s.id,
          'reference_id', s.house_id::text,
          'linked_party', v_pending.funder_id::text,
          'description', 'Self-support operational capital received for verified house (self_support_operational_house)'
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
                       'landlord_float', v_float));

  RETURN p_portfolio_id;
END;
$function$;

-- 6. Finance / CFO traceability
CREATE OR REPLACE VIEW public.v_partner_self_support_house_float AS
SELECT s.id,
       s.partner_id,
       p.full_name AS partner_name,
       s.house_id,
       h.title AS house_title,
       h.district,
       h.region,
       h.monthly_rent,
       s.landlord_id,
       s.listing_agent_id,
       s.commitment_id,
       s.portfolio_id,
       s.principal,
       s.monthly_rate,
       s.term_months,
       s.status,
       s.funding_tag,
       s.supported_at,
       s.activated_at
FROM public.partner_supported_houses s
JOIN public.house_listings h ON h.id = s.house_id
LEFT JOIN public.profiles p ON p.id = s.partner_id;

GRANT SELECT ON public.v_partner_self_support_house_float TO authenticated, service_role;