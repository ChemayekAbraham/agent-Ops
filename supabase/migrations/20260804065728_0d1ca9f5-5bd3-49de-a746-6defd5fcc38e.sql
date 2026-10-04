
CREATE TABLE public.subagent_tenant_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_agent_id uuid NOT NULL,
  rent_request_id uuid NOT NULL,
  tenant_id uuid,
  from_sub_agent_id uuid NOT NULL,
  to_sub_agent_id uuid NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subagent_tenant_transfers_status_check CHECK (status IN ('pending','approved','rejected','cancelled')),
  CONSTRAINT subagent_tenant_transfers_reason_len CHECK (char_length(btrim(reason)) >= 10),
  CONSTRAINT subagent_tenant_transfers_distinct CHECK (from_sub_agent_id <> to_sub_agent_id)
);

CREATE UNIQUE INDEX subagent_tenant_transfers_one_pending
  ON public.subagent_tenant_transfers (rent_request_id)
  WHERE status = 'pending';
CREATE INDEX subagent_tenant_transfers_parent_idx ON public.subagent_tenant_transfers (parent_agent_id, status);

GRANT SELECT, INSERT ON public.subagent_tenant_transfers TO authenticated;
GRANT ALL ON public.subagent_tenant_transfers TO service_role;

ALTER TABLE public.subagent_tenant_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Parent agents view own transfer requests"
  ON public.subagent_tenant_transfers FOR SELECT TO authenticated
  USING (parent_agent_id = auth.uid() OR from_sub_agent_id = auth.uid() OR to_sub_agent_id = auth.uid());

CREATE POLICY "Ops view all transfer requests"
  ON public.subagent_tenant_transfers FOR SELECT TO authenticated
  USING (public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(),'agent_ops') OR public.has_role(auth.uid(),'super_admin'));

CREATE TRIGGER trg_subagent_tenant_transfers_updated_at
  BEFORE UPDATE ON public.subagent_tenant_transfers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ single-round-trip overview ============
CREATE OR REPLACE FUNCTION public.get_agent_service_center()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  WITH links AS (
    SELECT s.sub_agent_id, s.status AS link_status, s.created_at AS linked_at, s.source
    FROM public.agent_subagents s
    WHERE s.parent_agent_id = v_parent
      AND s.status IN ('verified','pending_acceptance')
  ),
  earn AS (
    SELECT e.agent_id,
           COALESCE(SUM(CASE WHEN e.earning_type IN ('referral_bonus') THEN e.amount ELSE 0 END),0) AS referral_bonus,
           COALESCE(SUM(CASE WHEN e.earning_type NOT IN ('referral_bonus') THEN e.amount ELSE 0 END),0) AS commission_total
    FROM public.agent_earnings e
    WHERE e.agent_id IN (SELECT sub_agent_id FROM links)
    GROUP BY e.agent_id
  ),
  tenants AS (
    SELECT r.agent_id,
           COUNT(*) FILTER (WHERE r.status IN ('funded','repaying')) AS active_tenants,
           COUNT(*) AS total_tenants,
           jsonb_agg(
             jsonb_build_object(
               'rent_request_id', r.id,
               'tenant_id', r.tenant_id,
               'tenant_name', p.full_name,
               'status', r.status,
               'monthly_rent', r.monthly_rent
             ) ORDER BY r.created_at DESC
           ) FILTER (WHERE r.status IN ('funded','repaying')) AS tenant_list
    FROM public.rent_requests r
    LEFT JOIN public.profiles p ON p.id = r.tenant_id
    WHERE r.agent_id IN (SELECT sub_agent_id FROM links)
    GROUP BY r.agent_id
  ),
  nested AS (
    SELECT s.parent_agent_id AS agent_id, COUNT(*) AS nested_subagents
    FROM public.agent_subagents s
    WHERE s.parent_agent_id IN (SELECT sub_agent_id FROM links)
      AND s.status = 'verified'
    GROUP BY s.parent_agent_id
  ),
  lands AS (
    SELECT l.registered_by AS agent_id,
           COUNT(*) AS landlords_registered,
           COUNT(*) FILTER (WHERE l.verification_status = 'verified' OR l.verified) AS landlords_verified
    FROM public.landlords l
    WHERE l.registered_by IN (SELECT sub_agent_id FROM links)
    GROUP BY l.registered_by
  ),
  blocks AS (
    SELECT b.agent_id, b.blocked_until, b.reason, b.freeze_scope
    FROM public.agent_listing_blocks b
    WHERE b.agent_id IN (SELECT sub_agent_id FROM links)
      AND b.active
      AND (b.blocked_until IS NULL OR b.blocked_until > now())
  ),
  pending_tf AS (
    SELECT t.from_sub_agent_id AS agent_id, COUNT(*) AS pending_transfers
    FROM public.subagent_tenant_transfers t
    WHERE t.parent_agent_id = v_parent AND t.status = 'pending'
    GROUP BY t.from_sub_agent_id
  )
  SELECT jsonb_build_object(
    'parent_agent_id', v_parent,
    'generated_at', now(),
    'sub_agents', COALESCE(jsonb_agg(
      jsonb_build_object(
        'sub_agent_id', k.sub_agent_id,
        'full_name', pr.full_name,
        'avatar_url', pr.avatar_url,
        'phone', pr.phone,
        'email', pr.email,
        'agent_tier', pr.agent_tier,
        'link_status', k.link_status,
        'linked_at', k.linked_at,
        'source', k.source,
        'commission_total', COALESCE(e.commission_total,0),
        'referral_bonus', COALESCE(e.referral_bonus,0),
        'active_tenants', COALESCE(t.active_tenants,0),
        'total_tenants', COALESCE(t.total_tenants,0),
        'tenant_list', COALESCE(t.tenant_list,'[]'::jsonb),
        'nested_subagents', COALESCE(n.nested_subagents,0),
        'landlords_registered', COALESCE(ld.landlords_registered,0),
        'landlords_verified', COALESCE(ld.landlords_verified,0),
        'wallet', jsonb_build_object(
          'withdrawable', COALESCE(w.withdrawable_balance,0),
          'float', COALESCE(w.float_balance,0),
          'advance', COALESCE(w.advance_balance,0)
        ),
        'suspension', CASE WHEN b.agent_id IS NULL THEN NULL ELSE jsonb_build_object(
          'blocked_until', b.blocked_until,
          'reason', b.reason,
          'scope', b.freeze_scope
        ) END,
        'pending_transfers', COALESCE(ptf.pending_transfers,0)
      ) ORDER BY pr.full_name NULLS LAST
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM links k
  LEFT JOIN public.profiles pr ON pr.id = k.sub_agent_id
  LEFT JOIN earn e ON e.agent_id = k.sub_agent_id
  LEFT JOIN tenants t ON t.agent_id = k.sub_agent_id
  LEFT JOIN nested n ON n.agent_id = k.sub_agent_id
  LEFT JOIN lands ld ON ld.agent_id = k.sub_agent_id
  LEFT JOIN public.wallets w ON w.user_id = k.sub_agent_id
  LEFT JOIN blocks b ON b.agent_id = k.sub_agent_id
  LEFT JOIN pending_tf ptf ON ptf.agent_id = k.sub_agent_id;

  RETURN COALESCE(v_result, jsonb_build_object('parent_agent_id', v_parent, 'sub_agents', '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.get_agent_service_center() FROM public;
GRANT EXECUTE ON FUNCTION public.get_agent_service_center() TO authenticated;

-- ============ suspension ============
CREATE OR REPLACE FUNCTION public.agent_suspend_subagent(
  p_sub_agent_id uuid,
  p_days integer,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent uuid := auth.uid();
  v_until timestamptz;
BEGIN
  IF v_parent IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'Suspension period must be between 1 and 90 days';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_subagents
    WHERE parent_agent_id = v_parent AND sub_agent_id = p_sub_agent_id AND status = 'verified'
  ) THEN
    RAISE EXCEPTION 'This sub-agent is not linked to your account';
  END IF;

  v_until := now() + make_interval(days => p_days);

  UPDATE public.agent_listing_blocks
     SET active = false, unblocked_at = now(), unblocked_by = v_parent,
         unblock_reason = 'Superseded by parent agent suspension'
   WHERE agent_id = p_sub_agent_id AND active;

  INSERT INTO public.agent_listing_blocks (agent_id, blocked_until, reason, auto_blocked, active, blocked_by, freeze_scope)
  VALUES (p_sub_agent_id, v_until, btrim(p_reason), false, true, v_parent, 'all');

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_parent, 'subagent_suspended', 'agent_listing_blocks', p_sub_agent_id, btrim(p_reason),
          jsonb_build_object('days', p_days, 'until', v_until, 'parent_agent_id', v_parent));

  RETURN jsonb_build_object('success', true, 'blocked_until', v_until);
END;
$$;

CREATE OR REPLACE FUNCTION public.agent_restore_subagent(
  p_sub_agent_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent uuid := auth.uid();
BEGIN
  IF v_parent IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_subagents
    WHERE parent_agent_id = v_parent AND sub_agent_id = p_sub_agent_id AND status = 'verified'
  ) THEN
    RAISE EXCEPTION 'This sub-agent is not linked to your account';
  END IF;

  UPDATE public.agent_listing_blocks
     SET active = false, unblocked_at = now(), unblocked_by = v_parent, unblock_reason = btrim(p_reason)
   WHERE agent_id = p_sub_agent_id AND active AND blocked_by = v_parent;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_parent, 'subagent_restored', 'agent_listing_blocks', p_sub_agent_id, btrim(p_reason),
          jsonb_build_object('parent_agent_id', v_parent));

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.agent_suspend_subagent(uuid, integer, text) FROM public;
REVOKE ALL ON FUNCTION public.agent_restore_subagent(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.agent_suspend_subagent(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_restore_subagent(uuid, text) TO authenticated;

-- ============ tenant transfer ============
CREATE OR REPLACE FUNCTION public.agent_request_subagent_tenant_transfer(
  p_rent_request_id uuid,
  p_to_sub_agent_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent uuid := auth.uid();
  v_from uuid;
  v_tenant uuid;
  v_id uuid;
BEGIN
  IF v_parent IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  SELECT r.agent_id, r.tenant_id INTO v_from, v_tenant
  FROM public.rent_requests r WHERE r.id = p_rent_request_id;

  IF v_from IS NULL THEN RAISE EXCEPTION 'Rent plan not found'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.agent_subagents
    WHERE parent_agent_id = v_parent AND sub_agent_id = v_from AND status = 'verified'
  ) THEN
    RAISE EXCEPTION 'That tenant does not belong to one of your sub-agents';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.agent_subagents
    WHERE parent_agent_id = v_parent AND sub_agent_id = p_to_sub_agent_id AND status = 'verified'
  ) THEN
    RAISE EXCEPTION 'The receiving sub-agent is not linked to your account';
  END IF;

  IF v_from = p_to_sub_agent_id THEN
    RAISE EXCEPTION 'The tenant already belongs to this sub-agent';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.subagent_tenant_transfers
    WHERE rent_request_id = p_rent_request_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'A transfer request for this tenant is already awaiting approval';
  END IF;

  INSERT INTO public.subagent_tenant_transfers
    (parent_agent_id, rent_request_id, tenant_id, from_sub_agent_id, to_sub_agent_id, reason)
  VALUES (v_parent, p_rent_request_id, v_tenant, v_from, p_to_sub_agent_id, btrim(p_reason))
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_parent, 'subagent_tenant_transfer_requested', 'subagent_tenant_transfers', v_id, btrim(p_reason),
          jsonb_build_object('rent_request_id', p_rent_request_id, 'from', v_from, 'to', p_to_sub_agent_id));

  RETURN jsonb_build_object('success', true, 'transfer_id', v_id, 'status', 'pending');
END;
$$;

CREATE OR REPLACE FUNCTION public.agent_list_subagent_tenant_transfers(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'requested_at' DESC), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'id', t.id,
      'rent_request_id', t.rent_request_id,
      'tenant_name', tp.full_name,
      'from_name', fp.full_name,
      'to_name', sp.full_name,
      'reason', t.reason,
      'status', t.status,
      'requested_at', t.requested_at,
      'decided_at', t.decided_at,
      'decision_reason', t.decision_reason
    ) AS x
    FROM public.subagent_tenant_transfers t
    LEFT JOIN public.profiles tp ON tp.id = t.tenant_id
    LEFT JOIN public.profiles fp ON fp.id = t.from_sub_agent_id
    LEFT JOIN public.profiles sp ON sp.id = t.to_sub_agent_id
    WHERE t.parent_agent_id = auth.uid()
    ORDER BY t.requested_at DESC
    LIMIT COALESCE(p_limit, 50)
  ) s;
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
           assigned_agent_id = v_row.to_sub_agent_id
     WHERE id = v_row.rent_request_id;
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
          jsonb_build_object('rent_request_id', v_row.rent_request_id, 'from', v_row.from_sub_agent_id, 'to', v_row.to_sub_agent_id));

  RETURN jsonb_build_object('success', true, 'status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_list_subagent_tenant_transfers(p_status text DEFAULT 'pending', p_limit integer DEFAULT 100)
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
      'from_name', fp.full_name,
      'to_name', sp.full_name,
      'reason', t.reason,
      'status', t.status,
      'requested_at', t.requested_at,
      'decided_at', t.decided_at,
      'decision_reason', t.decision_reason
    ) AS x
    FROM public.subagent_tenant_transfers t
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

REVOKE ALL ON FUNCTION public.agent_request_subagent_tenant_transfer(uuid, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.agent_list_subagent_tenant_transfers(integer) FROM public;
REVOKE ALL ON FUNCTION public.ops_decide_subagent_tenant_transfer(uuid, boolean, text) FROM public;
REVOKE ALL ON FUNCTION public.ops_list_subagent_tenant_transfers(text, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.agent_request_subagent_tenant_transfer(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.agent_list_subagent_tenant_transfers(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_decide_subagent_tenant_transfer(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_list_subagent_tenant_transfers(text, integer) TO authenticated;
