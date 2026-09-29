-- Landlord Float Pool — returns (checklist step 8b).
--
-- Design: docs/LANDLORD_POOL_FUNDING_DESIGN.md §5.4
-- Needs:  20260929230200
--
-- When a tenant repays, the PRINCIPAL part of the instalment goes back to the
-- pool entry that funded that tenant, under the same origin. Fees never do —
-- they are Welile's revenue. D5 (confirmed): the return counts on collection,
-- out of cash in transit (A5):
--
--   landlord_pool_return_<origin>  cash_in   DR A21/A22
--   landlord_pool_return_source    cash_out  CR A5
--
-- ── Where the principal figure comes from ────────────────────────────────
-- The four-part repayment waterfall already writes one instalment_allocations
-- row per collection with `principal_component`, and stamps `reversed_at` when
-- a collection is reversed. So the hook is a trigger on that table:
--   INSERT                 → return principal_component to the pool
--   reversed_at NULL→set   → take that return back out (same categories,
--                            opposite directions)
-- Plans outside the waterfall write no row and so never return — and every
-- pool-funded plan is new, so it is always inside the waterfall.
--
-- ── Which entry is repaid ─────────────────────────────────────────────────
-- A company-managed rent can be funded from several pool entries (oldest
-- first), and partly from plain treasury when the pool ran short. Returns go
-- back to the entries that funded THIS rent request, in the order they were
-- drawn, each capped at what it still has out with this tenant. The pool is
-- therefore repaid before treasury's share. Anything beyond the pool's share
-- stays in treasury, which is where rent_disbursement recorded it.
--
-- Non-blocking: a failure never stops a collection. It is filed in
-- landlord_pool_exceptions for replay.

-- ── _landlord_pool_post: add the return reversal ─────────────────────────
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
  v_cat_kind   text;   -- the movement named in the category
  v_store_kind text;   -- landlord_pool_movements.kind
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
    WHEN 'return_reversal' THEN
      v_pool_dir := 'cash_out'; v_other := 'landlord_pool_return_source';  v_other_dir := 'cash_in';
      v_cat_kind := 'return';   v_store_kind := 'reversal';
    WHEN 'release' THEN
      v_pool_dir := 'cash_out'; v_other := 'landlord_pool_release_target'; v_other_dir := 'cash_in';
      v_cat_kind := 'release';  v_store_kind := 'release';
    ELSE
      RAISE EXCEPTION 'LANDLORD_POOL_INVALID_KIND' USING HINT = coalesce(p_kind, 'null');
  END CASE;

  -- Idempotent retry: already posted and counted → return the same group.
  SELECT m.ledger_group_id INTO v_group
    FROM public.landlord_pool_movements m
    JOIN public.general_ledger gl ON gl.transaction_group_id = m.ledger_group_id
   WHERE m.pool_entry_id = e.id AND m.kind = v_store_kind
     AND gl.idempotency_key = 'lp-' || p_kind || '-' || e.id::text || '-' || p_ref
   LIMIT 1;
  IF v_group IS NOT NULL THEN RETURN v_group; END IF;

  IF p_kind IN ('deploy','release') AND p_amount > e.in_pool + 0.005 THEN
    RAISE EXCEPTION 'LANDLORD_POOL_INSUFFICIENT' USING HINT = format('entry %s holds %s, asked %s', e.id, e.in_pool, p_amount);
  END IF;
  IF p_kind = 'return' AND p_amount > e.out_with_tenants + 0.005 THEN
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
           returned = returned + CASE WHEN p_kind = 'return'  THEN p_amount
                                      WHEN p_kind = 'return_reversal' THEN -p_amount ELSE 0 END,
           released = released + CASE WHEN p_kind = 'release' THEN p_amount ELSE 0 END,
           status   = CASE WHEN p_kind = 'return_reversal' THEN 'open' ELSE status END,
           updated_at = now()
     WHERE id = e.id;
    UPDATE public.landlord_pool_entries
       SET status = 'closed'
     WHERE id = e.id AND in_pool = 0 AND out_with_tenants = 0 AND status = 'open';
  END IF;

  RETURN v_group;
END;
$function$;

-- ── Return ────────────────────────────────────────────────────────────────
-- p_ref is the instalment_allocations row id: one collection, one return.
CREATE OR REPLACE FUNCTION public.landlord_pool_return(
  p_rent_request_id uuid,
  p_principal       numeric,
  p_ref             uuid,
  p_collection_id   uuid DEFAULT NULL,
  p_caller          text DEFAULT 'unknown'
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_left numeric := coalesce(p_principal, 0);
  v_take numeric;
  v_out  jsonb := '[]'::jsonb;
  r      record;
BEGIN
  IF public.landlord_pool_cutover() IS NULL THEN
    RETURN jsonb_build_object('status', 'pool_off');
  END IF;
  IF p_rent_request_id IS NULL OR p_ref IS NULL OR v_left <= 0 THEN
    RETURN jsonb_build_object('status', 'no_op');
  END IF;

  -- Entries that funded THIS rent request, in draw order, with what each
  -- still has out with this tenant.
  FOR r IN
    SELECT m.pool_entry_id AS entry_id,
           sum(m.amount) FILTER (WHERE m.kind = 'deploy')
             - coalesce(sum(m.amount) FILTER (WHERE m.kind = 'return'), 0)
             + coalesce(sum(m.amount) FILTER (WHERE m.kind = 'reversal'), 0) AS outstanding,
           min(m.created_at) FILTER (WHERE m.kind = 'deploy') AS first_draw
      FROM public.landlord_pool_movements m
     WHERE m.rent_request_id = p_rent_request_id
     GROUP BY m.pool_entry_id
    HAVING bool_or(m.kind = 'deploy')
     ORDER BY first_draw, m.pool_entry_id
  LOOP
    EXIT WHEN v_left <= 0;
    CONTINUE WHEN coalesce(r.outstanding, 0) <= 0;
    v_take := least(v_left, r.outstanding);
    PERFORM public._landlord_pool_post(r.entry_id, 'return', v_take, p_ref::text,
                                       p_rent_request_id, NULL, p_collection_id);
    v_left := v_left - v_take;
    v_out := v_out || jsonb_build_object('entry_id', r.entry_id, 'amount', v_take);
  END LOOP;

  RETURN jsonb_build_object(
    'status', CASE WHEN jsonb_array_length(v_out) = 0 THEN 'not_pool_funded' ELSE 'returned' END,
    'returned', coalesce(p_principal, 0) - v_left, 'left_in_treasury', v_left,
    'returns', v_out, 'caller', p_caller);
END;
$function$;

-- ── Reverse a return (the collection was reversed) ────────────────────────
CREATE OR REPLACE FUNCTION public.landlord_pool_return_reverse(
  p_ref    uuid,
  p_caller text DEFAULT 'unknown'
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_out   jsonb := '[]'::jsonb;
  v_total numeric := 0;
  r       record;
BEGIN
  FOR r IN
    -- EXISTS, not JOIN: every group has two legs carrying the key, and a join
    -- counted each return twice (caught in the 2026-09-29 dry run: a 1,200
    -- return reversed as 2,400).
    SELECT m.pool_entry_id, m.rent_request_id, m.collection_id, sum(m.amount) AS amount
      FROM public.landlord_pool_movements m
     WHERE m.kind = 'return'
       AND EXISTS (SELECT 1 FROM public.general_ledger gl
                    WHERE gl.transaction_group_id = m.ledger_group_id
                      AND gl.idempotency_key = 'lp-return-' || m.pool_entry_id::text || '-' || p_ref::text)
     GROUP BY m.pool_entry_id, m.rent_request_id, m.collection_id
  LOOP
    PERFORM public._landlord_pool_post(r.pool_entry_id, 'return_reversal', r.amount, p_ref::text,
                                       r.rent_request_id, NULL, r.collection_id);
    v_total := v_total + r.amount;
    v_out := v_out || jsonb_build_object('entry_id', r.pool_entry_id, 'amount', r.amount);
  END LOOP;

  RETURN jsonb_build_object('status', CASE WHEN v_total = 0 THEN 'nothing_to_reverse' ELSE 'reversed' END,
                            'reversed', v_total, 'reversals', v_out, 'caller', p_caller);
END;
$function$;

-- ── Trigger on the repayment waterfall's allocation rows ─────────────────
CREATE OR REPLACE FUNCTION public.trg_landlord_pool_return_on_allocation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF public.landlord_pool_cutover() IS NULL THEN RETURN NULL; END IF;
  -- Cheap exit: only rent requests the pool actually funded.
  IF NOT EXISTS (SELECT 1 FROM public.landlord_pool_movements m
                  WHERE m.rent_request_id = NEW.rent_request_id AND m.kind = 'deploy') THEN
    RETURN NULL;
  END IF;

  BEGIN
    IF TG_OP = 'INSERT' AND NEW.reversed_at IS NULL AND coalesce(NEW.principal_component, 0) > 0 THEN
      PERFORM public.landlord_pool_return(NEW.rent_request_id, NEW.principal_component, NEW.id,
                                          NEW.source_id, 'instalment_allocation');
    ELSIF TG_OP = 'UPDATE' AND OLD.reversed_at IS NULL AND NEW.reversed_at IS NOT NULL THEN
      PERFORM public.landlord_pool_return_reverse(NEW.id, 'instalment_allocation_reversed');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
    VALUES (NULL, 'return', 'instalment_allocation:' || TG_OP, SQLERRM,
            jsonb_build_object('sqlstate', SQLSTATE, 'instalment_allocation_id', NEW.id,
                               'rent_request_id', NEW.rent_request_id,
                               'principal_component', NEW.principal_component,
                               'source_table', NEW.source_table, 'source_id', NEW.source_id));
  END;
  RETURN NULL;
END;
$function$;

-- Trigger creation is applied separately in production with a short
-- lock_timeout.
DROP TRIGGER IF EXISTS trg_zz_landlord_pool_return ON public.instalment_allocations;
CREATE TRIGGER trg_zz_landlord_pool_return
  AFTER INSERT OR UPDATE OF reversed_at ON public.instalment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.trg_landlord_pool_return_on_allocation();

REVOKE ALL ON FUNCTION public._landlord_pool_post(uuid, text, numeric, text, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_pool_return(uuid, numeric, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_pool_return_reverse(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_landlord_pool_return_on_allocation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._landlord_pool_post(uuid, text, numeric, text, uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_return(uuid, numeric, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.landlord_pool_return_reverse(uuid, text) TO service_role;
