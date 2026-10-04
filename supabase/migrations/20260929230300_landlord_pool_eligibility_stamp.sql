-- Landlord Float Pool — "created from today" is stamped at insert, not read
-- from created_at.
--
-- MEASURED 2026-09-29, while dry-running the pool: 4 ACTIVE portfolios worth
-- UGX 5,955,348 carry created_at between 2026-10-09 and 2026-12-26 — in the
-- future. created_at is also editable as the "contribution date"
-- (log_portfolio_change tracks portfolio_contribution_date_edited). A cutover
-- test of `created_at >= cutover` would therefore treat those old portfolios
-- as new and reserve their money into the pool: a backfill by accident, which
-- the business ruled out.
--
-- `pool_eligible` is set ONCE, by a BEFORE INSERT trigger, to "the pool was on
-- when this row was inserted". It can never change afterwards. Every row that
-- exists today is false for ever. A portfolio inserted before cutover and
-- approved after it stays false — creation decides, as agreed.

ALTER TABLE public.investor_portfolios
  ADD COLUMN IF NOT EXISTS pool_eligible boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.trg_landlord_pool_stamp_eligibility()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.pool_eligible := (public.landlord_pool_cutover() IS NOT NULL)
                         AND NEW.locked_from_portfolio_id IS NULL;
  ELSE
    NEW.pool_eligible := OLD.pool_eligible;   -- immutable
  END IF;
  RETURN NEW;
END;
$function$;

-- Trigger creation is applied separately in production with a short
-- lock_timeout (Realtime holds investor_portfolios; see 20260929230200).
DROP TRIGGER IF EXISTS trg_aa_landlord_pool_eligibility ON public.investor_portfolios;
CREATE TRIGGER trg_aa_landlord_pool_eligibility
  BEFORE INSERT OR UPDATE OF pool_eligible ON public.investor_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.trg_landlord_pool_stamp_eligibility();

-- Reserve now gates on the stamp instead of created_at.
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

REVOKE ALL ON FUNCTION public.landlord_pool_reserve(uuid, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_pool_reserve(uuid, uuid[], text) TO service_role;

-- Detection view keys on the stamp too.
CREATE OR REPLACE VIEW public.v_landlord_pool_unreserved
WITH (security_invoker = true) AS
SELECT ip.id AS portfolio_id, ip.portfolio_code, ip.investor_id, ip.investment_amount,
       ip.status, ip.created_at
  FROM public.investor_portfolios ip
 WHERE ip.pool_eligible
   AND ip.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM public.landlord_pool_entries e WHERE e.portfolio_id = ip.id);
