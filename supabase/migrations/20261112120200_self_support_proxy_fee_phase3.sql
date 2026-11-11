-- Self-support agent facilitation fee, Phase 3: the proxy payback reserve (owner design 2026-11-10).
--
-- At approval (Phase 2) the proxy agent is paid the fee out of the partner's money and Welile books it
-- as Agent Commission Expense, while the partner's principal stays rent + fee. So at maturity Welile
-- pays the partner the fee back from its own cash. The owner's rule: the agent commission budget that
-- is no longer paid out (agents earn 8% of a 10% budget) pays it back.
--
-- The expense is already in the books, so the reserve does NOT post to the ledger again (that would
-- count the cost twice). It is an earmark kept in self_support_fee_reserve_movements:
--   funded  after each collection, _release_unpaid_commission_budget earmarks part of the freed budget,
--           up to what is still owed back (paid fees on portfolios not yet matured, minus what is
--           already earmarked). The rest goes to Platform Fee exactly as today; the ledger posting is
--           unchanged.
--   used    when a self-support commitment matures, its paid fees leave the earmark (the partner's
--           principal, fee included, is now due back).
-- balance = funded - used; owed = paid fees on commitments not matured; shortfall = owed - balance.
-- get_self_support_fee_reserve() shows the figures to finance staff.
-- The earmark never blocks a collection: a failure is logged and the collection posts as before.

CREATE TABLE IF NOT EXISTS public.self_support_fee_reserve_movements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('funded', 'used')),
  amount           numeric NOT NULL CHECK (amount > 0),
  commitment_id    uuid,
  source_table     text,
  source_id        text,
  ledger_group_id  uuid,
  idempotency_key  text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.self_support_fee_reserve_movements IS
  'Earmark of the freed agent commission budget that pays back self-support agent facilitation fees at maturity (owner design 2026-11-10). Memo only: the fee was expensed at approval, so nothing here posts to the ledger.';
CREATE INDEX IF NOT EXISTS self_support_fee_reserve_movements_commitment_idx
  ON public.self_support_fee_reserve_movements (commitment_id) WHERE commitment_id IS NOT NULL;

ALTER TABLE public.self_support_fee_reserve_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.self_support_fee_reserve_movements FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.self_support_fee_reserve_movements TO service_role;
DROP POLICY IF EXISTS mfa_required_for_staff ON public.self_support_fee_reserve_movements;
CREATE POLICY mfa_required_for_staff ON public.self_support_fee_reserve_movements AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

-- What is still owed back: paid fees on commitments that have not matured.
CREATE OR REPLACE FUNCTION public.self_support_fee_reserve_position()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH fees AS (
    SELECT l.commitment_id, l.proxy_fee FROM public.partner_self_funding_lines l WHERE l.proxy_fee_status = 'paid'
    UNION ALL
    SELECT s.commitment_id, s.proxy_fee FROM public.partner_supported_houses s WHERE s.proxy_fee_status = 'paid'
  ), owed AS (
    SELECT COALESCE(SUM(f.proxy_fee), 0) AS amt
      FROM fees f JOIN public.partner_self_commitments c ON c.id = f.commitment_id
     WHERE c.status IS DISTINCT FROM 'matured'
  ), mv AS (
    SELECT COALESCE(SUM(amount) FILTER (WHERE kind = 'funded'), 0) AS funded,
           COALESCE(SUM(amount) FILTER (WHERE kind = 'used'), 0)   AS used
      FROM public.self_support_fee_reserve_movements
  )
  SELECT jsonb_build_object(
    'owed', owed.amt,
    'funded', mv.funded,
    'used', mv.used,
    'balance', mv.funded - mv.used,
    'shortfall', GREATEST(owed.amt - (mv.funded - mv.used), 0),
    'fees_paid_total', (SELECT COALESCE(SUM(proxy_fee), 0) FROM fees))
  FROM owed, mv;
$function$;
REVOKE ALL ON FUNCTION public.self_support_fee_reserve_position() FROM PUBLIC, anon, authenticated;

-- Earmark part of a freed commission budget. Returns the amount earmarked (0 when nothing is owed).
CREATE OR REPLACE FUNCTION public.self_support_fee_reserve_fund(
  p_available numeric, p_ledger_group_id uuid, p_source_table text, p_source_id text, p_idempotency_key text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_short numeric;
  v_take  numeric;
BEGIN
  IF COALESCE(p_available, 0) <= 0 OR p_idempotency_key IS NULL THEN RETURN 0; END IF;
  -- Cheap exit while no fee has ever been paid (policy off).
  IF NOT EXISTS (SELECT 1 FROM public.partner_self_funding_lines WHERE proxy_fee_status = 'paid')
     AND NOT EXISTS (SELECT 1 FROM public.partner_supported_houses WHERE proxy_fee_status = 'paid') THEN
    RETURN 0;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('self_support_fee_reserve'));
  v_short := (public.self_support_fee_reserve_position() ->> 'shortfall')::numeric;
  v_take := round(LEAST(p_available, COALESCE(v_short, 0)), 2);
  IF v_take <= 0 THEN RETURN 0; END IF;

  INSERT INTO public.self_support_fee_reserve_movements
    (kind, amount, source_table, source_id, ledger_group_id, idempotency_key)
  VALUES ('funded', v_take, p_source_table, p_source_id, p_ledger_group_id, 'ssfee-reserve:' || p_idempotency_key)
  ON CONFLICT (idempotency_key) DO NOTHING;
  IF NOT FOUND THEN RETURN 0; END IF;
  RETURN v_take;
END $function$;
REVOKE ALL ON FUNCTION public.self_support_fee_reserve_fund(numeric, uuid, text, text, text) FROM PUBLIC, anon, authenticated;

-- A matured commitment's paid fees are now due back with its principal: they leave the earmark.
CREATE OR REPLACE FUNCTION public.trg_self_support_fee_reserve_on_maturity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_fee numeric;
BEGIN
  IF NEW.status = 'matured' AND OLD.status IS DISTINCT FROM 'matured' THEN
    SELECT COALESCE(SUM(x.fee), 0) INTO v_fee FROM (
      SELECT proxy_fee AS fee FROM public.partner_self_funding_lines WHERE commitment_id = NEW.id AND proxy_fee_status = 'paid'
      UNION ALL
      SELECT proxy_fee FROM public.partner_supported_houses WHERE commitment_id = NEW.id AND proxy_fee_status = 'paid'
    ) x;
    IF v_fee > 0 THEN
      INSERT INTO public.self_support_fee_reserve_movements (kind, amount, commitment_id, source_table, source_id, idempotency_key)
      VALUES ('used', v_fee, NEW.id, 'partner_self_commitments', NEW.id::text, 'ssfee-used:' || NEW.id::text)
      ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'self-support fee reserve on maturity failed for %: %', NEW.id, SQLERRM;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.trg_self_support_fee_reserve_on_maturity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_self_support_fee_reserve_on_maturity ON public.partner_self_commitments;
CREATE TRIGGER trg_self_support_fee_reserve_on_maturity
  AFTER UPDATE OF status ON public.partner_self_commitments
  FOR EACH ROW EXECUTE FUNCTION public.trg_self_support_fee_reserve_on_maturity();

-- Finance view of the earmark.
CREATE OR REPLACE FUNCTION public.get_self_support_fee_reserve()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'cfo'::app_role) OR public.has_role(v_uid, 'ceo'::app_role)
    OR public.has_role(v_uid, 'coo'::app_role) OR public.has_role(v_uid, 'cto'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role) OR public.has_role(v_uid, 'financial_ops'::app_role)
    OR public.has_role(v_uid, 'partner_ops'::app_role)) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
  RETURN public.self_support_fee_reserve_position()
    || jsonb_build_object('policy', public.get_self_support_fee_policy());
END $function$;
REVOKE ALL ON FUNCTION public.get_self_support_fee_reserve() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_self_support_fee_reserve() TO authenticated;

-- After each collection, earmark part of the freed budget (posting unchanged).
CREATE OR REPLACE FUNCTION public._release_unpaid_commission_budget(p_budget numeric, p_paid numeric, p_offset_category text, p_source_table text, p_source_id text, p_reference_id text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_unpaid numeric := round(COALESCE(p_budget, 0) - COALESCE(p_paid, 0), 2);
  v_grp    uuid;
  v_desc   text;
  v_earmark numeric := 0;
BEGIN
  IF p_offset_category NOT IN ('agent_commission_payable', 'agent_commission_settled', 'marketing_expense') THEN
    RAISE EXCEPTION 'unsupported commission offset category %', p_offset_category;
  END IF;
  IF p_idempotency_key IS NULL OR p_source_table IS NULL THEN
    RAISE EXCEPTION 'idempotency key and source table are required';
  END IF;
  -- Nothing to release when the split booked no budget or the agent was paid all of it
  -- (a shortfall stays where it is today: in the commission cost).
  IF p_budget IS NULL OR v_unpaid <= 0 THEN
    RETURN jsonb_build_object('status', 'nothing_to_release', 'budget', p_budget, 'paid', p_paid);
  END IF;

  v_desc := format('Commission budget not paid out (agents earn 8%% of each collection): UGX %s released to Platform Fee',
                   to_char(v_unpaid, 'FM999,999,999,990.00'));

  v_grp := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'direction', 'cash_out', 'amount', v_unpaid, 'category', p_offset_category,
        'ledger_scope', 'platform', 'classification', 'production', 'currency', 'UGX',
        'source_table', p_source_table, 'source_id', p_source_id, 'reference_id', p_reference_id,
        'description', v_desc),
      jsonb_build_object(
        'direction', 'cash_in', 'amount', v_unpaid, 'category', 'platform_fee_collected',
        'ledger_scope', 'platform', 'classification', 'production', 'currency', 'UGX',
        'source_table', p_source_table, 'source_id', p_source_id, 'reference_id', p_reference_id,
        'description', v_desc)),
    idempotency_key := p_idempotency_key);

  -- Self-support fee payback earmark (memo only, the posting above is unchanged). Never blocks.
  BEGIN
    v_earmark := public.self_support_fee_reserve_fund(v_unpaid, v_grp, p_source_table, p_source_id, p_idempotency_key);
  EXCEPTION WHEN OTHERS THEN
    v_earmark := 0;
    RAISE WARNING 'self-support fee reserve earmark failed for %: %', p_idempotency_key, SQLERRM;
  END;

  RETURN jsonb_build_object('status', 'released', 'amount', v_unpaid,
    'budget', p_budget, 'paid', p_paid, 'transaction_group_id', v_grp,
    'fee_reserve_earmarked', v_earmark);
END $function$;
