
-- 1) Landlord float receivables ------------------------------------------------
CREATE TABLE public.landlord_float_receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  funder_id uuid NOT NULL,
  commitment_id uuid,
  rent_request_id uuid NOT NULL,
  landlord_id uuid,
  landlord_name text,
  tenant_id uuid,
  agent_id uuid,
  amount numeric NOT NULL CHECK (amount > 0),
  promised_deposit_date date NOT NULL,
  status text NOT NULL DEFAULT 'outstanding' CHECK (status IN ('outstanding','settled','cancelled')),
  settled_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.landlord_float_receivables TO authenticated;
GRANT ALL ON public.landlord_float_receivables TO service_role;

ALTER TABLE public.landlord_float_receivables ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Funders view their own landlord float receivables"
  ON public.landlord_float_receivables FOR SELECT TO authenticated
  USING (funder_id = (SELECT auth.uid()));

CREATE POLICY "Reviewers view all landlord float receivables"
  ON public.landlord_float_receivables FOR SELECT TO authenticated
  USING (public.psm_is_topup_reviewer((SELECT auth.uid())));

CREATE POLICY "Reviewers update landlord float receivables"
  ON public.landlord_float_receivables FOR UPDATE TO authenticated
  USING (public.psm_is_topup_reviewer((SELECT auth.uid())))
  WITH CHECK (public.psm_is_topup_reviewer((SELECT auth.uid())));

CREATE INDEX idx_lfr_funder_status ON public.landlord_float_receivables(funder_id, status);
CREATE INDEX idx_lfr_promised_date ON public.landlord_float_receivables(promised_deposit_date);
CREATE UNIQUE INDEX idx_lfr_open_per_plan
  ON public.landlord_float_receivables(rent_request_id) WHERE status = 'outstanding';

CREATE TRIGGER trg_lfr_updated_at
  BEFORE UPDATE ON public.landlord_float_receivables
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2) Support capacity = strict withdrawable + operational float ----------------
CREATE OR REPLACE FUNCTION public.funder_support_capacity(p_user_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT GREATEST(0, public.get_user_available_balance(p_user_id))
       + COALESCE((SELECT GREATEST(0, w.float_balance) FROM public.v_user_wallet_strict w
                    WHERE w.user_id = p_user_id), 0);
$$;

GRANT EXECUTE ON FUNCTION public.funder_support_capacity(uuid) TO authenticated, service_role;

-- 3) Allow the owning partner's own release path (scoped session flag) --------
CREATE OR REPLACE FUNCTION public.psm_is_topup_reviewer(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(current_setting('psm.owner_release', true), '') = 'on'
     OR (p_uid IS NOT NULL AND (
    public.is_ops_role(p_uid)
    OR public.is_partner_ops(p_uid)
    OR public.has_role(p_uid, 'cfo'::app_role)
    OR public.has_role(p_uid, 'coo'::app_role)
    OR public.has_role(p_uid, 'ceo'::app_role)
    OR public.has_role(p_uid, 'manager'::app_role)
    OR public.has_role(p_uid, 'super_admin'::app_role)
  ));
$$;

-- 4) Commitment confirm gains a funding mode ----------------------------------
CREATE OR REPLACE FUNCTION public.psm_confirm_commitment_for(
  p_partner uuid,
  p_rent_request_ids uuid[],
  p_term_months integer DEFAULT 1,
  p_idempotency_key text DEFAULT NULL::text,
  p_actor uuid DEFAULT NULL::uuid,
  p_promissory_note_id uuid DEFAULT NULL::uuid,
  p_funding_mode text DEFAULT 'withdrawable'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_key text := COALESCE(NULLIF(p_idempotency_key,''), 'psm-' || p_partner::text || '-' || md5(array_to_string(p_rent_request_ids,',')));
  v_existing public.partner_self_commitments%ROWTYPE;
  v_commitment_id uuid;
  v_total numeric;
  v_count integer;
  v_min numeric;
  v_available numeric;
  v_reserved numeric;
  v_capacity numeric;
  v_mode text := COALESCE(NULLIF(p_funding_mode,''), 'withdrawable');
  v_rate numeric := 15;
  v_term integer := GREATEST(1, LEAST(COALESCE(p_term_months,1), 12));
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_note uuid := p_promissory_note_id;
  v_actor uuid := COALESCE(p_actor, auth.uid(), p_partner);
BEGIN
  IF p_partner IS NULL THEN
    RAISE EXCEPTION 'PARTNER_REQUIRED';
  END IF;
  IF p_rent_request_ids IS NULL OR array_length(p_rent_request_ids,1) IS NULL THEN
    RAISE EXCEPTION 'No plans supplied';
  END IF;
  IF v_mode NOT IN ('withdrawable','float','receivable') THEN
    RAISE EXCEPTION 'INVALID_FUNDING_MODE';
  END IF;

  IF NOT public.funder_has_signed_agreement(p_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  IF v_note IS NULL THEN
    SELECT i.note_id INTO v_note
    FROM public.promissory_note_plan_intents i
    JOIN public.promissory_notes n ON n.id = i.note_id AND n.partner_user_id = p_partner
    WHERE i.rent_request_id = ANY(p_rent_request_ids)
      AND i.status IN ('reserved','funded')
    LIMIT 1;
  END IF;

  PERFORM public.psm_assert_no_foreign_booking(p_partner, p_rent_request_ids);

  PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || p_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
                              'committed_amount', v_existing.committed_amount,
                              'lines', v_existing.lines_count,
                              'status', v_existing.status);
  END IF;

  UPDATE public.partner_self_plan_claims
     SET status='expired', closed_at=now(), updated_at=now()
   WHERE status='held' AND expires_at <= now();

  INSERT INTO public.partner_self_plan_claims (rent_request_id, partner_id, amount, expires_at, idempotency_key)
  SELECT p.rent_request_id, p_partner, p.funding_amount, now() + interval '15 minutes', v_key
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = ANY(p_rent_request_ids)
    AND (p.held_by IS NULL OR p.held_by = p_partner)
  ON CONFLICT (rent_request_id) WHERE status IN ('held','confirmed') DO NOTHING;

  UPDATE public.partner_self_plan_claims
     SET expires_at = now() + interval '15 minutes', updated_at = now()
   WHERE partner_id = p_partner AND status = 'held' AND rent_request_id = ANY(p_rent_request_ids);

  SELECT COUNT(*), COALESCE(SUM(amount),0), COALESCE(MIN(amount),0)
  INTO v_count, v_total, v_min
  FROM public.partner_self_plan_claims
  WHERE partner_id = p_partner AND status = 'held' AND expires_at > now()
    AND rent_request_id = ANY(p_rent_request_ids);

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_rent_request_ids,1),0) THEN
    RAISE EXCEPTION 'Some selections are no longer available. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_min < 50000 THEN
    RAISE EXCEPTION 'Each plan funded must be at least UGX 50,000.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.get_user_available_balance(p_partner);
  v_reserved := public.funder_pending_hold(p_partner);

  IF v_mode = 'withdrawable' THEN
    IF v_total > v_available THEN
      RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: plans total UGX %, partner has UGX % available (UGX % already awaiting approval).',
        round(v_total), round(GREATEST(v_available,0)), round(v_reserved)
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_mode = 'float' THEN
    v_capacity := public.funder_support_capacity(p_partner);
    IF v_total > v_capacity THEN
      RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: plans total UGX %, partner holds UGX % across wallet and operational float.',
        round(v_total), round(GREATEST(v_capacity,0))
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- 'receivable': no capacity requirement; the promise is recorded by the caller.

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status, promissory_note_id
  ) VALUES (
    p_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval', v_note
  ) RETURNING id INTO v_commitment_id;

  INSERT INTO public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months
  )
  SELECT v_commitment_id, p_partner, c.rent_request_id, c.amount, v_rate, v_term
  FROM public.partner_self_plan_claims c
  WHERE c.partner_id = p_partner AND c.status='held' AND c.rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.partner_self_plan_claims
     SET status='confirmed', confirmed_at=now(), commitment_id=v_commitment_id, updated_at=now()
   WHERE partner_id = p_partner AND status='held' AND rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.rent_requests rr
     SET self_funding_partner_id = p_partner,
         self_funding_line_id = l.id,
         updated_at = now()
  FROM public.partner_self_funding_lines l
  WHERE l.commitment_id = v_commitment_id AND rr.id = l.rent_request_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = p_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSP-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_percentage, roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    p_partner, COALESCE(v_agent, p_partner), v_code, v_total, v_term,
    v_rate, 'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id INTO v_portfolio_id;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months, promissory_note_id
  ) VALUES (v_portfolio_id, p_partner, v_total, 'self_managed', v_commitment_id, v_term, v_note);

  PERFORM public.psm_audit(v_actor, p_partner, 'commitment_pending_ops_approval', 'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'lines', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'available_before', v_available,
                       'promissory_note_id', v_note,
                       'funding_mode', v_mode,
                       'idempotency_key', v_key));

  IF v_note IS NOT NULL THEN
    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('promissory.self_support.portfolio_created', p_partner, 'promissory_notes', v_note,
              'Promissory partner capital deployed as a self-support portfolio',
              jsonb_build_object('portfolio_id', v_portfolio_id, 'commitment_id', v_commitment_id,
                                 'amount', v_total, 'lines', v_count, 'actor_id', v_actor,
                                 'source', 'self_managed'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'committed_amount', v_total, 'lines', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'portfolio_id', v_portfolio_id,
    'promissory_note_id', v_note,
    'funding_mode', v_mode,
    'status', 'pending_ops_approval',
    'available_balance', public.get_user_available_balance(p_partner)
  );
END;
$function$;

-- 5) Direct support from a tenant card ---------------------------------------
CREATE OR REPLACE FUNCTION public.funder_support_tenant_direct(
  p_rent_request_ids uuid[],
  p_promised_deposit_date date DEFAULT NULL,
  p_term_months integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_total numeric := 0;
  v_avail numeric;
  v_capacity numeric;
  v_mode text;
  v_res jsonb;
  v_commitment uuid;
  v_portfolio uuid;
  v_from_w numeric := 0;
  v_from_f numeric := 0;
  v_entries jsonb := '[]'::jsonb;
  v_group uuid;
  v_ref text;
  v_float jsonb;
  v_receivables integer := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for direct tenant support' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_ids IS NULL OR array_length(p_rent_request_ids,1) IS NULL THEN
    RAISE EXCEPTION 'No plans supplied';
  END IF;

  SELECT COALESCE(SUM(p.funding_amount),0) INTO v_total
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = ANY(p_rent_request_ids);

  v_avail := GREATEST(0, public.get_user_available_balance(v_uid));
  v_capacity := public.funder_support_capacity(v_uid);

  IF v_total > 0 AND v_capacity >= v_total THEN
    v_mode := CASE WHEN v_avail >= v_total THEN 'withdrawable' ELSE 'float' END;
  ELSE
    v_mode := 'receivable';
    IF p_promised_deposit_date IS NULL THEN
      RAISE EXCEPTION 'DEPOSIT_DATE_REQUIRED'
        USING HINT = 'Choose the date you will deposit this amount into your wallet.',
              ERRCODE = 'check_violation';
    END IF;
    IF p_promised_deposit_date < CURRENT_DATE THEN
      RAISE EXCEPTION 'DEPOSIT_DATE_IN_PAST' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  v_res := public.psm_confirm_commitment_for(
    v_uid, p_rent_request_ids, p_term_months,
    'psmd-' || v_uid::text || '-' || md5(array_to_string(p_rent_request_ids,',')),
    v_uid, NULL, v_mode
  );

  v_commitment := (v_res->>'commitment_id')::uuid;
  v_portfolio := NULLIF(v_res->>'portfolio_id','')::uuid;

  IF COALESCE((v_res->>'idempotent_replay')::boolean, false) THEN
    RETURN v_res || jsonb_build_object('funding_mode', v_mode);
  END IF;

  IF v_mode = 'receivable' THEN
    INSERT INTO public.landlord_float_receivables (
      funder_id, commitment_id, rent_request_id, landlord_id, landlord_name,
      tenant_id, agent_id, amount, promised_deposit_date, notes
    )
    SELECT v_uid, v_commitment, l.rent_request_id, rr.landlord_id, ld.name,
           rr.tenant_id, COALESCE(rr.assigned_agent_id, rr.agent_id), l.principal,
           p_promised_deposit_date,
           'Funder supported the tenant directly with no wallet balance; deposit promised'
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.landlords ld ON ld.id = rr.landlord_id
     WHERE l.commitment_id = v_commitment
    ON CONFLICT DO NOTHING;

    v_receivables := (SELECT COUNT(*) FROM public.landlord_float_receivables
                       WHERE commitment_id = v_commitment AND status = 'outstanding');

    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('rent_request_created', v_uid, 'partner_self_commitments', v_commitment,
              'Funder pledged direct landlord float with a promised deposit date',
              jsonb_build_object('amount', v_total, 'promised_deposit_date', p_promised_deposit_date,
                                 'receivable_lines', v_receivables, 'funding_mode', 'receivable'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    RETURN v_res || jsonb_build_object(
      'funding_mode', 'receivable',
      'receivable_lines', v_receivables,
      'promised_deposit_date', p_promised_deposit_date,
      'landlord_float_released', false
    );
  END IF;

  -- Funded path: debit withdrawable first, then operational float.
  v_from_w := LEAST(v_total, v_avail);
  v_from_f := v_total - v_from_w;
  v_ref := 'DSF-' || upper(substr(replace(v_commitment::text,'-',''),1,8));

  IF v_from_w > 0 THEN
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object(
        'user_id', v_uid, 'amount', v_from_w, 'direction', 'cash_out',
        'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
        'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
        'source_table', 'partner_self_commitments', 'source_id', v_commitment::text,
        'reference_id', v_ref, 'linked_party', 'platform',
        'description', 'Direct tenant support released from spendable wallet'
      ),
      jsonb_build_object(
        'amount', v_from_w, 'direction', 'cash_in',
        'category', 'partner_funding', 'ledger_scope', 'platform',
        'source_table', 'partner_self_commitments', 'source_id', v_commitment::text,
        'reference_id', v_ref, 'linked_party', v_uid::text,
        'description', 'Partner capital received for direct tenant support'
      )
    );
  END IF;

  IF v_from_f > 0 THEN
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object(
        'user_id', v_uid, 'amount', v_from_f, 'direction', 'cash_out',
        'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
        'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
        'source_table', 'partner_self_commitments', 'source_id', v_commitment::text,
        'reference_id', v_ref, 'linked_party', 'platform',
        'description', 'Direct tenant support released from operational float'
      ),
      jsonb_build_object(
        'amount', v_from_f, 'direction', 'cash_in',
        'category', 'partner_funding', 'ledger_scope', 'platform',
        'source_table', 'partner_self_commitments', 'source_id', v_commitment::text,
        'reference_id', v_ref, 'linked_party', v_uid::text,
        'description', 'Partner operational float received for direct tenant support'
      )
    );
  END IF;

  v_group := public.create_ledger_transaction(
    entries := v_entries,
    idempotency_key := 'psm-commit-' || v_commitment::text
  );

  UPDATE public.partner_self_commitments
     SET status = 'active', ledger_group_id = v_group, updated_at = now()
   WHERE id = v_commitment;

  IF v_portfolio IS NOT NULL THEN
    UPDATE public.investor_portfolios
       SET status = 'active',
           next_roi_date = COALESCE(next_roi_date, (now() + interval '30 days')::date),
           maturity_date = COALESCE(maturity_date, (now() + interval '12 months')::date)
     WHERE id = v_portfolio;

    UPDATE public.funder_pending_portfolios
       SET status = 'approved', reviewed_by = v_uid, reviewed_at = now(), updated_at = now()
     WHERE portfolio_id = v_portfolio AND status = 'pending';
  END IF;

  -- Release the principal onto the tenant's agent landlord float.
  PERFORM set_config('psm.owner_release', 'on', true);
  v_float := public.psm_disburse_landlord_float(v_commitment, NULL, NULL);
  PERFORM set_config('psm.owner_release', 'off', true);

  PERFORM public.psm_audit(v_uid, v_uid, 'direct_support_released', 'partner_self_commitments', v_commitment,
    jsonb_build_object('amount', v_total, 'from_withdrawable', v_from_w, 'from_float', v_from_f,
                       'ledger_group_id', v_group, 'landlord_float', v_float,
                       'portfolio_id', v_portfolio));

  RETURN v_res || jsonb_build_object(
    'funding_mode', v_mode,
    'status', 'active',
    'from_withdrawable', v_from_w,
    'from_float', v_from_f,
    'landlord_float_released', true,
    'landlord_float', v_float,
    'available_balance', public.get_user_available_balance(v_uid)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.funder_support_tenant_direct(uuid[], date, integer) TO authenticated;
