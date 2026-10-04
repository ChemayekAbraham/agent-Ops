-- P1 #7 — "I approve" (tenant payment readiness) for ops roles + approval gate.
-- See docs/HANDOVER/121-self-applied-tenant-claim-and-readiness-gate.md.
--
-- Rule: no rent request reaches final approval until someone on landlord ops,
-- agent ops, tenant ops or an active service centre manager has recorded that
-- the tenant (a) was trained to pay by themselves via mobile money and
-- (b) confirmed they understand their rent top-up access limit.
-- Jen and Grace run the training; this records it.
--
-- Gate point: entering coo_approved / approved / funded / disbursed / repaying
-- from any pre-approval status. The ops stages before COO (service centre,
-- agent ops, tenant ops, landlord ops, partner ops) stay open so the button can
-- be pressed at whichever stage the training happens.
--
-- The gate ships OFF (treasury_controls.enforce_tenant_readiness_gate = false)
-- so COO is not blocked before the button is on screen. Turn it on with:
--   UPDATE treasury_controls SET enabled = true, updated_at = now()
--    WHERE control_key = 'enforce_tenant_readiness_gate';

DO $$ BEGIN
  PERFORM set_config('lock_timeout', '10s', true);
  LOCK TABLE public.rent_requests IN SHARE ROW EXCLUSIVE MODE;
END $$;

CREATE TABLE IF NOT EXISTS public.rent_request_tenant_readiness (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL REFERENCES public.rent_requests(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  momo_self_pay_trained boolean NOT NULL CHECK (momo_self_pay_trained),
  access_limit_understood boolean NOT NULL CHECK (access_limit_understood),
  access_limit_at_attestation numeric,
  trained_by_name text NOT NULL CHECK (length(trim(trained_by_name)) >= 2),
  note text,
  attested_by uuid NOT NULL,
  attested_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text
);

CREATE INDEX IF NOT EXISTS rent_request_tenant_readiness_rr_idx
  ON public.rent_request_tenant_readiness (rent_request_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS rent_request_tenant_readiness_tenant_idx
  ON public.rent_request_tenant_readiness (tenant_id);

ALTER TABLE public.rent_request_tenant_readiness ENABLE ROW LEVEL SECURITY;

-- Writes only through the RPCs below.
DROP POLICY IF EXISTS "Staff view tenant readiness" ON public.rent_request_tenant_readiness;
CREATE POLICY "Staff view tenant readiness" ON public.rent_request_tenant_readiness
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'tenant_ops') OR public.has_role(auth.uid(), 'landlord_ops')
    OR public.has_role(auth.uid(), 'agent_ops') OR public.has_role(auth.uid(), 'partner_ops')
    OR public.has_role(auth.uid(), 'coo') OR public.has_role(auth.uid(), 'cfo')
    OR public.has_role(auth.uid(), 'ceo') OR public.has_role(auth.uid(), 'manager')
    OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'financial_ops')
    OR EXISTS (SELECT 1 FROM public.rent_requests rr
                WHERE rr.id = rent_request_id AND rr.service_center_manager_id = auth.uid())
    OR tenant_id = auth.uid()
  );

-- Which of the four approver roles the caller holds (first match), or NULL.
CREATE OR REPLACE FUNCTION public.tenant_readiness_approver_role(p_user uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN public.has_role(p_user, 'tenant_ops')   THEN 'tenant_ops'
    WHEN public.has_role(p_user, 'landlord_ops') THEN 'landlord_ops'
    WHEN public.has_role(p_user, 'agent_ops')    THEN 'agent_ops'
    WHEN public.is_service_center_manager(p_user) THEN 'service_center_manager'
    ELSE NULL
  END
$$;

GRANT EXECUTE ON FUNCTION public.tenant_readiness_approver_role(uuid) TO authenticated;

-- The "I approve" button.
CREATE OR REPLACE FUNCTION public.record_tenant_payment_readiness(
  p_rent_request_id uuid,
  p_momo_self_pay_trained boolean,
  p_access_limit_understood boolean,
  p_trained_by_name text,
  p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_rr record;
  v_limit numeric;
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_role := public.tenant_readiness_approver_role(v_actor);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Only landlord ops, agent ops, tenant ops or a service centre manager can approve tenant readiness'
      USING ERRCODE = '42501';
  END IF;

  IF p_momo_self_pay_trained IS NOT TRUE THEN
    RAISE EXCEPTION 'Confirm the tenant was trained to pay by themselves with mobile money';
  END IF;
  IF p_access_limit_understood IS NOT TRUE THEN
    RAISE EXCEPTION 'Confirm the tenant understands their rent top-up access limit';
  END IF;
  IF coalesce(length(trim(p_trained_by_name)), 0) < 2 THEN
    RAISE EXCEPTION 'Enter who trained the tenant';
  END IF;

  SELECT id, tenant_id, status, service_center_manager_id INTO v_rr
    FROM public.rent_requests WHERE id = p_rent_request_id;
  IF v_rr.id IS NULL THEN
    RAISE EXCEPTION 'Rent request not found';
  END IF;
  IF v_rr.status IN ('rejected','cancelled','deleted_by_agent','completed','fully_repaid','defaulted') THEN
    RAISE EXCEPTION 'This rent request is closed (%)', v_rr.status;
  END IF;

  -- A service centre manager may only approve requests routed to them.
  IF v_role = 'service_center_manager' AND v_rr.service_center_manager_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'This rent request is not routed to your service centre' USING ERRCODE = '42501';
  END IF;

  SELECT total_limit INTO v_limit FROM public.credit_access_limits WHERE user_id = v_rr.tenant_id;

  INSERT INTO public.rent_request_tenant_readiness (
    rent_request_id, tenant_id, momo_self_pay_trained, access_limit_understood,
    access_limit_at_attestation, trained_by_name, note, attested_by, attested_role
  ) VALUES (
    v_rr.id, v_rr.tenant_id, true, true, v_limit, trim(p_trained_by_name),
    nullif(trim(p_note), ''), v_actor, v_role
  ) RETURNING id INTO v_id;

  INSERT INTO public.system_events (event_type, user_id, actor_id, related_entity_type, related_entity_id, metadata, description)
  VALUES ('rent_request.tenant_readiness_approved', v_rr.tenant_id, v_actor, 'rent_requests', v_rr.id,
          jsonb_build_object('readiness_id', v_id, 'role', v_role, 'trained_by', trim(p_trained_by_name),
                             'access_limit', v_limit, 'status_at_attestation', v_rr.status),
          'Tenant trained on mobile money self-pay and rent top-up access limit');

  RETURN jsonb_build_object('readiness_id', v_id, 'rent_request_id', v_rr.id,
                            'attested_role', v_role, 'access_limit', v_limit);
END;
$$;

REVOKE ALL ON FUNCTION public.record_tenant_payment_readiness(uuid, boolean, boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_tenant_payment_readiness(uuid, boolean, boolean, text, text) TO authenticated;

-- Undo a mistaken approval (same four roles). The gate then blocks again.
CREATE OR REPLACE FUNCTION public.revoke_tenant_payment_readiness(p_readiness_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_row record;
BEGIN
  IF public.tenant_readiness_approver_role(v_actor) IS NULL THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF coalesce(length(trim(p_reason)), 0) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters';
  END IF;

  UPDATE public.rent_request_tenant_readiness
     SET revoked_at = now(), revoked_by = v_actor, revoke_reason = trim(p_reason)
   WHERE id = p_readiness_id AND revoked_at IS NULL
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Approval not found or already revoked';
  END IF;

  INSERT INTO public.system_events (event_type, user_id, actor_id, related_entity_type, related_entity_id, metadata, description)
  VALUES ('rent_request.tenant_readiness_revoked', v_row.tenant_id, v_actor, 'rent_requests', v_row.rent_request_id,
          jsonb_build_object('readiness_id', v_row.id, 'reason', trim(p_reason)),
          'Tenant readiness approval revoked');

  RETURN jsonb_build_object('readiness_id', v_row.id, 'revoked', true);
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_tenant_payment_readiness(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_tenant_payment_readiness(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Gate
-- ---------------------------------------------------------------------------
INSERT INTO public.treasury_controls (control_key, enabled, value)
VALUES ('enforce_tenant_readiness_gate', false,
        'Block final rent request approval until tenant MoMo self-pay training + access-limit acknowledgement is recorded')
ON CONFLICT (control_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.enforce_tenant_readiness_before_approval()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT coalesce((SELECT enabled FROM public.treasury_controls
                    WHERE control_key = 'enforce_tenant_readiness_gate'), false) THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.rent_request_tenant_readiness r
     WHERE r.rent_request_id = NEW.id AND r.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'TENANT_NOT_READY: this tenant has not been confirmed as trained to pay by mobile money and to understand their rent top-up access limit. Tenant ops, agent ops, landlord ops or the service centre manager must press "I approve" first.'
      USING ERRCODE = 'check_violation',
            HINT = 'Record the tenant readiness approval, then retry.';
  END IF;

  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_enforce_tenant_readiness_before_approval'
              AND tgrelid = 'public.rent_requests'::regclass) THEN
    DROP TRIGGER trg_enforce_tenant_readiness_before_approval ON public.rent_requests;
  END IF;
END $$;
CREATE TRIGGER trg_enforce_tenant_readiness_before_approval
  BEFORE UPDATE OF status ON public.rent_requests
  FOR EACH ROW
  WHEN (
    NEW.status IN ('coo_approved','approved','funded','disbursed','repaying')
    AND OLD.status IN ('pending','service_center_review','agent_ops_approved','tenant_ops_approved',
                       'agent_verified','landlord_ops_approved','partner_ops_approved')
  )
  EXECUTE FUNCTION public.enforce_tenant_readiness_before_approval();
