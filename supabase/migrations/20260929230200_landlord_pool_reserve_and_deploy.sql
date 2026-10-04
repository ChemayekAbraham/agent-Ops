-- Landlord Float Pool — reserve and deploy (checklist step 8a).
--
-- Design: docs/LANDLORD_POOL_FUNDING_DESIGN.md
-- Needs:  20260929230000_landlord_pool_accounts_and_categories.sql
--         20260929230100_landlord_pool_schema.sql
--
-- Everything is inert until treasury_controls.landlord_pool_from is enabled.
--
-- ── Why deploy no longer pairs with rent_receivable_created ──────────────
-- Tenant funding already posts `rent_disbursement` (CR A1) + `rent_receivable_
-- created` (DR A3), and 18 database functions plus 23 app files read
-- `rent_disbursement` (reports, cash-flow, KPIs, the cancel and release
-- reversals). Replacing it would silently drop new portfolios from all of
-- them. So the tenant funding group is left exactly as it is, and the pool
-- draw is a SEPARATE group beside it:
--
--   pool deploy  landlord_pool_deploy_<origin>  cash_out  CR A21/A22
--                landlord_pool_deploy_target    cash_in   DR A1
--
-- Net of both groups: A21/A22 down, A3 up, A1 unchanged — the same economics
-- as the design, with no reader of rent_disbursement affected.
--
-- ── Why reserve runs on activation, from a trigger ────────────────────────
-- Portfolios become active through at least eight edge functions, two
-- SECURITY DEFINER RPCs and two frontend buttons that update status directly.
-- `enforce_portfolio_funding_at_creation` already guarantees each active or
-- pending-approval portfolio is funded in the ledger at insert. So the one
-- reliable hook is "status became active": an AFTER trigger on
-- investor_portfolios. It is non-blocking — an unexpected failure is filed in
-- landlord_pool_exceptions for replay and the activation proceeds, because
-- the partner's money has already moved and unwinding it is worse.
-- approve_pending_portfolio calls reserve explicitly after its own debits
-- (step 9), since it flips status BEFORE posting them.

-- ── Mapping + allowlist for the deploy counterpart ────────────────────────
INSERT INTO public.ledger_account_map (ledger_scope, wallet_bucket, category, account_code, debit_when, notes)
VALUES ('platform', NULL, 'landlord_pool_deploy_target', 'A1', 'cash_in',
        'Landlord Float Pool: pool money drawn back into treasury to fund a tenant (DR A1); pairs with landlord_pool_deploy_<origin> CR A21/A22. Sits beside the unchanged rent_disbursement group.')
ON CONFLICT (ledger_scope, category, COALESCE(wallet_bucket, '*')) DO NOTHING;

UPDATE public.ledger_account_map
   SET notes = 'Landlord Float Pool: self-support money drawn to fund a tenant (posted cash_out = CR A21); pairs with landlord_pool_deploy_target DR A1.',
       updated_at = now()
 WHERE ledger_scope = 'platform' AND category = 'landlord_pool_deploy_self_support' AND wallet_bucket IS NULL;
UPDATE public.ledger_account_map
   SET notes = 'Landlord Float Pool: company-managed money drawn to fund a tenant (posted cash_out = CR A22); pairs with landlord_pool_deploy_target DR A1.',
       updated_at = now()
 WHERE ledger_scope = 'platform' AND category = 'landlord_pool_deploy_company_managed' AND wallet_bucket IS NULL;

CREATE OR REPLACE FUNCTION public.ledger_category_allowlist()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT public.ledger_category_allowlist_base() || ARRAY[
    'agent_advance_receivable_opening',
    'agent_access_fee_receivable_opening',
    'merchandise_recovery_receivable_opening',
    'bike_recovery_receivable_opening',
    'credit_draw_receivable_opening',
    'merchandise_credit_sale_receivable_opening',
    'service_centre_advance_receivable_opening',
    'service_centre_receivable_opening',
    'tenant_service_charge_receivable_opening',
    'business_advance_receivable_opening',
    'rent_plan_receivable_restatement',
    'receivable_restatement_equity',
    'merchandise_recovery_repayment',
    'bike_recovery_repayment',
    'credit_draw_repayment',
    'smartphone_advance_receivable',
    'agent_advance_disbursement',
    'agent_advance_access_fee_charged',
    'agent_advance_registration_fee_charged',
    'agent_advance_fee_revenue',
    'agent_advance_penalty_accrued',
    'agent_advance_penalty_unearned',
    'agent_advance_access_fee_collected',
    'agent_advance_registration_fee_collected',
    'agent_advance_written_off',
    'agent_advance_access_fee_written_off',
    'agent_advance_registration_fee_written_off',
    'agent_advance_reversed',
    'agent_advance_clawback',
    'agent_advance_late_fee_income',
    'agent_advance_access_fee_collected_external',
    'agent_advance_registration_fee_collected_external',
    'agent_advance_penalty_accrued_external',
    -- Landlord Float Pool (20260929230000, 20260929230200)
    'landlord_pool_reserve_self_support',
    'landlord_pool_reserve_company_managed',
    'landlord_pool_reserve_source',
    'landlord_pool_deploy_self_support',
    'landlord_pool_deploy_company_managed',
    'landlord_pool_deploy_target',
    'landlord_pool_return_self_support',
    'landlord_pool_return_company_managed',
    'landlord_pool_return_source',
    'landlord_pool_release_self_support',
    'landlord_pool_release_company_managed',
    'landlord_pool_release_target'
  ]::text[];
$function$;

-- ── Cutover: NULL means the pool is off ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.landlord_pool_cutover()
 RETURNS timestamptz
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN tc.enabled AND NULLIF(tc.value, '') IS NOT NULL
              THEN tc.value::timestamptz END
    FROM public.treasury_controls tc
   WHERE tc.control_key = 'landlord_pool_from';
$function$;

-- ── Internal: post one deploy / return / release against an entry ─────────
-- Posts the balanced group, records the movement, and updates the entry's
-- totals — once. A retry with the same p_ref gets the same ledger group back
-- from create_ledger_transaction, and the (entry, group) key on movements
-- stops it being counted twice.
CREATE OR REPLACE FUNCTION public._landlord_pool_post(
  p_entry_id        uuid,
  p_kind            text,
  p_amount          numeric,
  p_ref             text,
  p_rent_request_id uuid DEFAULT NULL,
  p_allocation_id   uuid DEFAULT NULL,
  p_collection_id   uuid DEFAULT NULL,
  p_description     text DEFAULT NULL
) RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  e          public.landlord_pool_entries%ROWTYPE;
  v_pool_dir text;
  v_other    text;
  v_other_dir text;
  v_group    uuid;
  v_ins      integer;
  v_desc     text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'LANDLORD_POOL_INVALID_AMOUNT' USING HINT = coalesce(p_amount::text, 'null');
  END IF;
  IF p_ref IS NULL OR p_ref = '' THEN
    RAISE EXCEPTION 'LANDLORD_POOL_REF_REQUIRED';
  END IF;

  SELECT * INTO e FROM public.landlord_pool_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LANDLORD_POOL_ENTRY_NOT_FOUND' USING HINT = p_entry_id::text; END IF;

  CASE p_kind
    WHEN 'deploy' THEN
      v_pool_dir := 'cash_out'; v_other := 'landlord_pool_deploy_target'; v_other_dir := 'cash_in';
    WHEN 'return' THEN
      v_pool_dir := 'cash_in';  v_other := 'landlord_pool_return_source'; v_other_dir := 'cash_out';
    WHEN 'release' THEN
      v_pool_dir := 'cash_out'; v_other := 'landlord_pool_release_target'; v_other_dir := 'cash_in';
    ELSE
      RAISE EXCEPTION 'LANDLORD_POOL_INVALID_KIND' USING HINT = coalesce(p_kind, 'null');
  END CASE;

  -- Idempotent retry: already posted and counted → return the same group.
  SELECT m.ledger_group_id INTO v_group
    FROM public.landlord_pool_movements m
    JOIN public.general_ledger gl ON gl.transaction_group_id = m.ledger_group_id
   WHERE m.pool_entry_id = e.id AND m.kind = p_kind
     AND gl.idempotency_key = 'lp-' || p_kind || '-' || e.id::text || '-' || p_ref
   LIMIT 1;
  IF v_group IS NOT NULL THEN RETURN v_group; END IF;

  IF p_kind IN ('deploy','release') AND p_amount > e.in_pool + 0.005 THEN
    RAISE EXCEPTION 'LANDLORD_POOL_INSUFFICIENT' USING HINT = format('entry %s holds %s, asked %s', e.id, e.in_pool, p_amount);
  END IF;
  IF p_kind = 'return' AND p_amount > e.out_with_tenants + 0.005 THEN
    RAISE EXCEPTION 'LANDLORD_POOL_RETURN_EXCEEDS_DEPLOYED' USING HINT = format('entry %s has %s out, asked %s', e.id, e.out_with_tenants, p_amount);
  END IF;

  v_desc := coalesce(p_description,
    format('Landlord Float Pool %s (%s) — %s', p_kind, replace(e.origin, '_', '-'), p_ref));

  v_group := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'ledger_scope', 'platform', 'category', 'landlord_pool_' || p_kind || '_' || e.origin,
        'direction', v_pool_dir, 'amount', p_amount, 'currency', 'UGX',
        'source_table', e.source_table, 'source_id', e.source_id, 'reference_id', p_ref,
        'linked_party', e.partner_id::text, 'description', v_desc),
      jsonb_build_object(
        'ledger_scope', 'platform', 'category', v_other,
        'direction', v_other_dir, 'amount', p_amount, 'currency', 'UGX',
        'source_table', e.source_table, 'source_id', e.source_id, 'reference_id', p_ref,
        'linked_party', e.partner_id::text, 'description', v_desc)),
    idempotency_key := 'lp-' || p_kind || '-' || e.id::text || '-' || p_ref);

  INSERT INTO public.landlord_pool_movements
    (pool_entry_id, kind, amount, rent_request_id, allocation_id, collection_id, ledger_group_id, created_by)
  VALUES (e.id, p_kind, p_amount, p_rent_request_id, p_allocation_id, p_collection_id, v_group, auth.uid())
  ON CONFLICT (pool_entry_id, ledger_group_id) DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;

  IF v_ins = 1 THEN
    UPDATE public.landlord_pool_entries
       SET deployed = deployed + CASE WHEN p_kind = 'deploy'  THEN p_amount ELSE 0 END,
           returned = returned + CASE WHEN p_kind = 'return'  THEN p_amount ELSE 0 END,
           released = released + CASE WHEN p_kind = 'release' THEN p_amount ELSE 0 END,
           updated_at = now()
     WHERE id = e.id;
    UPDATE public.landlord_pool_entries
       SET status = 'closed'
     WHERE id = e.id AND in_pool = 0 AND out_with_tenants = 0 AND status = 'open';
  END IF;

  RETURN v_group;
END;
$function$;

-- ── Reserve: a portfolio's principal enters the pool ──────────────────────
-- Returns a status instead of raising for every expected "not yet" case, so
-- the activation trigger can call it blindly:
--   pool_off · pre_cutover · not_active · split_child · not_funded ·
--   already_reserved · reserved
-- Raises only on genuine faults (missing self-support attachments).
CREATE OR REPLACE FUNCTION public.landlord_pool_reserve(
  p_portfolio_id      uuid,
  p_funding_group_ids uuid[] DEFAULT NULL,
  p_caller            text   DEFAULT 'unknown'
) RETURNS jsonb
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

  IF p.created_at < v_cut THEN RETURN jsonb_build_object('status', 'pre_cutover'); END IF;
  IF p.status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('status', 'not_active', 'portfolio_status', p.status);
  END IF;
  -- Split children carve principal out of an existing portfolio; that money
  -- is the parent's and was never new cash.
  IF p.locked_from_portfolio_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'split_child');
  END IF;

  SELECT * INTO fp FROM public.funder_pending_portfolios
   WHERE portfolio_id = p.id ORDER BY created_at DESC LIMIT 1;

  -- Origin is decided by what is ATTACHED, never by who created it.
  IF fp.source = 'self_managed' AND fp.commitment_id IS NOT NULL THEN
    v_origin := 'self_support';
    SELECT jsonb_agg(jsonb_build_object('st', 'partner_self_funding_lines', 'id', l.id, 'amt', l.principal))
      INTO v_targets
      FROM public.partner_self_funding_lines l
     WHERE l.commitment_id = fp.commitment_id AND l.principal > 0;
  ELSIF fp.source = 'self_managed_house' AND fp.commitment_id IS NOT NULL THEN
    v_origin := 'self_support';
    SELECT jsonb_agg(jsonb_build_object('st', 'partner_supported_houses', 'id', s.id, 'amt', s.principal))
      INTO v_targets
      FROM public.partner_supported_houses s
     WHERE s.commitment_id = fp.commitment_id AND s.principal > 0;
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

  -- Already reserved? (every target has an entry) → idempotent no-op.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_targets) x
     WHERE NOT EXISTS (SELECT 1 FROM public.landlord_pool_entries e
                        WHERE e.source_table = x->>'st' AND e.source_id = (x->>'id')::uuid)
  ) THEN
    RETURN jsonb_build_object('status', 'already_reserved', 'origin', v_origin, 'total', v_total);
  END IF;

  -- The principal must have left a wallet in the ledger. Reserving cash the
  -- books never recorded arriving would understate A1 with nothing behind it.
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

-- ── Deploy: pool money funds a tenant ─────────────────────────────────────
-- Call AFTER the unchanged rent_disbursement group has posted. Draws up to
-- p_amount from one origin (D6: never mixed) — a named entry, or oldest
-- first. Whatever the pool cannot cover stays funded by plain treasury, which
-- is what rent_disbursement already recorded; `shortfall` reports it.
CREATE OR REPLACE FUNCTION public.landlord_pool_deploy(
  p_rent_request_id uuid,
  p_amount          numeric,
  p_origin          text,
  p_allocation_id   uuid DEFAULT NULL,
  p_pool_entry_id   uuid DEFAULT NULL,
  p_caller          text DEFAULT 'unknown'
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_left   numeric := p_amount;
  v_take   numeric;
  v_first  uuid;
  v_out    jsonb := '[]'::jsonb;
  r        record;
BEGIN
  IF public.landlord_pool_cutover() IS NULL THEN
    RETURN jsonb_build_object('status', 'pool_off', 'drawn', 0, 'shortfall', p_amount);
  END IF;
  IF p_origin NOT IN ('self_support', 'company_managed') THEN
    RAISE EXCEPTION 'LANDLORD_POOL_INVALID_ORIGIN' USING HINT = coalesce(p_origin, 'null');
  END IF;
  IF p_rent_request_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'LANDLORD_POOL_INVALID_DEPLOY';
  END IF;

  -- Already deployed for this rent request? Idempotent: report what exists.
  IF EXISTS (SELECT 1 FROM public.landlord_pool_movements m
              WHERE m.rent_request_id = p_rent_request_id AND m.kind = 'deploy') THEN
    RETURN jsonb_build_object('status', 'already_deployed',
      'drawn', (SELECT sum(amount) FROM public.landlord_pool_movements
                 WHERE rent_request_id = p_rent_request_id AND kind = 'deploy'));
  END IF;

  FOR r IN
    SELECT e.id, e.in_pool
      FROM public.landlord_pool_entries e
     WHERE e.origin = p_origin AND e.status = 'open' AND e.in_pool > 0
       AND (p_pool_entry_id IS NULL OR e.id = p_pool_entry_id)
     ORDER BY e.created_at, e.id
     FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := least(v_left, r.in_pool);
    PERFORM public._landlord_pool_post(r.id, 'deploy', v_take, p_rent_request_id::text,
                                       p_rent_request_id, p_allocation_id);
    v_first := coalesce(v_first, r.id);
    v_left := v_left - v_take;
    v_out := v_out || jsonb_build_object('entry_id', r.id, 'amount', v_take);
  END LOOP;

  IF p_allocation_id IS NOT NULL AND v_first IS NOT NULL THEN
    UPDATE public.agent_landlord_float_allocations
       SET pool_origin = p_origin, pool_entry_id = v_first, updated_at = now()
     WHERE id = p_allocation_id AND pool_entry_id IS NULL;
  END IF;

  RETURN jsonb_build_object('status', CASE WHEN v_first IS NULL THEN 'pool_empty' ELSE 'deployed' END,
                            'origin', p_origin, 'drawn', p_amount - v_left, 'shortfall', v_left,
                            'draws', v_out, 'caller', p_caller);
END;
$function$;

-- ── Activation trigger ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_landlord_pool_reserve_on_activation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_res jsonb;
BEGIN
  IF NEW.status IS DISTINCT FROM 'active' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'active' THEN RETURN NULL; END IF;
  IF public.landlord_pool_cutover() IS NULL THEN RETURN NULL; END IF;

  BEGIN
    v_res := public.landlord_pool_reserve(NEW.id, NULL, 'activation_trigger:' || TG_OP);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
    VALUES (NEW.id, 'reserve', 'activation_trigger:' || TG_OP, SQLERRM,
            jsonb_build_object('sqlstate', SQLSTATE, 'status', NEW.status,
                               'investment_amount', NEW.investment_amount));
  END;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_zz_landlord_pool_reserve ON public.investor_portfolios;
-- zz_: AFTER triggers fire alphabetically, so this runs after
-- trg_enforce_portfolio_funding_at_creation has posted any automatic debit.
CREATE TRIGGER trg_zz_landlord_pool_reserve
  AFTER INSERT OR UPDATE OF status ON public.investor_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.trg_landlord_pool_reserve_on_activation();

-- ── Grants: server-side only ──────────────────────────────────────────────
REVOKE ALL ON FUNCTION public._landlord_pool_post(uuid, text, numeric, text, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_pool_reserve(uuid, uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_pool_deploy(uuid, numeric, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_landlord_pool_reserve_on_activation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landlord_pool_post(uuid, text, numeric, text, uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_reserve(uuid, uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_deploy(uuid, numeric, text, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_cutover() TO authenticated, service_role;
