-- ═══ PART 1: Service Centre vetting for house listings ═══
ALTER TABLE public.house_listings
  ADD COLUMN IF NOT EXISTS service_center_manager_id uuid,
  ADD COLUMN IF NOT EXISTS service_center_status text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS service_center_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS service_center_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS service_center_comment text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'house_listings_service_center_status_check'
  ) THEN
    ALTER TABLE public.house_listings
      ADD CONSTRAINT house_listings_service_center_status_check
      CHECK (service_center_status IN ('not_required','pending','passed','returned'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_house_listings_sc_pending
  ON public.house_listings (service_center_manager_id, service_center_status)
  WHERE service_center_status = 'pending';

CREATE OR REPLACE FUNCTION public.route_house_listing_service_center()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_manager uuid;
BEGIN
  IF COALESCE(NEW.verified, false) THEN RETURN NEW; END IF;
  IF COALESCE(NEW.service_center_status, 'not_required') <> 'not_required' THEN RETURN NEW; END IF;
  IF NEW.agent_id IS NULL THEN RETURN NEW; END IF;

  v_manager := public.resolve_service_center_manager_for_agent(NEW.agent_id);

  IF v_manager IS NOT NULL THEN
    NEW.service_center_status := 'pending';
    NEW.service_center_manager_id := v_manager;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_route_house_listing_service_center ON public.house_listings;
CREATE TRIGGER trg_route_house_listing_service_center
  BEFORE INSERT ON public.house_listings
  FOR EACH ROW EXECUTE FUNCTION public.route_house_listing_service_center();

CREATE OR REPLACE FUNCTION public.get_service_center_listing_queue(p_manager_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_manager uuid := COALESCE(p_manager_id, auth.uid());
  v_out jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_manager <> v_actor AND NOT public.is_ops_role(v_actor) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) INTO v_out
  FROM (
    SELECT jsonb_build_object(
      'id', h.id,
      'title', h.title,
      'district', h.district,
      'address', h.address,
      'village', h.village,
      'rent_amount', h.rent_amount,
      'bedrooms', h.bedrooms,
      'images', h.images,
      'latitude', h.latitude,
      'longitude', h.longitude,
      'created_at', h.created_at,
      'agent_id', h.agent_id,
      'agent_name', ap.full_name,
      'agent_phone', ap.phone,
      'landlord_id', h.landlord_id,
      'landlord_name', lp.full_name,
      'landlord_phone', lp.phone,
      'service_center_status', h.service_center_status
    ) AS x
    FROM public.house_listings h
    LEFT JOIN public.profiles ap ON ap.id = h.agent_id
    LEFT JOIN public.profiles lp ON lp.id = h.landlord_id
    WHERE h.service_center_status = 'pending'
      AND h.service_center_manager_id = v_manager
      AND COALESCE(h.verified, false) = false
      AND COALESCE(h.status,'available') NOT IN ('rejected','delisted')
    ORDER BY h.created_at DESC
    LIMIT 200
  ) s;

  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.service_center_review_house_listing(
  p_listing_id uuid,
  p_decision text,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_is_ops boolean := public.is_ops_role(auth.uid());
  v_row public.house_listings%ROWTYPE;
  v_new text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_decision NOT IN ('pass','return') THEN RAISE EXCEPTION 'invalid decision'; END IF;

  SELECT * INTO v_row FROM public.house_listings WHERE id = p_listing_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'listing not found'; END IF;
  IF v_row.service_center_status <> 'pending' THEN
    RAISE EXCEPTION 'this listing is not awaiting service centre review';
  END IF;
  IF NOT v_is_ops AND v_row.service_center_manager_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'not authorised to review this listing';
  END IF;
  IF p_decision = 'return' AND COALESCE(btrim(p_comment),'') = '' THEN
    RAISE EXCEPTION 'a reason is required when returning a listing';
  END IF;

  v_new := CASE WHEN p_decision = 'pass' THEN 'passed' ELSE 'returned' END;

  UPDATE public.house_listings
     SET service_center_status = v_new,
         service_center_reviewed_by = v_actor,
         service_center_reviewed_at = now(),
         service_center_comment = p_comment,
         updated_at = now()
   WHERE id = p_listing_id;

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (
    'listing_created',
    v_actor,
    'house_listing',
    p_listing_id,
    jsonb_build_object(
      'action', CASE WHEN p_decision = 'pass' THEN 'service_center_passed' ELSE 'service_center_returned' END,
      'service_center_manager_id', v_row.service_center_manager_id,
      'listing_agent_id', v_row.agent_id,
      'comment', p_comment,
      'reviewed_by_ops', v_is_ops
    )
  );

  RETURN jsonb_build_object('success', true, 'listing_id', p_listing_id, 'service_center_status', v_new);
END;
$$;

-- Allow an agent to resubmit a returned listing for vetting.
CREATE OR REPLACE FUNCTION public.agent_resubmit_listing_to_service_center(p_listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row public.house_listings%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_row FROM public.house_listings WHERE id = p_listing_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'listing not found'; END IF;
  IF v_row.agent_id IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'not your listing'; END IF;
  IF v_row.service_center_status <> 'returned' THEN RAISE EXCEPTION 'this listing is not in a returned state'; END IF;

  UPDATE public.house_listings
     SET service_center_status = 'pending',
         service_center_reviewed_by = NULL,
         service_center_reviewed_at = NULL,
         updated_at = now()
   WHERE id = p_listing_id;

  RETURN jsonb_build_object('success', true, 'listing_id', p_listing_id);
END;
$$;

-- ═══ PART 2: widen payment-history authorisation to the whole downline ═══
CREATE OR REPLACE FUNCTION public.get_service_center_tenant_payments(
  p_rent_request_id uuid,
  p_limit integer DEFAULT 10,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_manager uuid := auth.uid();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_tenant uuid;
  v_agent uuid;
  v_stamped uuid;
  v_allowed boolean := false;
  v_total int;
  v_sum numeric;
  v_items jsonb;
BEGIN
  IF v_manager IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT rr.tenant_id, COALESCE(rr.agent_id, rr.assigned_agent_id), rr.service_center_manager_id
    INTO v_tenant, v_agent, v_stamped
  FROM public.rent_requests rr
  WHERE rr.id = p_rent_request_id;

  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Rent request not found'; END IF;

  v_allowed := (
    v_stamped = v_manager
    OR v_agent = v_manager
    OR v_tenant = v_manager
    OR public.is_ops_role(v_manager)
    OR public.resolve_service_center_manager_for_agent(v_agent) = v_manager
  );

  -- Whole downline tree, not just direct sub-agents
  IF NOT v_allowed AND v_agent IS NOT NULL THEN
    WITH RECURSIVE downline AS (
      SELECT s.sub_agent_id
      FROM public.agent_subagents s
      WHERE s.parent_agent_id = v_manager
        AND s.status IN ('verified','pending_acceptance')
      UNION
      SELECT s.sub_agent_id
      FROM public.agent_subagents s
      JOIN downline d ON d.sub_agent_id = s.parent_agent_id
      WHERE s.status IN ('verified','pending_acceptance')
    )
    SELECT EXISTS (SELECT 1 FROM downline WHERE sub_agent_id = v_agent) INTO v_allowed;
  END IF;

  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'You are not linked to this tenant''s rent plan, so its payment history is not visible to you';
  END IF;

  WITH pays AS (
    SELECT r.id,
           r.created_at AS paid_at,
           r.amount,
           'repayment'::text AS source,
           NULL::text AS method,
           NULL::text AS reference,
           NULL::text AS collected_by
    FROM public.repayments r
    WHERE r.rent_request_id = p_rent_request_id
    UNION ALL
    SELECT c.id,
           c.created_at AS paid_at,
           c.amount,
           'agent_collection'::text AS source,
           c.payment_method AS method,
           COALESCE(c.momo_transaction_id, c.tracking_id) AS reference,
           ap.full_name AS collected_by
    FROM public.agent_collections c
    LEFT JOIN public.profiles ap ON ap.id = c.agent_id
    WHERE c.rent_request_id = p_rent_request_id
       OR (c.rent_request_id IS NULL AND c.tenant_id = v_tenant)
  )
  SELECT (SELECT count(*) FROM pays),
         (SELECT COALESCE(SUM(amount), 0) FROM pays),
         (SELECT COALESCE(jsonb_agg(y), '[]'::jsonb) FROM (
            SELECT jsonb_build_object(
              'id', p.id,
              'paid_at', p.paid_at,
              'amount', p.amount,
              'source', p.source,
              'method', p.method,
              'reference', p.reference,
              'collected_by', p.collected_by
            ) AS y
            FROM pays p
            ORDER BY p.paid_at DESC
            LIMIT v_limit OFFSET v_offset
          ) q)
    INTO v_total, v_sum, v_items;

  RETURN jsonb_build_object(
    'rent_request_id', p_rent_request_id,
    'total', COALESCE(v_total, 0),
    'total_amount', COALESCE(v_sum, 0),
    'limit', v_limit,
    'offset', v_offset,
    'items', COALESCE(v_items, '[]'::jsonb)
  );
END;
$$;

-- ═══ PART 5: LC letter reference on rent requests ═══
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS lc_letter_path text,
  ADD COLUMN IF NOT EXISTS lc_letter_bucket text;

-- ═══ PART 3: richer transfer queue + record move on approval ═══
CREATE OR REPLACE FUNCTION public.ops_list_subagent_tenant_transfers(
  p_status text DEFAULT 'pending',
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_out jsonb;
BEGIN
  IF NOT (public.is_ops_role(v_actor) OR public.has_role(v_actor,'agent_ops') OR public.has_role(v_actor,'super_admin')) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'requested_at' DESC), '[]'::jsonb) INTO v_out
  FROM (
    SELECT jsonb_build_object(
      'id', t.id,
      'rent_request_id', t.rent_request_id,
      'parent_name', pp.full_name,
      'tenant_name', tp.full_name,
      'tenant_phone', tp.phone,
      'from_name', fp.full_name,
      'from_phone', fp.phone,
      'to_name', sp.full_name,
      'to_phone', sp.phone,
      'rent_amount', rr.rent_amount,
      'daily_repayment', rr.daily_repayment,
      'plan_status', rr.status,
      'collected_total', COALESCE((
        SELECT SUM(c.amount) FROM public.agent_collections c WHERE c.rent_request_id = t.rent_request_id
      ), 0) + COALESCE((
        SELECT SUM(r.amount) FROM public.repayments r WHERE r.rent_request_id = t.rent_request_id
      ), 0),
      'reason', t.reason,
      'status', t.status,
      'requested_at', t.requested_at,
      'waiting_days', GREATEST(0, EXTRACT(DAY FROM (now() - t.requested_at))::int),
      'decided_at', t.decided_at,
      'decision_reason', t.decision_reason
    ) AS x
    FROM public.subagent_tenant_transfers t
    LEFT JOIN public.rent_requests rr ON rr.id = t.rent_request_id
    LEFT JOIN public.profiles pp ON pp.id = t.parent_agent_id
    LEFT JOIN public.profiles tp ON tp.id = t.tenant_id
    LEFT JOIN public.profiles fp ON fp.id = t.from_sub_agent_id
    LEFT JOIN public.profiles sp ON sp.id = t.to_sub_agent_id
    WHERE (p_status IS NULL OR t.status = p_status)
    ORDER BY t.requested_at DESC
    LIMIT COALESCE(p_limit, 100)
  ) s;

  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_decide_subagent_tenant_transfer(
  p_transfer_id uuid,
  p_approve boolean,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row public.subagent_tenant_transfers;
  v_tasks int := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.is_ops_role(v_actor) OR public.has_role(v_actor,'agent_ops') OR public.has_role(v_actor,'super_admin')) THEN
    RAISE EXCEPTION 'Only agent operations can decide tenant transfers';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A decision reason of at least 10 characters is required';
  END IF;

  SELECT * INTO v_row FROM public.subagent_tenant_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Transfer request not found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'This request was already decided'; END IF;

  IF p_approve THEN
    UPDATE public.rent_requests
       SET agent_id = v_row.to_sub_agent_id,
           assigned_agent_id = v_row.to_sub_agent_id,
           updated_at = now()
     WHERE id = v_row.rent_request_id;

    -- Open work follows the tenant. Historical collections stay with whoever
    -- collected them (commission integrity) but are reachable through the plan.
    UPDATE public.agent_tasks
       SET agent_id = v_row.to_sub_agent_id,
           updated_at = now()
     WHERE agent_id = v_row.from_sub_agent_id
       AND tenant_id = v_row.tenant_id
       AND COALESCE(status,'pending') NOT IN ('completed','cancelled');
    v_tasks := COALESCE((SELECT count(*) FROM public.agent_tasks
       WHERE agent_id = v_row.to_sub_agent_id AND tenant_id = v_row.tenant_id), 0);
  END IF;

  UPDATE public.subagent_tenant_transfers
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         decided_by = v_actor,
         decided_at = now(),
         decision_reason = btrim(p_reason)
   WHERE id = p_transfer_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_actor, CASE WHEN p_approve THEN 'subagent_tenant_transfer_approved' ELSE 'subagent_tenant_transfer_rejected' END,
          'subagent_tenant_transfers', p_transfer_id, btrim(p_reason),
          jsonb_build_object('rent_request_id', v_row.rent_request_id, 'from', v_row.from_sub_agent_id,
                             'to', v_row.to_sub_agent_id, 'tasks_moved', v_tasks));

  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES ('role_changed', v_actor, 'rent_request', v_row.rent_request_id,
          jsonb_build_object(
            'action', CASE WHEN p_approve THEN 'tenant_transfer_approved' ELSE 'tenant_transfer_rejected' END,
            'from_agent_id', v_row.from_sub_agent_id,
            'to_agent_id', v_row.to_sub_agent_id,
            'tenant_id', v_row.tenant_id,
            'reason', btrim(p_reason)));

  RETURN jsonb_build_object('success', true, 'status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_service_center_listing_queue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.service_center_review_house_listing(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_resubmit_listing_to_service_center(uuid) TO authenticated;