-- Switch Landlord feature (Tenant Ops -> Classic -> Tenant Profile).
-- Purely additive: one new table + three new RPCs. Does not touch the
-- existing Switch Agent flow (ops_transfer_tenant_agent / list_assignable_agents /
-- get_tenant_transfer_history / tenant_reassignment_audit), any ledger/wallet
-- table, or any payout/allocation amount.
--
-- Role list for the search + write RPCs matches the live, verified role check
-- inside ops_transfer_tenant_agent exactly (tenant_ops, agent_ops,
-- landlord_ops, partner_ops, operations, coo, ceo, manager, super_admin).
-- The history RPC's role check matches the live, verified role check inside
-- get_tenant_transfer_history exactly (is_ops_role() OR manager OR super_admin).

-- =============================================================
-- 1. Append-only audit table
-- =============================================================

CREATE TABLE public.tenant_landlord_reassignment_audit (
  id uuid primary key default gen_random_uuid(),
  rent_request_id uuid not null references public.rent_requests(id),
  tenant_id uuid not null,
  old_landlord_id uuid not null references public.landlords(id),
  new_landlord_id uuid not null references public.landlords(id),
  reason text not null,
  actor_id uuid not null,
  house_listing_id uuid null references public.house_listings(id),
  allocation_updated boolean not null default false,
  pending_otps_cancelled integer not null default 0,
  created_at timestamptz not null default now()
);

CREATE INDEX tenant_landlord_reassignment_audit_tenant_idx
  ON public.tenant_landlord_reassignment_audit (tenant_id, created_at DESC);
CREATE INDEX tenant_landlord_reassignment_audit_rent_request_idx
  ON public.tenant_landlord_reassignment_audit (rent_request_id);
CREATE INDEX tenant_landlord_reassignment_audit_old_landlord_idx
  ON public.tenant_landlord_reassignment_audit (old_landlord_id);
CREATE INDEX tenant_landlord_reassignment_audit_new_landlord_idx
  ON public.tenant_landlord_reassignment_audit (new_landlord_id);

ALTER TABLE public.tenant_landlord_reassignment_audit ENABLE ROW LEVEL SECURITY;

-- Explicit revoke: this schema's default privileges auto-grant new tables to
-- anon/PUBLIC unless revoked explicitly (confirmed repeatedly elsewhere in
-- this project's history).
REVOKE ALL ON public.tenant_landlord_reassignment_audit FROM PUBLIC, anon;
GRANT SELECT ON public.tenant_landlord_reassignment_audit TO authenticated;
GRANT ALL ON public.tenant_landlord_reassignment_audit TO service_role;

-- No INSERT/UPDATE/DELETE grant to authenticated anywhere -- append-only,
-- the only write path is the SECURITY DEFINER RPC below.
CREATE POLICY "Ops staff read landlord reassignment audit"
ON public.tenant_landlord_reassignment_audit
FOR SELECT TO authenticated USING (
  public.has_role(auth.uid(), 'tenant_ops') OR public.has_role(auth.uid(), 'agent_ops')
  OR public.has_role(auth.uid(), 'landlord_ops') OR public.has_role(auth.uid(), 'partner_ops')
  OR public.has_role(auth.uid(), 'operations') OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
);

-- =============================================================
-- 2. Read-only eligible-landlord search
-- =============================================================

CREATE OR REPLACE FUNCTION public.list_eligible_landlords_for_rent_request(
  p_rent_request_id uuid,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  name text,
  phone text,
  property_address text,
  district text,
  village text,
  verified boolean,
  payout_ready boolean,
  eligible boolean,
  block_reason text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_current_landlord_id uuid;
  v_needs_payout_ready boolean;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'tenant_ops') OR public.has_role(v_actor, 'agent_ops')
    OR public.has_role(v_actor, 'landlord_ops') OR public.has_role(v_actor, 'partner_ops')
    OR public.has_role(v_actor, 'operations') OR public.has_role(v_actor, 'coo')
    OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'manager')
    OR public.has_role(v_actor, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only operations staff may search landlords for a switch' USING ERRCODE = '42501';
  END IF;

  SELECT landlord_id INTO v_current_landlord_id FROM public.rent_requests WHERE id = p_rent_request_id;
  IF v_current_landlord_id IS NULL THEN
    RAISE EXCEPTION 'Rent request not found' USING ERRCODE = 'P0002';
  END IF;

  -- Does this plan have an open, zero-paid allocation that would need to
  -- follow the switch (via the existing trg_follow_rent_request_landlord_change)?
  -- Computed once here, not per result row.
  v_needs_payout_ready := EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations a
    WHERE a.rent_request_id = p_rent_request_id
      AND a.status = 'open'
      AND COALESCE(a.paid_out_amount, 0) = 0
  );

  RETURN QUERY
  SELECT
    l.id, l.name, l.phone, l.property_address, l.district, l.village,
    l.verified,
    (l.verified_mobile_money_number IS NOT NULL AND length(trim(l.verified_mobile_money_number)) >= 8) AS payout_ready,
    (NOT v_needs_payout_ready
      OR (l.verified_mobile_money_number IS NOT NULL AND length(trim(l.verified_mobile_money_number)) >= 8)
    ) AS eligible,
    CASE
      WHEN v_needs_payout_ready
        AND NOT (l.verified_mobile_money_number IS NOT NULL AND length(trim(l.verified_mobile_money_number)) >= 8)
        THEN 'This rent plan has an unpaid landlord float allocation that needs a payout-ready landlord (approved mobile money number required).'
      ELSE NULL
    END AS block_reason
  FROM public.landlords l
  WHERE l.verified = true
    AND l.id <> v_current_landlord_id
    AND (
      NULLIF(trim(p_search), '') IS NULL
      OR l.name ILIKE '%' || trim(p_search) || '%'
      OR l.phone ILIKE '%' || trim(p_search) || '%'
    )
  ORDER BY l.name ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
END;
$function$;

REVOKE ALL ON FUNCTION public.list_eligible_landlords_for_rent_request(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_eligible_landlords_for_rent_request(uuid, text, integer) TO authenticated, service_role;

-- =============================================================
-- 3. The transfer itself
-- =============================================================

CREATE OR REPLACE FUNCTION public.ops_transfer_tenant_landlord(
  p_rent_request_id uuid,
  p_new_landlord_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := trim(COALESCE(p_reason, ''));
  v_rent_request public.rent_requests;
  v_old_landlord_id uuid;
  v_tenant_id uuid;
  v_house_listing_id uuid;
  v_new_landlord public.landlords;
  v_listing public.house_listings;
  v_allocation_updated boolean := false;
  v_pending_otps_cancelled integer := 0;
  v_property_update_status text := 'not_applicable';
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  IF NOT (
    public.has_role(v_actor, 'tenant_ops') OR public.has_role(v_actor, 'agent_ops')
    OR public.has_role(v_actor, 'landlord_ops') OR public.has_role(v_actor, 'partner_ops')
    OR public.has_role(v_actor, 'operations') OR public.has_role(v_actor, 'coo')
    OR public.has_role(v_actor, 'ceo') OR public.has_role(v_actor, 'manager')
    OR public.has_role(v_actor, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only operations staff may switch a rent plan''s landlord' USING ERRCODE = '42501';
  END IF;

  IF p_rent_request_id IS NULL OR p_new_landlord_id IS NULL THEN
    RAISE EXCEPTION 'Rent request and new landlord are required' USING ERRCODE = '22023';
  END IF;

  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required' USING ERRCODE = '22023';
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Reason must be at most 500 characters' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_rent_request FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rent request not found' USING ERRCODE = 'P0002';
  END IF;

  v_old_landlord_id := v_rent_request.landlord_id;
  v_tenant_id := v_rent_request.tenant_id;
  v_house_listing_id := v_rent_request.house_listing_id;

  IF p_new_landlord_id = v_old_landlord_id THEN
    RAISE EXCEPTION 'The selected landlord is already attached to this rent plan' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_new_landlord FROM public.landlords WHERE id = p_new_landlord_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected landlord not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT COALESCE(v_new_landlord.verified, false) THEN
    RAISE EXCEPTION 'Selected landlord is not verified' USING ERRCODE = '22023';
  END IF;

  -- Financial safety: never move a rent plan whose landlord money is already
  -- in motion. Never touches ledger/wallet/payout amounts either way.
  IF EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations
    WHERE rent_request_id = p_rent_request_id AND COALESCE(paid_out_amount, 0) > 0
  ) THEN
    RAISE EXCEPTION 'This rent plan already has a partially or fully paid landlord allocation and cannot be switched' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.landlord_payouts
    WHERE rent_request_id = p_rent_request_id
      AND (disbursed_at IS NOT NULL OR finops_disbursed_at IS NOT NULL OR status <> 'failed')
  ) THEN
    RAISE EXCEPTION 'This rent plan has an irreversible or already-disbursed landlord payout and cannot be switched' USING ERRCODE = '22023';
  END IF;

  -- Will an open zero-paid allocation follow this change? The existing
  -- trg_follow_rent_request_landlord_change trigger performs the actual move
  -- once rent_requests.landlord_id is updated below -- not duplicated here.
  IF EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations
    WHERE rent_request_id = p_rent_request_id AND status = 'open' AND COALESCE(paid_out_amount, 0) = 0
  ) THEN
    IF NOT (
      v_new_landlord.verified_mobile_money_number IS NOT NULL
      AND length(trim(v_new_landlord.verified_mobile_money_number)) >= 8
    ) THEN
      RAISE EXCEPTION 'Selected landlord has no approved payout number; this rent plan has an unpaid allocation that must follow to a payout-ready landlord' USING ERRCODE = '22023';
    END IF;
    v_allocation_updated := true;
  END IF;

  -- Counted for the audit trail; the same trigger cancels these once the
  -- landlord_id update below fires.
  SELECT count(*) INTO v_pending_otps_cancelled
  FROM public.landlord_payout_otp_challenges
  WHERE rent_request_id = p_rent_request_id
    AND status = 'pending'
    AND landlord_id IS DISTINCT FROM p_new_landlord_id;

  -- Property consistency.
  IF v_house_listing_id IS NULL THEN
    v_property_update_status := 'no_listing_linked';
  ELSE
    SELECT * INTO v_listing FROM public.house_listings WHERE id = v_house_listing_id FOR UPDATE;
    IF NOT FOUND THEN
      v_property_update_status := 'listing_missing';
    ELSIF v_listing.tenant_id IS NOT NULL AND v_listing.tenant_id <> v_tenant_id THEN
      RAISE EXCEPTION 'Linked property is assigned to a different, active tenant and cannot follow this switch' USING ERRCODE = '22023';
    ELSIF v_listing.landlord_id = p_new_landlord_id THEN
      v_property_update_status := 'already_new_landlord';
    ELSIF v_listing.landlord_id = v_old_landlord_id THEN
      UPDATE public.house_listings SET landlord_id = p_new_landlord_id, updated_at = now() WHERE id = v_house_listing_id;
      v_property_update_status := 'updated';
    ELSE
      RAISE EXCEPTION 'Linked property belongs to a different landlord and cannot be safely switched here' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- The switch itself. trg_enforce_rent_request_landlord_registered,
  -- trg_follow_rent_request_landlord_change and
  -- trg_auto_assign_landlord_on_rent_request_update fire automatically and
  -- are not duplicated here. Every other column on this row is untouched.
  UPDATE public.rent_requests SET landlord_id = p_new_landlord_id, updated_at = now() WHERE id = p_rent_request_id;

  INSERT INTO public.tenant_landlord_reassignment_audit (
    rent_request_id, tenant_id, old_landlord_id, new_landlord_id, reason, actor_id,
    house_listing_id, allocation_updated, pending_otps_cancelled
  ) VALUES (
    p_rent_request_id, v_tenant_id, v_old_landlord_id, p_new_landlord_id, v_reason, v_actor,
    v_house_listing_id, v_allocation_updated, v_pending_otps_cancelled
  );

  INSERT INTO public.audit_logs (
    user_id, action_type, table_name, record_id, reason, old_values, new_values, metadata
  ) VALUES (
    v_actor, 'tenant_landlord_transfer', 'rent_requests', p_rent_request_id::text, v_reason,
    jsonb_build_object('landlord_id', v_old_landlord_id),
    jsonb_build_object('landlord_id', p_new_landlord_id),
    jsonb_build_object(
      'tenant_id', v_tenant_id, 'house_listing_id', v_house_listing_id,
      'allocation_updated', v_allocation_updated, 'pending_otps_cancelled', v_pending_otps_cancelled,
      'property_update_status', v_property_update_status
    )
  );

  -- Best-effort, matching ops_transfer_tenant_agent's own non-blocking
  -- pattern. event_type is a free-text column with no enum/CHECK constraint
  -- (verified live); 'role_changed' is the same already-accepted value the
  -- agent-transfer RPC reuses, with the real meaning in payload.kind.
  BEGIN
    INSERT INTO public.system_events (event_type, actor_id, subject_id, payload)
    VALUES (
      'role_changed', v_actor, v_tenant_id,
      jsonb_build_object(
        'kind', 'tenant.landlord_transferred',
        'rent_request_id', p_rent_request_id,
        'old_landlord_id', v_old_landlord_id,
        'new_landlord_id', p_new_landlord_id,
        'reason', v_reason
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'rent_request_id', p_rent_request_id,
    'tenant_id', v_tenant_id,
    'old_landlord_id', v_old_landlord_id,
    'new_landlord_id', p_new_landlord_id,
    'property_update_status', v_property_update_status,
    'allocation_updated', v_allocation_updated,
    'pending_otps_cancelled', v_pending_otps_cancelled
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ops_transfer_tenant_landlord(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_transfer_tenant_landlord(uuid, uuid, text) TO authenticated, service_role;

-- =============================================================
-- 4. Read-only history
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_tenant_landlord_transfer_history(p_tenant_id uuid)
RETURNS TABLE (
  id uuid,
  occurred_at timestamptz,
  rent_request_id uuid,
  old_landlord_id uuid,
  old_landlord_name text,
  old_landlord_phone text,
  new_landlord_id uuid,
  new_landlord_name text,
  new_landlord_phone text,
  actor_id uuid,
  actor_name text,
  reason text,
  house_listing_id uuid,
  allocation_updated boolean,
  pending_otps_cancelled integer
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT
    r.id, r.created_at, r.rent_request_id,
    r.old_landlord_id, ol.name, ol.phone,
    r.new_landlord_id, nl.name, nl.phone,
    r.actor_id, ap.full_name,
    r.reason, r.house_listing_id, r.allocation_updated, r.pending_otps_cancelled
  FROM public.tenant_landlord_reassignment_audit r
  LEFT JOIN public.landlords ol ON ol.id = r.old_landlord_id
  LEFT JOIN public.landlords nl ON nl.id = r.new_landlord_id
  LEFT JOIN public.profiles ap ON ap.id = r.actor_id
  WHERE r.tenant_id = p_tenant_id
    AND (public.is_ops_role(auth.uid()) OR public.has_role(auth.uid(), 'manager') OR public.has_role(auth.uid(), 'super_admin'))
  ORDER BY r.created_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.get_tenant_landlord_transfer_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tenant_landlord_transfer_history(uuid) TO authenticated, service_role;
