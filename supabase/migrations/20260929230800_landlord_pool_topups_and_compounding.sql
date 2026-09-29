-- Landlord Float Pool — top-ups and compounding (confirmed 2026-09-29).
--
-- Design: docs/LANDLORD_POOL_FUNDING_DESIGN.md §11
-- Needs:  20260929230000 … 20260929230700
--
-- Scope (confirmed): only portfolios that are pool_eligible — created after
-- cutover. Top-ups and compounding on older portfolios stay in treasury
-- exactly as today; the no-backfill rule stays absolute.
--
-- Each top-up and each compounding event becomes its OWN pool entry, reserved
-- under its OWN category, so how much came in from top-ups and how much from
-- compounding is read straight off the ledger and the subledger:
--
--   landlord_pool_topup_<origin>     cash_in   DR A21/A22   ┐ + landlord_pool_reserve_source
--   landlord_pool_compound_<origin>  cash_in   DR A21/A22   ┘   cash_out CR A1
--
--   landlord_pool_entries.entry_kind  principal | topup | compound
--
-- Once reserved, top-up and compound entries are deployed, repaid and
-- released by the same machinery as principal entries.
--
-- ── What the ledger looks like today, and the hooks ──────────────────────
--   top-up submitted   wallet partner_funding cash_out + platform
--                      pending_portfolio_topup cash_in (L6)       → no hook
--   top-up applied     platform pending_portfolio_topup cash_out (L6) +
--                      platform partner_funding cash_in (L2)      → HOOK: topup
--   top-up cancelled   platform pending_portfolio_topup cash_out +
--                      wallet partner_funding cash_in (refund)    → ignored
--   compounding        platform roi_expense cash_out + platform
--                      roi_reinvestment cash_in (L2)              → HOOK: compound
--   self-managed       wallet supporter_rent_fund + platform partner_funding
--   top-up (tenants)   (key psm-topup-<id>), then psm_disburse_landlord_float
--                      with p_topup_id                            → HOOK in psm
--
-- Top-ups are applied from at least five places (the ROI job, merge and
-- apply functions, approvals). The one reliable hook is the ledger group
-- itself, so a DEFERRED constraint trigger on general_ledger inspects the
-- complete group at the end of the transaction. Compounding is not new cash
-- — it is Returns kept instead of paid out — so reserving it earmarks the
-- same amount of treasury cash that would otherwise have left.
--
-- Non-blocking throughout: a failure is filed in landlord_pool_exceptions and
-- the top-up / compounding itself is never stopped.

-- ── 1. Mappings + allowlist ───────────────────────────────────────────────
INSERT INTO public.ledger_account_map (ledger_scope, wallet_bucket, category, account_code, debit_when, notes)
VALUES
  ('platform', NULL, 'landlord_pool_topup_self_support',       'A21', 'cash_in', 'Landlord Float Pool: a self-support top-up reserved into the pool (pairs with landlord_pool_reserve_source CR A1).'),
  ('platform', NULL, 'landlord_pool_topup_company_managed',    'A22', 'cash_in', 'Landlord Float Pool: a company-managed top-up reserved into the pool (pairs with landlord_pool_reserve_source CR A1).'),
  ('platform', NULL, 'landlord_pool_compound_self_support',    'A21', 'cash_in', 'Landlord Float Pool: compounded Returns on a self-support portfolio reserved into the pool (pairs with landlord_pool_reserve_source CR A1).'),
  ('platform', NULL, 'landlord_pool_compound_company_managed', 'A22', 'cash_in', 'Landlord Float Pool: compounded Returns on a company-managed portfolio reserved into the pool (pairs with landlord_pool_reserve_source CR A1).')
ON CONFLICT (ledger_scope, category, COALESCE(wallet_bucket, '*')) DO NOTHING;

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
    -- Landlord Float Pool (20260929230000, 20260929230200, 20260929230800)
    'landlord_pool_reserve_self_support',
    'landlord_pool_reserve_company_managed',
    'landlord_pool_reserve_source',
    'landlord_pool_topup_self_support',
    'landlord_pool_topup_company_managed',
    'landlord_pool_compound_self_support',
    'landlord_pool_compound_company_managed',
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

-- ── 2. Entries know what kind of money they hold ──────────────────────────
ALTER TABLE public.landlord_pool_entries
  ADD COLUMN IF NOT EXISTS entry_kind text NOT NULL DEFAULT 'principal'
    CHECK (entry_kind IN ('principal', 'topup', 'compound'));
ALTER TABLE public.landlord_pool_entries DROP CONSTRAINT IF EXISTS landlord_pool_entries_source_table_check;
ALTER TABLE public.landlord_pool_entries ADD CONSTRAINT landlord_pool_entries_source_table_check
  CHECK (source_table IN ('investor_portfolios', 'partner_self_funding_lines', 'partner_supported_houses', 'general_ledger'));

-- ── 3. Reserve one top-up / compounding event ─────────────────────────────
-- p_source_table/p_source_id identify the event uniquely:
--   general_ledger + the triggering leg id   (portfolio top-up, compounding)
--   partner_self_funding_lines + line id     (self-managed top-up tenant line)
CREATE OR REPLACE FUNCTION public.landlord_pool_reserve_increment(
  p_portfolio_id uuid,
  p_kind         text,
  p_amount       numeric,
  p_source_table text,
  p_source_id    uuid,
  p_caller       text DEFAULT 'unknown'
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p        public.investor_portfolios%ROWTYPE;
  v_src    text;
  v_origin text;
  v_group  uuid;
  v_entry  uuid;
BEGIN
  IF public.landlord_pool_cutover() IS NULL THEN RETURN jsonb_build_object('status', 'pool_off'); END IF;
  IF p_kind NOT IN ('topup', 'compound') THEN
    RAISE EXCEPTION 'LANDLORD_POOL_INVALID_INCREMENT' USING HINT = coalesce(p_kind, 'null');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN jsonb_build_object('status', 'no_op'); END IF;

  SELECT * INTO p FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_portfolio'); END IF;
  IF NOT p.pool_eligible THEN RETURN jsonb_build_object('status', 'pre_cutover'); END IF;
  IF p.status IN ('redeemed', 'cancelled', 'rejected') THEN
    RETURN jsonb_build_object('status', 'closed', 'portfolio_status', p.status);
  END IF;

  IF EXISTS (SELECT 1 FROM public.landlord_pool_entries
              WHERE source_table = p_source_table AND source_id = p_source_id) THEN
    RETURN jsonb_build_object('status', 'already_reserved');
  END IF;

  -- A tenant line is always self-support. Otherwise the portfolio's origin,
  -- or — if its principal was never reserved — what is attached to it.
  IF p_source_table = 'partner_self_funding_lines' THEN
    v_origin := 'self_support';
  ELSE
    SELECT fp.source INTO v_src FROM public.funder_pending_portfolios fp
     WHERE fp.portfolio_id = p.id ORDER BY fp.created_at DESC LIMIT 1;
    v_origin := coalesce(p.pool_origin,
                         CASE WHEN v_src IN ('self_managed', 'self_managed_house') THEN 'self_support'
                              ELSE 'company_managed' END);
  END IF;

  v_group := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'ledger_scope', 'platform', 'category', 'landlord_pool_' || p_kind || '_' || v_origin,
        'direction', 'cash_in', 'amount', p_amount, 'currency', 'UGX',
        'source_table', p_source_table, 'source_id', p_source_id, 'reference_id', p.portfolio_code,
        'linked_party', p.investor_id::text,
        'description', format('Landlord Float Pool %s (%s) — portfolio %s',
                              CASE p_kind WHEN 'topup' THEN 'top-up' ELSE 'compounded Returns' END,
                              replace(v_origin, '_', '-'), p.portfolio_code)),
      jsonb_build_object(
        'ledger_scope', 'platform', 'category', 'landlord_pool_reserve_source',
        'direction', 'cash_out', 'amount', p_amount, 'currency', 'UGX',
        'source_table', p_source_table, 'source_id', p_source_id, 'reference_id', p.portfolio_code,
        'linked_party', p.investor_id::text,
        'description', format('Treasury cash reserved into the Landlord Float Pool (%s) — portfolio %s',
                              CASE p_kind WHEN 'topup' THEN 'top-up' ELSE 'compounded Returns' END, p.portfolio_code))),
    idempotency_key := 'lp-' || p_kind || '-' || p_source_table || '-' || p_source_id::text);

  INSERT INTO public.landlord_pool_entries
    (portfolio_id, partner_id, origin, source_table, source_id, principal, reserve_group_id, entry_kind)
  VALUES (p.id, p.investor_id, v_origin, p_source_table, p_source_id, p_amount, v_group, p_kind)
  ON CONFLICT (source_table, source_id) DO NOTHING
  RETURNING id INTO v_entry;

  IF v_entry IS NOT NULL THEN
    INSERT INTO public.landlord_pool_movements (pool_entry_id, kind, amount, ledger_group_id, created_by)
    VALUES (v_entry, 'reserve', p_amount, v_group, auth.uid())
    ON CONFLICT (pool_entry_id, ledger_group_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('status', 'reserved', 'kind', p_kind, 'origin', v_origin,
                            'amount', p_amount, 'entry_id', v_entry, 'caller', p_caller);
END;
$function$;

-- ── 4. Deferred hook on the ledger ───────────────────────────────────────
-- Fires at the END of the transaction, when the whole group exists, so it can
-- tell an applied top-up (L6 → L2) from a cancelled one (L6 → wallet).
CREATE OR REPLACE FUNCTION public.trg_landlord_pool_increment_on_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pid  uuid;
  v_kind text;
BEGIN
  IF public.landlord_pool_cutover() IS NULL THEN RETURN NULL; END IF;
  IF NEW.source_table IS DISTINCT FROM 'investor_portfolios' OR NEW.source_id IS NULL THEN RETURN NULL; END IF;

  IF NEW.category = 'roi_reinvestment' AND NEW.direction = 'cash_in' THEN
    v_kind := 'compound';
  ELSIF NEW.category = 'pending_portfolio_topup' AND NEW.direction = 'cash_out'
        AND NEW.transaction_group_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.general_ledger g
                     WHERE g.transaction_group_id = NEW.transaction_group_id
                       AND g.ledger_scope = 'platform' AND g.category = 'partner_funding'
                       AND g.direction = 'cash_in') THEN
    v_kind := 'topup';
  ELSE
    RETURN NULL;
  END IF;

  v_pid := NEW.source_id::uuid;
  -- Cheap exit for the (overwhelmingly common) pre-cutover portfolio.
  IF NOT EXISTS (SELECT 1 FROM public.investor_portfolios WHERE id = v_pid AND pool_eligible) THEN
    RETURN NULL;
  END IF;

  BEGIN
    PERFORM public.landlord_pool_reserve_increment(v_pid, v_kind, NEW.amount, 'general_ledger', NEW.id,
                                                   'ledger:' || NEW.category);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
    VALUES (v_pid, 'reserve', 'ledger:' || NEW.category, SQLERRM,
            jsonb_build_object('sqlstate', SQLSTATE, 'kind', v_kind, 'ledger_leg_id', NEW.id,
                               'transaction_group_id', NEW.transaction_group_id, 'amount', NEW.amount));
  END;
  RETURN NULL;
END;
$function$;

-- Trigger creation is applied separately in production with a short
-- lock_timeout (general_ledger is the busiest table).
DROP TRIGGER IF EXISTS trg_zz_landlord_pool_increment ON public.general_ledger;
CREATE CONSTRAINT TRIGGER trg_zz_landlord_pool_increment
  AFTER INSERT ON public.general_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.ledger_scope = 'platform' AND NEW.category IN ('roi_reinvestment', 'pending_portfolio_topup'))
  EXECUTE FUNCTION public.trg_landlord_pool_increment_on_ledger();

-- ── 5. Rebalance: self-managed top-ups raise the commitment, not the ───────
--       portfolio row, so remaining principal takes the larger of the two.
CREATE OR REPLACE FUNCTION public.landlord_pool_rebalance(
  p_portfolio_id uuid,
  p_caller       text DEFAULT 'unknown'
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  p          public.investor_portfolios%ROWTYPE;
  v_commit   numeric := 0;
  v_remain   numeric;
  v_in       numeric;
  v_out      numeric;
  v_excess   numeric;
  v_take     numeric;
  v_ref      text := gen_random_uuid()::text;
  v_released jsonb := '[]'::jsonb;
  r          record;
BEGIN
  IF public.landlord_pool_cutover() IS NULL THEN RETURN jsonb_build_object('status', 'pool_off'); END IF;

  SELECT * INTO p FROM public.investor_portfolios WHERE id = p_portfolio_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_portfolio'); END IF;

  SELECT coalesce(sum(in_pool), 0), coalesce(sum(out_with_tenants), 0)
    INTO v_in, v_out
    FROM public.landlord_pool_entries WHERE portfolio_id = p.id;
  IF v_in <= 0 THEN RETURN jsonb_build_object('status', 'nothing_in_pool'); END IF;

  SELECT coalesce(max(c.committed_amount), 0) INTO v_commit
    FROM public.funder_pending_portfolios fp
    JOIN public.partner_self_commitments c ON c.id = fp.commitment_id
   WHERE fp.portfolio_id = p.id AND c.status <> 'cancelled';

  v_remain := CASE WHEN p.status IN ('redeemed', 'cancelled', 'rejected') THEN 0
                   ELSE greatest(coalesce(p.investment_amount, 0), v_commit, 0) END;
  v_excess := v_in - greatest(v_remain - v_out, 0);
  IF v_excess <= 0.5 THEN
    RETURN jsonb_build_object('status', 'balanced', 'in_pool', v_in, 'out', v_out, 'remaining', v_remain);
  END IF;

  FOR r IN
    SELECT id, in_pool FROM public.landlord_pool_entries
     WHERE portfolio_id = p.id AND in_pool > 0
     ORDER BY created_at DESC, id DESC
     FOR UPDATE
  LOOP
    EXIT WHEN v_excess <= 0.5;
    v_take := least(v_excess, r.in_pool);
    PERFORM public._landlord_pool_post(r.id, 'release', v_take, v_ref, NULL, NULL, NULL,
      format('Landlord Float Pool release — portfolio %s (%s, status %s)', p.portfolio_code, p_caller, p.status));
    v_excess := v_excess - v_take;
    v_released := v_released || jsonb_build_object('entry_id', r.id, 'amount', v_take);
  END LOOP;

  RETURN jsonb_build_object('status', 'released', 'released', v_released,
                            'remaining', v_remain, 'caller', p_caller);
END;
$function$;

-- ── 6. Reporting: principal vs top-ups vs compounding, per portfolio ─────
CREATE OR REPLACE VIEW public.v_landlord_pool_position
WITH (security_invoker = true) AS
SELECT e.portfolio_id,
       ip.portfolio_code,
       e.partner_id,
       e.origin,
       CASE WHEN e.source_table = 'partner_supported_houses' THEN 'house'
            WHEN e.source_table = 'partner_self_funding_lines' THEN 'tenant'
            ELSE 'portfolio' END                                        AS attached_to,
       e.entry_kind,
       count(*)                                                          AS entries,
       sum(e.principal)                                                  AS reserved,
       sum(e.deployed)                                                   AS deployed,
       sum(e.returned)                                                   AS returned,
       sum(e.released)                                                   AS released,
       sum(e.in_pool)                                                    AS in_pool,
       sum(e.out_with_tenants)                                           AS out_with_tenants,
       min(e.created_at)                                                 AS first_reserved_at,
       max(e.created_at)                                                 AS last_reserved_at
  FROM public.landlord_pool_entries e
  JOIN public.investor_portfolios ip ON ip.id = e.portfolio_id
 GROUP BY e.portfolio_id, ip.portfolio_code, e.partner_id, e.origin, 5, e.entry_kind;

REVOKE ALL ON public.v_landlord_pool_position FROM PUBLIC, anon;
GRANT SELECT ON public.v_landlord_pool_position TO authenticated;

REVOKE ALL ON FUNCTION public.landlord_pool_reserve_increment(uuid, text, numeric, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_landlord_pool_increment_on_ledger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_pool_rebalance(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_pool_reserve_increment(uuid, text, numeric, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_rebalance(uuid, text) TO service_role;
