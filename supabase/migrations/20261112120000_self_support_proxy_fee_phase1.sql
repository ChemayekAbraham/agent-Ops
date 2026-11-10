-- Self-support agent facilitation fee, Phase 1: the price and the two amounts (owner design, 2026-11-10).
--
-- A partner who supports a tenant or an empty house themselves pays rent + 2%. The partner's
-- principal (Returns, maturity) is rent + 2%; the landlord (or operational funding, for an empty
-- house) gets the rent; at Partner Ops approval the 2% goes to the partner's proxy agent once
-- (Phase 2). The tenant's Rent Plan stays on the rent. Welile carries the 2% and its Returns from
-- the agent commission budget that is no longer paid out (Phase 3).
--
-- This phase:
--   1. self_support_fee_policy: one row, OFF by default. While it is off every amount below equals
--      the rent, so behaviour does not change until the owner switches it on (after Phases 2-5).
--   2. self_support_gross(rent): rent + rate, rounded UP to the nearest round_to (default 100).
--      self_support_proxy_fee(rent) = gross - rent. get_self_support_fee_policy() for the screens.
--   3. partner_self_funding_lines / partner_supported_houses gain rent_amount, proxy_fee,
--      proxy_fee_status, proxy_agent_id, proxy_fee_ledger_group_id. principal keeps its meaning
--      (the partner's principal: what Returns accrue on and what is repaid), so the Returns
--      accrual, maturity and partner screens need no change. Existing rows: rent_amount = principal.
--      A trigger fills rent_amount for any writer that does not set it (top-up approval, smoke tests).
--   4-6. The creation paths record rent + fee: psm_confirm_commitment_for (dashboard and promissory
--      tenant support), funder_support_tenant_direct (float-or-promise decision), and both
--      partner_support_houses overloads (empty houses). Minimums stay on the rent.
--
-- Money is untouched in this phase: approve_pending_portfolio still debits `principal` (which now
-- includes the fee) and psm_disburse_landlord_float still releases `principal` to landlord float.
-- Phase 2 changes the release to rent_amount and pays the fee. The switch must not be turned on
-- before Phase 2 is live.

-- 1. Policy (one row, off) --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.self_support_fee_policy (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled     boolean NOT NULL DEFAULT false,
  rate        numeric NOT NULL DEFAULT 0.02 CHECK (rate >= 0 AND rate < 0.10),
  round_to    numeric NOT NULL DEFAULT 100 CHECK (round_to >= 1),
  enabled_at  timestamptz,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);
COMMENT ON TABLE public.self_support_fee_policy IS
  'Self-support agent facilitation fee (owner design 2026-11-10): partners who support tenants or empty houses themselves pay rent + rate; the fee pays the proxy agent at Partner Ops approval. Off until Phases 2-5 are live.';
INSERT INTO public.self_support_fee_policy (id, note)
VALUES (true, 'Created off (Phase 1). Turn on only after the approval split (Phase 2) is live.')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.self_support_fee_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.self_support_fee_policy FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.self_support_fee_policy TO service_role;
DROP POLICY IF EXISTS mfa_required_for_staff ON public.self_support_fee_policy;
CREATE POLICY mfa_required_for_staff ON public.self_support_fee_policy AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

-- 2. Pricing --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.self_support_gross(p_rent numeric)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
           WHEN p_rent IS NULL OR p_rent <= 0 THEN p_rent
           WHEN NOT COALESCE(p.enabled, false) OR COALESCE(p.rate, 0) = 0 THEN p_rent
           ELSE ceil(p_rent * (1 + p.rate) / p.round_to) * p.round_to
         END
    FROM (SELECT 1) one
    LEFT JOIN public.self_support_fee_policy p ON p.id;
$function$;
COMMENT ON FUNCTION public.self_support_gross(numeric) IS
  'What a self-support partner pays for a rent (or empty-house rent): rent + the agent facilitation fee, rounded up to the policy round_to. Equals the rent while the policy is off.';

CREATE OR REPLACE FUNCTION public.self_support_proxy_fee(p_rent numeric)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(public.self_support_gross(p_rent) - p_rent, 0);
$function$;

CREATE OR REPLACE FUNCTION public.get_self_support_fee_policy()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'enabled', COALESCE(p.enabled, false),
    'rate', COALESCE(p.rate, 0),
    'round_to', COALESCE(p.round_to, 100),
    'enabled_at', p.enabled_at)
    FROM (SELECT 1) one
    LEFT JOIN public.self_support_fee_policy p ON p.id;
$function$;

-- 3. The two amounts on every self-support line ----------------------------------------------
ALTER TABLE public.partner_self_funding_lines
  ADD COLUMN IF NOT EXISTS rent_amount numeric,
  ADD COLUMN IF NOT EXISTS proxy_fee numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS proxy_fee_status text,
  ADD COLUMN IF NOT EXISTS proxy_agent_id uuid,
  ADD COLUMN IF NOT EXISTS proxy_fee_ledger_group_id uuid;
ALTER TABLE public.partner_supported_houses
  ADD COLUMN IF NOT EXISTS rent_amount numeric,
  ADD COLUMN IF NOT EXISTS proxy_fee numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS proxy_fee_status text,
  ADD COLUMN IF NOT EXISTS proxy_agent_id uuid,
  ADD COLUMN IF NOT EXISTS proxy_fee_ledger_group_id uuid;

COMMENT ON COLUMN public.partner_self_funding_lines.principal IS
  'The partner''s principal on this line: what Returns accrue on and what is repaid. rent_amount + proxy_fee.';
COMMENT ON COLUMN public.partner_self_funding_lines.rent_amount IS
  'The rent released to landlord float for this line (what the tenant''s Rent Plan is for).';
COMMENT ON COLUMN public.partner_self_funding_lines.proxy_fee IS
  'Agent facilitation fee the partner paid on this line (self_support_fee_policy). Paid once to the proxy agent at approval.';
COMMENT ON COLUMN public.partner_self_funding_lines.proxy_fee_status IS
  'NULL = no fee; pending = recorded, not yet approved; paid = sent to proxy_agent_id; kept = no proxy agent at approval, stays as partner capital; cancelled = portfolio rejected or cancelled before approval.';
COMMENT ON COLUMN public.partner_supported_houses.principal IS
  'The partner''s principal on this house: what Returns accrue on and what is repaid. rent_amount + proxy_fee.';
COMMENT ON COLUMN public.partner_supported_houses.rent_amount IS
  'The house''s monthly rent: the operational funding this support provides.';
COMMENT ON COLUMN public.partner_supported_houses.proxy_fee IS
  'Agent facilitation fee the partner paid on this house (self_support_fee_policy). Paid once to the proxy agent at approval.';
COMMENT ON COLUMN public.partner_supported_houses.proxy_fee_status IS
  'NULL = no fee; pending = recorded, not yet approved; paid = sent to proxy_agent_id; kept = no proxy agent at approval, stays as partner capital; cancelled = portfolio rejected or cancelled before approval.';

UPDATE public.partner_self_funding_lines SET rent_amount = principal WHERE rent_amount IS NULL;
UPDATE public.partner_supported_houses  SET rent_amount = principal WHERE rent_amount IS NULL;

-- Any writer that sets only principal (top-up approval, smoke tests, staff tools) gets rent_amount
-- = principal - proxy_fee; a principal change on a fee-free row moves rent_amount with it.
CREATE OR REPLACE FUNCTION public.self_support_line_amounts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.proxy_fee := COALESCE(NEW.proxy_fee, 0);
  IF TG_OP = 'INSERT' THEN
    IF NEW.rent_amount IS NULL THEN
      NEW.rent_amount := NEW.principal - NEW.proxy_fee;
    END IF;
  ELSIF NEW.principal IS DISTINCT FROM OLD.principal
        AND NEW.rent_amount IS NOT DISTINCT FROM OLD.rent_amount
        AND NEW.proxy_fee = 0 THEN
    NEW.rent_amount := NEW.principal;
  END IF;
  IF NEW.proxy_fee = 0 AND NEW.proxy_fee_status = 'pending' THEN
    NEW.proxy_fee_status := NULL;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.self_support_line_amounts() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_self_support_line_amounts ON public.partner_self_funding_lines;
CREATE TRIGGER trg_self_support_line_amounts
  BEFORE INSERT OR UPDATE OF principal, rent_amount, proxy_fee, proxy_fee_status ON public.partner_self_funding_lines
  FOR EACH ROW EXECUTE FUNCTION public.self_support_line_amounts();
DROP TRIGGER IF EXISTS trg_self_support_line_amounts ON public.partner_supported_houses;
CREATE TRIGGER trg_self_support_line_amounts
  BEFORE INSERT OR UPDATE OF principal, rent_amount, proxy_fee, proxy_fee_status ON public.partner_supported_houses
  FOR EACH ROW EXECUTE FUNCTION public.self_support_line_amounts();

ALTER TABLE public.partner_self_funding_lines
  DROP CONSTRAINT IF EXISTS partner_self_funding_lines_amounts_chk,
  ADD CONSTRAINT partner_self_funding_lines_amounts_chk CHECK (
        proxy_fee >= 0
    AND rent_amount IS NOT NULL
    AND principal = rent_amount + proxy_fee
    AND (proxy_fee_status IS NULL OR proxy_fee_status IN ('pending','paid','kept','cancelled'))
    AND (proxy_fee_status IS NOT NULL OR proxy_fee = 0));
ALTER TABLE public.partner_supported_houses
  DROP CONSTRAINT IF EXISTS partner_supported_houses_amounts_chk,
  ADD CONSTRAINT partner_supported_houses_amounts_chk CHECK (
        proxy_fee >= 0
    AND rent_amount IS NOT NULL
    AND principal = rent_amount + proxy_fee
    AND (proxy_fee_status IS NULL OR proxy_fee_status IN ('pending','paid','kept','cancelled'))
    AND (proxy_fee_status IS NOT NULL OR proxy_fee = 0));

-- 4. Dashboard and promissory-note tenant support: the partner pays rent + fee; lines keep both.
CREATE OR REPLACE FUNCTION public.psm_confirm_commitment_for(p_partner uuid, p_rent_request_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_actor uuid DEFAULT NULL::uuid, p_promissory_note_id uuid DEFAULT NULL::uuid, p_funding_mode text DEFAULT 'float'::text)
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
  v_mode text := COALESCE(NULLIF(p_funding_mode,''), 'float');
  v_rate numeric;
  v_stored numeric;
  v_gross numeric;  -- what the partner pays: rent + the agent facilitation fee
  v_fee numeric;
  -- The screen no longer decides the term. Promissory-note commitments keep
  -- their own requested term; every other self-support commitment is the
  -- contract term.
  v_term integer := CASE WHEN p_promissory_note_id IS NULL
                         THEN public.psm_contract_term_months()
                         ELSE GREATEST(1, LEAST(COALESCE(p_term_months,1), 12)) END;
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

  -- Self-support agent facilitation fee: the partner pays rent + the fee (0 while the policy is off).
  -- v_total stays the rent (minimums above); every amount the partner pays or earns on uses v_gross.
  SELECT COALESCE(SUM(public.self_support_gross(amount)),0) INTO v_gross
  FROM public.partner_self_plan_claims
  WHERE partner_id = p_partner AND status = 'held' AND expires_at > now()
    AND rent_request_id = ANY(p_rent_request_ids);
  v_fee := v_gross - v_total;

  v_available := public.funder_float_available(p_partner);
  v_reserved := public.funder_pending_hold(p_partner);

  IF v_mode = 'withdrawable' THEN
    IF v_gross > v_available THEN
      RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: plans total UGX %, partner has UGX % of operational float available (UGX % already awaiting approval).',
        round(v_gross), round(GREATEST(v_available,0)), round(v_reserved)
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_mode = 'float' THEN
    v_capacity := public.funder_float_available(p_partner);
    IF v_gross > v_capacity THEN
      RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: plans total UGX %, partner holds UGX % of operational float.',
        round(v_gross), round(GREATEST(v_capacity,0))
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- 'receivable': no capacity requirement; the promise is recorded by the caller.

  v_rate := public.partner_rate_now(p_partner);

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status, promissory_note_id
  ) VALUES (
    p_partner, v_gross, v_term, v_rate, v_count, v_key, 'pending_ops_approval', v_note
  ) RETURNING id INTO v_commitment_id;

  INSERT INTO public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, rent_amount, proxy_fee, proxy_fee_status,
    monthly_rate, term_months
  )
  SELECT v_commitment_id, p_partner, c.rent_request_id, g.gross, c.amount, g.gross - c.amount,
         CASE WHEN g.gross > c.amount THEN 'pending' END, v_rate, v_term
  FROM public.partner_self_plan_claims c
  CROSS JOIN LATERAL (SELECT public.self_support_gross(c.amount) AS gross) g
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
    roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    p_partner, COALESCE(v_agent, p_partner), v_code, v_gross, v_term,
    'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id, roi_percentage INTO v_portfolio_id, v_stored;

  IF v_stored IS DISTINCT FROM v_rate THEN
    PERFORM public._partner_commitment_follow_rate(v_commitment_id, v_stored);
    v_rate := v_stored;
  END IF;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months, promissory_note_id
  ) VALUES (v_portfolio_id, p_partner, v_gross, 'self_managed', v_commitment_id, v_term, v_note);

  PERFORM public.psm_audit(v_actor, p_partner, 'commitment_pending_ops_approval', 'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_gross, 'rent_amount', v_total, 'proxy_fee', v_fee,
                       'lines', v_count, 'term_months', v_term,
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
                                 'amount', v_gross, 'lines', v_count, 'actor_id', v_actor,
                                 'source', 'self_managed'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'committed_amount', v_gross, 'lines', v_count,
    'rent_amount', v_total, 'proxy_fee', v_fee,
    'monthly_return', round(v_gross * v_rate / 100),
    'roi_percentage', v_rate,
    'portfolio_id', v_portfolio_id,
    'promissory_note_id', v_note,
    'funding_mode', v_mode,
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(p_partner)
  );
END;
$function$;

-- 5. The float-or-promise decision compares the partner's float with what they will pay.
CREATE OR REPLACE FUNCTION public.funder_support_tenant_direct(p_rent_request_ids uuid[], p_promised_deposit_date date DEFAULT NULL::date, p_term_months integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_total numeric := 0;
  v_capacity numeric;
  v_mode text;
  v_res jsonb;
  v_key text;
  v_commitment uuid;
  v_portfolio uuid;
  v_receivables integer := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for direct tenant support' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_ids IS NULL OR array_length(p_rent_request_ids,1) IS NULL THEN
    RAISE EXCEPTION 'No plans supplied';
  END IF;

  -- What the partner pays: rent + the self-support agent facilitation fee (0 while the policy is off).
  SELECT COALESCE(SUM(public.self_support_gross(p.funding_amount)),0) INTO v_total
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = ANY(p_rent_request_ids);

  -- Operational float only; withdrawable money is never used for support.
  v_capacity := public.funder_support_capacity(v_uid);

  IF v_total > 0 AND v_capacity >= v_total THEN
    v_mode := 'float';
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

  v_key := 'psmd-' || v_uid::text || '-' || md5(array_to_string(p_rent_request_ids,','));

  PERFORM public.psm_release_cancelled_idempotency(v_uid, v_key);

  v_res := public.psm_confirm_commitment_for(
    v_uid, p_rent_request_ids, p_term_months,
    v_key,
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

  -- Covered path: NOTHING is debited here. approve_pending_portfolio performs
  -- the operational-float debit, the ledger posting and the landlord float release.
  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('rent_request_created', v_uid, 'partner_self_commitments', v_commitment,
            'Funder submitted direct tenant support for Partner Ops vetting',
            jsonb_build_object('amount', v_total, 'funding_mode', v_mode,
                               'portfolio_id', v_portfolio, 'status', 'pending_ops_approval'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  PERFORM public.psm_audit(v_uid, v_uid, 'direct_support_submitted_for_vetting',
    'partner_self_commitments', v_commitment,
    jsonb_build_object('amount', v_total, 'funding_mode', v_mode, 'portfolio_id', v_portfolio));

  RETURN v_res || jsonb_build_object(
    'funding_mode', v_mode,
    'status', 'pending_ops_approval',
    'awaiting_ops_approval', true,
    'from_withdrawable', 0,
    'from_float', 0,
    'landlord_float_released', false,
    'available_balance', public.funder_float_available(v_uid)
  );
END;
$function$;

-- 6. Empty-house support (new portfolio and the house top-up overload): the same two amounts.
CREATE OR REPLACE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := public.psm_contract_term_months();
  v_rate numeric;
  v_stored numeric;
  v_key text;
  v_total numeric := 0;  -- what the partner pays: rent + the agent facilitation fee
  v_rent numeric := 0;   -- the houses' monthly rent
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
  SELECT h.id AS house_id, public.self_support_gross(h.monthly_rent::numeric) AS principal,
         h.monthly_rent::numeric AS rent_amount,
         h.landlord_id, h.agent_id
  FROM public.house_listings h
  WHERE h.id = ANY(p_house_ids)
    AND h.verified = true
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden,false) = false
    AND COALESCE(h.monthly_rent,0) > 0
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(principal),0), COALESCE(SUM(rent_amount),0)
    INTO v_count, v_total, v_rent FROM _psh_pick;

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_house_ids,1),0) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some houses are no longer verified, empty or free. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_rent < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_rent)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(v_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: houses total UGX %, partner has UGX % of operational float available.',
      round(v_total), round(GREATEST(v_available,0)) USING ERRCODE = 'check_violation';
  END IF;

  v_rate := public.partner_rate_now(v_partner);

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id, roi_percentage INTO v_portfolio_id, v_stored;

  IF v_stored IS DISTINCT FROM v_rate THEN
    PERFORM public._partner_commitment_follow_rate(v_commitment_id, v_stored);
    v_rate := v_stored;
  END IF;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house', v_commitment_id, v_term);

  INSERT INTO public.partner_supported_houses (
    partner_id, house_id, commitment_id, portfolio_id, principal, rent_amount, proxy_fee, proxy_fee_status,
    monthly_rate, term_months,
    status, landlord_id, listing_agent_id, metadata
  )
  SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, p.rent_amount, p.principal - p.rent_amount,
           CASE WHEN p.principal > p.rent_amount THEN 'pending' END, v_rate, v_term,
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
    'roi_percentage', v_rate,
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(v_partner)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_commitment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := public.psm_contract_term_months();
  v_rate numeric;
  v_stored numeric;
  v_key text;
  v_total numeric := 0;  -- what the partner pays: rent + the agent facilitation fee
  v_rent numeric := 0;   -- the houses' monthly rent
  v_count integer := 0;
  v_available numeric;
  v_commitment_id uuid;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_existing public.partner_self_commitments%ROWTYPE;
  v_target public.partner_self_commitments%ROWTYPE;
  v_is_topup boolean := p_commitment_id IS NOT NULL;
  v_elig jsonb;
BEGIN
  IF v_partner IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED';
  END IF;

  v_key := COALESCE(NULLIF(p_idempotency_key,''),
    'psh-' || v_partner::text || '-' || COALESCE(p_commitment_id::text,'new') || '-' || md5(array_to_string(p_house_ids,',')));

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
  SELECT h.id AS house_id, public.self_support_gross(h.monthly_rent::numeric) AS principal,
         h.monthly_rent::numeric AS rent_amount,
         h.landlord_id, h.agent_id
  FROM public.house_listings h
  WHERE h.id = ANY(p_house_ids)
    AND h.verified = true
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden,false) = false
    AND COALESCE(h.monthly_rent,0) > 0
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(principal),0), COALESCE(SUM(rent_amount),0)
    INTO v_count, v_total, v_rent FROM _psh_pick;

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_house_ids,1),0) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some houses are no longer verified, empty or free. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_rent < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_rent)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(v_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: houses total UGX %, partner has UGX % of operational float available.',
      round(v_total), round(GREATEST(v_available,0)) USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_topup THEN
    SELECT * INTO v_target FROM public.partner_self_commitments
     WHERE id = p_commitment_id AND partner_id = v_partner FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;

    -- A rent-plan portfolio can never absorb house capital: the flows differ.
    IF EXISTS (SELECT 1 FROM public.partner_self_funding_lines
                WHERE commitment_id = v_target.id AND status <> 'cancelled') THEN
      RAISE EXCEPTION 'PORTFOLIO_KIND_MISMATCH: this portfolio funds rent plans, so houses cannot be added to it.'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT h.portfolio_id INTO v_portfolio_id FROM public.partner_supported_houses h
     WHERE h.commitment_id = v_target.id AND h.status <> 'cancelled' AND h.portfolio_id IS NOT NULL
     ORDER BY h.portfolio_id LIMIT 1;
    IF v_portfolio_id IS NULL THEN
      RAISE EXCEPTION 'PORTFOLIO_KIND_MISMATCH: this portfolio does not hold houses.'
        USING ERRCODE = 'check_violation';
    END IF;

    v_elig := public.partner_self_topup_eligibility(v_target.id);
    IF NOT (v_elig->>'allow_topup')::boolean THEN
      RAISE EXCEPTION 'PSM_TOPUP_WINDOW_CLOSED: %', COALESCE(v_elig->>'block_reason','Top-up not allowed')
        USING ERRCODE = 'check_violation';
    END IF;

    v_commitment_id := v_target.id;
    SELECT MIN(metadata->>'portfolio_code') INTO v_code FROM public.partner_supported_houses
     WHERE commitment_id = v_target.id AND status <> 'cancelled';

    -- A top-up keeps the rate stored on the portfolio (existing partners keep their rate).
    SELECT ip.roi_percentage INTO v_rate FROM public.investor_portfolios ip WHERE ip.id = v_portfolio_id;
    v_rate := COALESCE(v_rate, v_target.monthly_rate);

    INSERT INTO public.partner_supported_houses (
      partner_id, house_id, commitment_id, portfolio_id, principal, rent_amount, proxy_fee, proxy_fee_status,
    monthly_rate, term_months,
      status, landlord_id, listing_agent_id, metadata
    )
    SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, p.rent_amount, p.principal - p.rent_amount,
           CASE WHEN p.principal > p.rent_amount THEN 'pending' END,
           v_rate, COALESCE(v_target.term_months, v_term),
           'pending', p.landlord_id, p.agent_id,
           jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key, 'topup', true)
    FROM _psh_pick p;

    UPDATE public.partner_self_commitments
       SET lines_count = COALESCE(lines_count,0) + v_count, updated_at = now()
     WHERE id = v_commitment_id;

    INSERT INTO public.funder_pending_portfolios (
      portfolio_id, funder_id, amount, source, commitment_id, term_months
    ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house_topup', v_commitment_id,
              COALESCE(v_target.term_months, v_term));

    PERFORM public.psm_audit(v_partner, v_partner, 'house_support_topup_pending_ops_approval',
      'partner_self_commitments', v_commitment_id,
      jsonb_build_object('amount', v_total, 'houses', v_count, 'portfolio_id', v_portfolio_id,
                         'idempotency_key', v_key));

    RETURN jsonb_build_object(
      'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
      'topup', true, 'committed_amount', v_total, 'houses', v_count,
      'monthly_return', round(v_total * v_rate / 100),
      'roi_percentage', v_rate,
      'status', 'pending_ops_approval',
      'available_balance', public.funder_float_available(v_partner)
    );
  END IF;

  v_rate := public.partner_rate_now(v_partner);

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id, roi_percentage INTO v_portfolio_id, v_stored;

  IF v_stored IS DISTINCT FROM v_rate THEN
    PERFORM public._partner_commitment_follow_rate(v_commitment_id, v_stored);
    v_rate := v_stored;
  END IF;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house', v_commitment_id, v_term);

  INSERT INTO public.partner_supported_houses (
    partner_id, house_id, commitment_id, portfolio_id, principal, rent_amount, proxy_fee, proxy_fee_status,
    monthly_rate, term_months,
    status, landlord_id, listing_agent_id, metadata
  )
  SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, p.rent_amount, p.principal - p.rent_amount,
           CASE WHEN p.principal > p.rent_amount THEN 'pending' END, v_rate, v_term,
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
    'roi_percentage', v_rate,
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(v_partner)
  );
END;
$function$;

-- New functions are closed by default (doc 247 step 23): open the read-only pricing helpers to the
-- screens. The house support offer page is public, so anon may price too. The policy table itself
-- stays service_role only.
GRANT EXECUTE ON FUNCTION public.self_support_gross(numeric) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.self_support_proxy_fee(numeric) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_self_support_fee_policy() TO anon, authenticated;
