-- Tenant Ops Workspace — collection allocation engine.
--
-- Per docs/TOPS_RULES.md: new functions only. This migration READS
-- agent_collections and WRITES ONLY tops_instalment_settlements (via
-- tops_plan_instalments for the schedule it allocates against). It never
-- writes to agent_collections, general_ledger or any wallet table, and adds
-- no trigger to any of them — the money-movement write path
-- (agent_allocate_tenant_payment and everything it touches) is completely
-- untouched. These are our own attribution of already-recorded money; they
-- do not create, move or reverse money themselves.
--
-- Reversal test (per docs/TOPS_FINDINGS.md §5): agent_collections.reversed_at
-- IS NOT NULL is the authoritative, complete rule — used correctly by "the
-- overwhelming majority" of existing reporting functions. The one documented
-- exception, rent_apply_collections_to_days()'s incomplete
-- `notes ILIKE '%[REVERSED:%'` text check (measurably missing 48 reversed
-- collections as of the FINDINGS date), is exactly what we must NOT copy.
-- tops_is_collection_reversed() exists so this rule lives in exactly one
-- place; if reversal is ever recorded differently, only this function
-- changes.

-- ---------------------------------------------------------------------------
-- 1. tops_is_collection_reversed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_is_collection_reversed(p_collection_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT reversed_at IS NOT NULL
  FROM public.agent_collections
  WHERE id = p_collection_id;
$$;

REVOKE ALL ON FUNCTION public.tops_is_collection_reversed(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_is_collection_reversed(uuid) IS
'Single source of truth for "is this collection reversed", per docs/TOPS_FINDINGS.md §5: agent_collections.reversed_at IS NOT NULL. Deliberately not the notes text-marker check that rent_apply_collections_to_days() uses (documented there as incomplete). Internal engine only, no EXECUTE grant to anon/authenticated.';

-- ---------------------------------------------------------------------------
-- 2. tops_allocate_collection — one collection, oldest-due-instalment-first.
--
-- Recomputes this collection's own attribution from scratch on every call
-- (excluding the collection's own existing rows from each instalment's
-- "already covered by other money" test, then upserting by
-- (instalment_id, collection_id) and deleting any of this collection's rows
-- that the fresh computation no longer touches). This is what makes it
-- idempotent and safely re-runnable rather than an incremental add-on-top:
-- a second call with nothing changed recomputes the identical take amounts,
-- so the upsert is a no-op and the cleanup delete finds nothing stale.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_allocate_collection(p_collection_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rent_request_id uuid;
  v_amount numeric(14,2);
  v_remaining numeric(14,2);
  v_released_count integer;
  v_touched_count integer := 0;
  v_touched_ids uuid[] := '{}';
  v_inst record;
  v_other_settled numeric(14,2);
  v_outstanding numeric(14,2);
  v_take numeric(14,2);
BEGIN
  SELECT rent_request_id, amount INTO v_rent_request_id, v_amount
  FROM public.agent_collections
  WHERE id = p_collection_id;

  IF NOT FOUND OR v_rent_request_id IS NULL THEN
    RETURN 0;
  END IF;

  IF public.tops_is_collection_reversed(p_collection_id) THEN
    UPDATE public.tops_instalment_settlements
    SET released_at = now()
    WHERE collection_id = p_collection_id
      AND released_at IS NULL;
    GET DIAGNOSTICS v_released_count = ROW_COUNT;
    RETURN v_released_count;
  END IF;

  v_remaining := v_amount;

  FOR v_inst IN
    SELECT id, amount_ugx
    FROM public.tops_plan_instalments
    WHERE rent_request_id = v_rent_request_id
    ORDER BY due_date ASC, seq ASC
  LOOP
    EXIT WHEN v_remaining <= 0;

    -- Outstanding room on this instalment from every OTHER collection's
    -- money — this collection's own prior contribution (if any) is
    -- deliberately excluded here because we are about to recompute it fresh.
    SELECT COALESCE(SUM(amount_ugx), 0) INTO v_other_settled
    FROM public.tops_instalment_settlements
    WHERE instalment_id = v_inst.id
      AND released_at IS NULL
      AND collection_id <> p_collection_id;

    v_outstanding := v_inst.amount_ugx - v_other_settled;

    IF v_outstanding <= 0 THEN
      CONTINUE;
    END IF;

    v_take := LEAST(v_remaining, v_outstanding);

    INSERT INTO public.tops_instalment_settlements (
      instalment_id, collection_id, rent_request_id, amount_ugx
    ) VALUES (
      v_inst.id, p_collection_id, v_rent_request_id, v_take
    )
    ON CONFLICT (instalment_id, collection_id) DO UPDATE SET
      amount_ugx = EXCLUDED.amount_ugx;

    v_touched_ids := array_append(v_touched_ids, v_inst.id);
    v_touched_count := v_touched_count + 1;
    v_remaining := v_remaining - v_take;
  END LOOP;

  -- Any instalment this collection settled before but no longer needs to
  -- (another collection now covers it, or a schedule rebuild changed shape)
  -- is cleaned up here — an exact replace, never an accumulate.
  DELETE FROM public.tops_instalment_settlements
  WHERE collection_id = p_collection_id
    AND released_at IS NULL
    AND NOT (instalment_id = ANY(v_touched_ids));

  RETURN v_touched_count;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_allocate_collection(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_allocate_collection(uuid) IS
'Allocates one agent_collections row across its plan''s tops_plan_instalments, oldest due_date first; money left after the last instalment sits unallocated until more instalments exist (the tenant is ahead). A reversed collection releases (released_at = now()) rather than allocates. Idempotent: recomputes from scratch every call. Internal engine only, no EXECUTE grant to anon/authenticated.';

-- ---------------------------------------------------------------------------
-- 3. tops_allocate_pending — the cron entry point.
--
-- "No settlements yet" is read here as "not yet fully accounted for": zero
-- rows trivially qualifies, but so does a collection with some settlements
-- whose unreleased sum is still less than its own amount (e.g. it arrived
-- before this plan's cadence was locked, so tops_build_plan_instalments had
-- nothing to allocate against yet, and instalments only appeared later).
-- Recorded here rather than silently narrowed to a literal zero-rows count,
-- because the narrower reading would leave that later-arriving instalment
-- capacity permanently unclaimed for such a plan.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tops_allocate_pending(p_limit integer DEFAULT 2000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_collection_id uuid;
  v_count integer := 0;
BEGIN
  FOR v_collection_id IN
    SELECT ac.id
    FROM public.agent_collections ac
    LEFT JOIN (
      SELECT
        collection_id,
        SUM(amount_ugx) FILTER (WHERE released_at IS NULL) AS unreleased_sum,
        bool_or(released_at IS NULL) AS has_unreleased
      FROM public.tops_instalment_settlements
      GROUP BY collection_id
    ) s ON s.collection_id = ac.id
    WHERE ac.rent_request_id IS NOT NULL
      AND (
        (ac.reversed_at IS NULL AND COALESCE(s.unreleased_sum, 0) < ac.amount)
        OR (ac.reversed_at IS NOT NULL AND COALESCE(s.has_unreleased, false))
      )
    ORDER BY ac.created_at ASC
    LIMIT p_limit
  LOOP
    PERFORM public.tops_allocate_collection(v_collection_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.tops_allocate_pending(integer) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tops_allocate_pending(integer) IS
'Cron entry point: allocates collections not yet fully accounted for in tops_instalment_settlements, and releases settlements whose source collection is now reversed. Processes oldest collection first (created_at ascending) so history replays in order. Internal engine only, no EXECUTE grant to anon/authenticated.';

-- ---------------------------------------------------------------------------
-- Cron: new job only, does not touch any existing job.
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'tops-allocate-pending-collections-every-10min',
  '*/10 * * * *',
  $$ SELECT public.tops_allocate_pending(2000); $$
);
