-- Landlord Float Pool — returned principal is recorded; cancellations and
-- re-fundings go back through the pool.
--
-- Design: docs/LANDLORD_POOL_FUNDING_DESIGN.md §12
-- Needs:  20260929230000 … 20260929230900
--
-- ── 1. Returned principal (decided 2026-09-30: keep it) ──────────────────
-- drizzle 0352 (Lovable, 2026-09-29 17:12) made _post_four_part_fee_split move
-- the Principal part of EVERY tenant collection from Cash in Transit (A5) into
-- the pool (landlord_pool_return_<origin>), for old and new plans alike, and
-- whether or not the pool is switched on. The business confirmed that is
-- right: recovered principal belongs in the Landlord Float Pool.
--
-- MEASURED 2026-09-30: 78 collections, UGX 1,297,031 in A22, and NO pool
-- entries behind it — so the subledger no longer tied to the account, and
-- the money could never be deployed (deploys draw from entries).
--
-- Now every such leg is recorded in a running "returned principal" entry per
-- origin (entry_kind 'returned', no portfolio, source_table
-- 'returned_principal'). Deploys draw from it like any other entry, so
-- recovered rent funds the next tenant. The 78 existing legs are recorded
-- too — RECORDS ONLY, no ledger posting, the money is already in A22.
-- Legs posted by the pool's own functions (idempotency key 'lp-…') are
-- already recorded on their own entries and are skipped.
--
-- ── 2. A cancelled pool-funded plan returns its money to the pool ────────
-- cancel_tenant_and_return_landlord_float reverses rent_disbursement, which
-- puts the float back in free treasury (A1). The pool still showed it as out
-- with the tenant, for ever. Now, for whatever the cancellation actually
-- reversed, the pool entries that funded the plan get it back:
--   landlord_pool_return_<origin>  cash_in   DR A21/A22
--   landlord_pool_reserve_source   cash_out  CR A1
--
-- ── 3. A re-funded plan draws from the pool again ───────────────────────
-- landlord_pool_deploy refused any rent request that had EVER been deployed,
-- and keyed its ledger groups per rent request, so a plan cancelled and
-- funded again (the same shape as the Timothy recall) could never draw
-- again. It now checks what is still OUT for the plan, and keys each draw on
-- the allocation.

-- ── Schema ────────────────────────────────────────────────────────────────
ALTER TABLE public.landlord_pool_entries ALTER COLUMN portfolio_id DROP NOT NULL;
ALTER TABLE public.landlord_pool_entries ALTER COLUMN partner_id DROP NOT NULL;
ALTER TABLE public.landlord_pool_entries DROP CONSTRAINT IF EXISTS landlord_pool_entries_entry_kind_check;
ALTER TABLE public.landlord_pool_entries ADD CONSTRAINT landlord_pool_entries_entry_kind_check
  CHECK (entry_kind IN ('principal', 'topup', 'compound', 'returned'));
ALTER TABLE public.landlord_pool_entries DROP CONSTRAINT IF EXISTS landlord_pool_entries_source_table_check;
ALTER TABLE public.landlord_pool_entries ADD CONSTRAINT landlord_pool_entries_source_table_check
  CHECK (source_table IN ('investor_portfolios', 'partner_self_funding_lines', 'partner_supported_houses',
                          'general_ledger', 'returned_principal'));
ALTER TABLE public.landlord_pool_entries DROP CONSTRAINT IF EXISTS landlord_pool_entries_principal_check;
ALTER TABLE public.landlord_pool_entries ADD CONSTRAINT landlord_pool_entries_principal_check
  CHECK (principal >= 0);
ALTER TABLE public.landlord_pool_entries ADD CONSTRAINT landlord_pool_entries_portfolio_unless_returned
  CHECK (entry_kind = 'returned' OR (portfolio_id IS NOT NULL AND partner_id IS NOT NULL));

ALTER TABLE public.landlord_pool_movements DROP CONSTRAINT IF EXISTS landlord_pool_movements_kind_check;
ALTER TABLE public.landlord_pool_movements ADD CONSTRAINT landlord_pool_movements_kind_check
  CHECK (kind IN ('reserve', 'deploy', 'return', 'release', 'reversal', 'recovered', 'recovered_reversal'));

-- ── _landlord_pool_post: add the cancellation return ─────────────────────
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
  e            public.landlord_pool_entries%ROWTYPE;
  v_pool_dir   text;
  v_other      text;
  v_other_dir  text;
  v_cat_kind   text;
  v_store_kind text;
  v_group      uuid;
  v_ins        integer;
  v_desc       text;
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
      v_pool_dir := 'cash_out'; v_other := 'landlord_pool_deploy_target';  v_other_dir := 'cash_in';
      v_cat_kind := 'deploy';   v_store_kind := 'deploy';
    WHEN 'return' THEN
      v_pool_dir := 'cash_in';  v_other := 'landlord_pool_return_source';  v_other_dir := 'cash_out';
      v_cat_kind := 'return';   v_store_kind := 'return';
    WHEN 'cancel_return' THEN
      -- The cancellation already put the float back in free treasury (A1).
      v_pool_dir := 'cash_in';  v_other := 'landlord_pool_reserve_source'; v_other_dir := 'cash_out';
      v_cat_kind := 'return';   v_store_kind := 'return';
    WHEN 'return_reversal' THEN
      v_pool_dir := 'cash_out'; v_other := 'landlord_pool_return_source';  v_other_dir := 'cash_in';
      v_cat_kind := 'return';   v_store_kind := 'reversal';
    WHEN 'release' THEN
      v_pool_dir := 'cash_out'; v_other := 'landlord_pool_release_target'; v_other_dir := 'cash_in';
      v_cat_kind := 'release';  v_store_kind := 'release';
    ELSE
      RAISE EXCEPTION 'LANDLORD_POOL_INVALID_KIND' USING HINT = coalesce(p_kind, 'null');
  END CASE;

  SELECT m.ledger_group_id INTO v_group
    FROM public.landlord_pool_movements m
   WHERE m.pool_entry_id = e.id AND m.kind = v_store_kind
     AND EXISTS (SELECT 1 FROM public.general_ledger gl
                  WHERE gl.transaction_group_id = m.ledger_group_id
                    AND gl.idempotency_key = 'lp-' || p_kind || '-' || e.id::text || '-' || p_ref)
   LIMIT 1;
  IF v_group IS NOT NULL THEN RETURN v_group; END IF;

  IF p_kind IN ('deploy','release') AND p_amount > e.in_pool + 0.005 THEN
    RAISE EXCEPTION 'LANDLORD_POOL_INSUFFICIENT' USING HINT = format('entry %s holds %s, asked %s', e.id, e.in_pool, p_amount);
  END IF;
  IF p_kind IN ('return','cancel_return') AND p_amount > e.out_with_tenants + 0.005 THEN
    RAISE EXCEPTION 'LANDLORD_POOL_RETURN_EXCEEDS_DEPLOYED' USING HINT = format('entry %s has %s out, asked %s', e.id, e.out_with_tenants, p_amount);
  END IF;
  IF p_kind = 'return_reversal' AND (p_amount > e.returned + 0.005 OR p_amount > e.in_pool + 0.005) THEN
    RAISE EXCEPTION 'LANDLORD_POOL_REVERSAL_EXCEEDS_RETURNED' USING HINT = format('entry %s returned %s, in pool %s, asked %s', e.id, e.returned, e.in_pool, p_amount);
  END IF;

  v_desc := coalesce(p_description,
    format('Landlord Float Pool %s (%s) — %s', replace(p_kind, '_', ' '), replace(e.origin, '_', '-'), p_ref));

  v_group := public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object(
        'ledger_scope', 'platform', 'category', 'landlord_pool_' || v_cat_kind || '_' || e.origin,
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
  VALUES (e.id, v_store_kind, p_amount, p_rent_request_id, p_allocation_id, p_collection_id, v_group, auth.uid())
  ON CONFLICT (pool_entry_id, ledger_group_id) DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;

  IF v_ins = 1 THEN
    UPDATE public.landlord_pool_entries
       SET deployed = deployed + CASE WHEN p_kind = 'deploy'  THEN p_amount ELSE 0 END,
           returned = returned + CASE WHEN p_kind IN ('return','cancel_return') THEN p_amount
                                      WHEN p_kind = 'return_reversal' THEN -p_amount ELSE 0 END,
           released = released + CASE WHEN p_kind = 'release' THEN p_amount ELSE 0 END,
           status   = CASE WHEN p_kind = 'return_reversal' THEN 'open' ELSE status END,
           updated_at = now()
     WHERE id = e.id;
    UPDATE public.landlord_pool_entries
       SET status = 'closed'
     WHERE id = e.id AND in_pool = 0 AND out_with_tenants = 0 AND status = 'open'
       AND entry_kind <> 'returned';
  END IF;

  RETURN v_group;
END;
$function$;

-- ── landlord_pool_deploy: re-fundings draw again ─────────────────────────
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
  v_ref    text := coalesce(p_allocation_id::text, p_rent_request_id::text);
  v_still_out numeric;
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

  -- Idempotent retry of THIS funding (same allocation) → report what exists.
  IF p_allocation_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.landlord_pool_movements m
        WHERE m.allocation_id = p_allocation_id AND m.kind = 'deploy') THEN
    RETURN jsonb_build_object('status', 'already_deployed',
      'drawn', (SELECT sum(amount) FROM public.landlord_pool_movements
                 WHERE allocation_id = p_allocation_id AND kind = 'deploy'));
  END IF;

  -- The plan still has pool money out with the tenant → do not draw twice.
  SELECT coalesce(sum(CASE m.kind WHEN 'deploy' THEN m.amount WHEN 'return' THEN -m.amount
                                  WHEN 'reversal' THEN m.amount ELSE 0 END), 0)
    INTO v_still_out
    FROM public.landlord_pool_movements m WHERE m.rent_request_id = p_rent_request_id;
  IF v_still_out > 0.5 THEN
    RETURN jsonb_build_object('status', 'already_deployed', 'still_out', v_still_out);
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
    PERFORM public._landlord_pool_post(r.id, 'deploy', v_take, v_ref,
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

-- ── A cancelled plan gives its pool money back ───────────────────────────
CREATE OR REPLACE FUNCTION public.landlord_pool_cancel_return(
  p_rent_request_id uuid,
  p_amount          numeric,
  p_caller          text DEFAULT 'unknown'
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_left numeric := coalesce(p_amount, 0);
  v_take numeric;
  v_ref  text := 'cancel-' || p_rent_request_id::text || '-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
  v_out  jsonb := '[]'::jsonb;
  v_pids uuid[] := ARRAY[]::uuid[];
  v_pid  uuid;
  r      record;
BEGIN
  IF p_rent_request_id IS NULL OR v_left <= 0 THEN RETURN jsonb_build_object('status', 'no_op'); END IF;

  FOR r IN
    SELECT m.pool_entry_id AS entry_id, e.portfolio_id,
           sum(CASE m.kind WHEN 'deploy' THEN m.amount WHEN 'return' THEN -m.amount
                           WHEN 'reversal' THEN m.amount ELSE 0 END) AS outstanding,
           min(m.created_at) FILTER (WHERE m.kind = 'deploy') AS first_draw
      FROM public.landlord_pool_movements m
      JOIN public.landlord_pool_entries e ON e.id = m.pool_entry_id
     WHERE m.rent_request_id = p_rent_request_id
     GROUP BY m.pool_entry_id, e.portfolio_id
    HAVING bool_or(m.kind = 'deploy')
     ORDER BY first_draw, m.pool_entry_id
  LOOP
    EXIT WHEN v_left <= 0;
    CONTINUE WHEN coalesce(r.outstanding, 0) <= 0;
    v_take := least(v_left, r.outstanding);
    PERFORM public._landlord_pool_post(r.entry_id, 'cancel_return', v_take, v_ref, p_rent_request_id, NULL, NULL,
      format('Landlord Float Pool — cancelled Rent Plan, float returned to the pool (%s)', p_caller));
    v_left := v_left - v_take;
    v_out := v_out || jsonb_build_object('entry_id', r.entry_id, 'amount', v_take);
    IF r.portfolio_id IS NOT NULL THEN v_pids := v_pids || r.portfolio_id; END IF;
  END LOOP;

  -- A closed portfolio's money goes straight on to free treasury.
  FOREACH v_pid IN ARRAY v_pids LOOP
    PERFORM public.landlord_pool_rebalance(v_pid, 'after_cancellation');
  END LOOP;

  RETURN jsonb_build_object('status', CASE WHEN jsonb_array_length(v_out) = 0 THEN 'not_pool_funded' ELSE 'returned' END,
                            'returned', coalesce(p_amount, 0) - v_left, 'returns', v_out);
END;
$function$;

-- ── Record returned principal posted by the repayment split ──────────────
CREATE OR REPLACE FUNCTION public.landlord_pool_record_returned_principal(
  p_leg_id uuid
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  g        public.general_ledger%ROWTYPE;
  v_origin text;
  v_entry  uuid;
  v_ins    integer;
BEGIN
  SELECT * INTO g FROM public.general_ledger WHERE id = p_leg_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'no_leg'); END IF;
  IF g.ledger_scope <> 'platform'
     OR g.category NOT IN ('landlord_pool_return_company_managed', 'landlord_pool_return_self_support')
     OR coalesce(g.idempotency_key, '') LIKE 'lp-%' THEN
    RETURN jsonb_build_object('status', 'not_returned_principal');
  END IF;

  v_origin := CASE g.category WHEN 'landlord_pool_return_self_support' THEN 'self_support' ELSE 'company_managed' END;

  -- One running entry per origin.
  INSERT INTO public.landlord_pool_entries
    (portfolio_id, partner_id, origin, source_table, source_id, principal, reserve_group_id, entry_kind)
  VALUES (NULL, NULL, v_origin, 'returned_principal',
          md5('returned_principal:' || v_origin)::uuid, 0, g.transaction_group_id, 'returned')
  ON CONFLICT (source_table, source_id) DO NOTHING;
  SELECT id INTO v_entry FROM public.landlord_pool_entries
   WHERE source_table = 'returned_principal' AND source_id = md5('returned_principal:' || v_origin)::uuid
   FOR UPDATE;

  INSERT INTO public.landlord_pool_movements (pool_entry_id, kind, amount, collection_id, ledger_group_id, created_by)
  VALUES (v_entry, CASE WHEN g.direction = 'cash_in' THEN 'recovered' ELSE 'recovered_reversal' END,
          g.amount, CASE WHEN g.source_table = 'agent_collections' THEN g.source_id::uuid END,
          g.transaction_group_id, auth.uid())
  ON CONFLICT (pool_entry_id, ledger_group_id) DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;

  IF v_ins = 1 THEN
    UPDATE public.landlord_pool_entries
       SET principal  = greatest(principal + CASE WHEN g.direction = 'cash_in' THEN g.amount ELSE -g.amount END, 0),
           status     = 'open',
           updated_at = now()
     WHERE id = v_entry;
  END IF;

  RETURN jsonb_build_object('status', CASE WHEN v_ins = 1 THEN 'recorded' ELSE 'already_recorded' END,
                            'origin', v_origin, 'amount', g.amount);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_landlord_pool_returned_principal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF coalesce(NEW.idempotency_key, '') LIKE 'lp-%' THEN RETURN NULL; END IF;
  BEGIN
    PERFORM public.landlord_pool_record_returned_principal(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
    VALUES (NULL, 'return', 'returned_principal', SQLERRM,
            jsonb_build_object('sqlstate', SQLSTATE, 'ledger_leg_id', NEW.id, 'amount', NEW.amount,
                               'transaction_group_id', NEW.transaction_group_id));
  END;
  RETURN NULL;
END;
$function$;

-- Trigger creation is applied separately in production with a short
-- lock_timeout (general_ledger is the busiest table).
DROP TRIGGER IF EXISTS trg_zz_landlord_pool_returned_principal ON public.general_ledger;
CREATE TRIGGER trg_zz_landlord_pool_returned_principal
  AFTER INSERT ON public.general_ledger
  FOR EACH ROW
  WHEN (NEW.ledger_scope = 'platform'
        AND NEW.category IN ('landlord_pool_return_company_managed', 'landlord_pool_return_self_support'))
  EXECUTE FUNCTION public.trg_landlord_pool_returned_principal();

-- ── cancel_tenant_and_return_landlord_float: hand the pool its money back ─
DO $mig$
DECLARE
  v_def text; v_old text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.cancel_tenant_and_return_landlord_float'::regproc);
  FOR v_old, v_new IN
    SELECT o, n FROM (VALUES
      ($o$  v_booked_left numeric := 0;
BEGIN$o$,
       $n$  v_booked_left numeric := 0;
  v_booked_reversed numeric := 0;  -- Landlord Float Pool (20260930160000)
  v_pool_cancel  jsonb;
BEGIN$n$),
      ($o$      v_booked_left := v_booked_left - v_rev;
$o$,
       $n$      v_booked_left := v_booked_left - v_rev;
      v_booked_reversed := v_booked_reversed + v_rev;
$n$),
      ($o$  -- Lifetime counter follows the recall (delta, never an absolute set).
$o$,
       $n$  -- Landlord Float Pool (20260930160000): whatever was reversed goes back to
  -- the pool entries that funded this plan. Non-fatal: a pool bookkeeping
  -- failure must never block a cancellation; it is filed for replay.
  IF v_booked_reversed > 0 THEN
    BEGIN
      v_pool_cancel := public.landlord_pool_cancel_return(p_rent_request_id, v_booked_reversed,
                                                          'cancel_tenant_and_return_landlord_float');
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
      VALUES (NULL, 'return', 'cancel_tenant_and_return_landlord_float', SQLERRM,
              jsonb_build_object('sqlstate', SQLSTATE, 'rent_request_id', p_rent_request_id,
                                 'amount', v_booked_reversed));
    END;
  END IF;

  -- Lifetime counter follows the recall (delta, never an absolute set).
$n$)
    ) AS t(o, n)
  LOOP
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'cancel_tenant_and_return_landlord_float: fragment not found exactly once — aborting: %', left(v_old, 80);
    END IF;
    v_def := replace(v_def, v_old, v_new);
  END LOOP;
  EXECUTE v_def;
END
$mig$;

-- ── Reporting view: returned principal has no portfolio ──────────────────
CREATE OR REPLACE VIEW public.v_landlord_pool_position
WITH (security_invoker = true) AS
SELECT e.portfolio_id,
       ip.portfolio_code,
       e.partner_id,
       e.origin,
       CASE WHEN e.source_table = 'partner_supported_houses' THEN 'house'
            WHEN e.source_table = 'partner_self_funding_lines' THEN 'tenant'
            WHEN e.source_table = 'returned_principal' THEN 'returned_rent'
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
  LEFT JOIN public.investor_portfolios ip ON ip.id = e.portfolio_id
 GROUP BY e.portfolio_id, ip.portfolio_code, e.partner_id, e.origin, 5, e.entry_kind;

REVOKE ALL ON public.v_landlord_pool_position FROM PUBLIC, anon;
GRANT SELECT ON public.v_landlord_pool_position TO authenticated;

-- ── Record the returned principal already in the pool (records only) ────
DO $bf$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id FROM public.general_ledger
     WHERE ledger_scope = 'platform'
       AND category IN ('landlord_pool_return_company_managed', 'landlord_pool_return_self_support')
       AND coalesce(idempotency_key, '') NOT LIKE 'lp-%'
     ORDER BY created_at
  LOOP
    PERFORM public.landlord_pool_record_returned_principal(r.id);
  END LOOP;
END
$bf$;

REVOKE ALL ON FUNCTION public.landlord_pool_cancel_return(uuid, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_pool_record_returned_principal(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_landlord_pool_returned_principal() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._landlord_pool_post(uuid, text, numeric, text, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_pool_deploy(uuid, numeric, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.landlord_pool_cancel_return(uuid, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_record_returned_principal(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._landlord_pool_post(uuid, text, numeric, text, uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_deploy(uuid, numeric, text, uuid, uuid, text) TO service_role;
