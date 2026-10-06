-- Stop a double tap booking a second collection.
--
-- `agent_allocate_tenant_payment` already has a solid idempotency path: when a
-- `p_client_ref` arrives it takes an advisory lock, looks for a collection
-- carrying that ref, and replays the original receipt instead of allocating
-- again. A unique index on `agent_collections(client_ref)` backs it up.
--
-- It cannot catch the case the CTO monitor is reporting. The client generates
-- `crypto.randomUUID()` INSIDE the submit handler, so the ref is fresh per
-- Confirm CLICK. That defends against one click being replayed on the wire; it
-- does nothing about the agent tapping Confirm twice, because tap two carries a
-- different ref and sails straight past the check. Measured over 45 days: of
-- the collection pairs sharing agent, tenant, plan and amount inside 15
-- seconds, ZERO shared a client_ref - every one was a distinct submission.
--
-- So match on the shape of the payment rather than on the ref. Same agent,
-- same tenant, same plan, same amount, inside the duplicate window, is treated
-- as a replay and returns the original receipt. The advisory lock serialises
-- two taps that arrive together, so the second waits for the first to commit
-- and then sees it.
--
-- 15 seconds is the house definition - the same window the Agent Collections
-- monitor uses for "any two within 15s". Observed double taps in the last 45
-- days ranged from 0.8s to 14.3s apart, so a shorter window would miss most of
-- them. A genuine second collection of the identical amount for the same
-- tenant within 15 seconds would mean re-entering the amount and confirming
-- again inside that window; if it ever happens the agent simply repeats it a
-- moment later.
--
-- Returning success with `idempotent: true` rather than raising keeps the
-- agent's screen honest: the money did move on the first tap, so telling them
-- it failed would invite a third attempt. The shape matches the existing
-- client_ref replay response the dialog already handles.
--
-- Scope note: the bulk of what the monitor lists for 15 and 16 September is
-- not double tapping - 908 rows across those two days, 6.6s to 15s apart, with
-- no client_ref, which is a backfill writing sequentially. The genuine double
-- taps are the handful the panel shows: 6 rows in 45 days. This guard stops
-- those and any future ones; it does not retro-correct history.
--
-- Applied as a guarded in-place patch; it raises if the anchor is absent.

do $patch$
declare v_src text; v_new text;
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'agent_allocate_tenant_payment';
  if v_src is null then raise exception 'agent_allocate_tenant_payment not found'; end if;

  v_new := replace(v_src,
$o1$  SELECT rr.agent_id, rr.assigned_agent_id INTO v_owner, v_assigned
    FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id AND rr.tenant_id = p_tenant_id;$o1$,
$n1$  -- A second Confirm tap carries a NEW client_ref, so the check above cannot
  -- see it. Catch the double tap by its shape instead. The advisory lock makes
  -- two taps that arrive together serialise rather than race.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'agent_collect_window:' || p_agent_id::text || ':' || p_tenant_id::text || ':' ||
    COALESCE(p_rent_request_id::text, '-') || ':' || p_amount::text, 0));

  SELECT ac.id, ac.tracking_id, ac.amount, ac.created_at, ac.rent_request_id, ac.tenant_id
    INTO v_prior
    FROM public.agent_collections ac
   WHERE ac.agent_id = p_agent_id
     AND ac.tenant_id = p_tenant_id
     AND ac.rent_request_id IS NOT DISTINCT FROM p_rent_request_id
     AND ac.amount = p_amount
     AND ac.created_at >= now() - interval '15 seconds'
   ORDER BY ac.created_at DESC
   LIMIT 1;

  IF v_prior.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'idempotent', true, 'duplicate_window_seconds', 15,
      'collection_id', v_prior.id, 'tracking_id', v_prior.tracking_id,
      'amount', v_prior.amount, 'amount_allocated', v_prior.amount,
      'processed_at', v_prior.created_at,
      'rent_request_id', v_prior.rent_request_id, 'tenant_id', v_prior.tenant_id,
      'note', 'The same amount was already collected for this tenant seconds ago. No new collection, commission, rent allocation or fee allocation was created.');
  END IF;

  SELECT rr.agent_id, rr.assigned_agent_id INTO v_owner, v_assigned
    FROM public.rent_requests rr
   WHERE rr.id = p_rent_request_id AND rr.tenant_id = p_tenant_id;$n1$);
  if v_new = v_src then raise exception 'rent_request lookup anchor not found'; end if;

  -- Parameter defaults reproduced exactly: callers pass these by name and omit
  -- several, so dropping a DEFAULT would break every collection path.
  execute format(
    'create or replace function public.agent_allocate_tenant_payment('
    || 'p_agent_id uuid, p_tenant_id uuid, p_rent_request_id uuid, p_amount numeric, '
    || 'p_notes text DEFAULT NULL::text, p_partial_confirmed boolean DEFAULT false, '
    || 'p_partial_reason text DEFAULT NULL::text, p_client_ref uuid DEFAULT NULL::uuid'
    || ') returns jsonb language plpgsql security definer set search_path=public as %L',
    v_new);
end
$patch$;
