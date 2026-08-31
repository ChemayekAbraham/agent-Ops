-- 1. Tighten the two agent UPDATE policies with a status allowlist in WITH CHECK.
DROP POLICY IF EXISTS "Agents can verify their requests" ON public.rent_requests;
CREATE POLICY "Agents can verify their requests"
ON public.rent_requests
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'agent') AND agent_id = auth.uid())
WITH CHECK (
  public.has_role(auth.uid(), 'agent')
  AND agent_id = auth.uid()
  AND status = ANY (ARRAY[
    'pending','service_center_review','rejected','cancelled','deleted_by_agent','repaying'
  ])
);

DROP POLICY IF EXISTS "Agents and managers can verify unverified requests" ON public.rent_requests;
CREATE POLICY "Agents and managers can verify unverified requests"
ON public.rent_requests
FOR UPDATE
TO authenticated
USING (
  agent_verified = false
  AND status = ANY (ARRAY['pending','approved'])
  AND (
    public.has_role(auth.uid(), 'manager')
    OR (
      (public.has_role(auth.uid(), 'agent') OR public.has_role(auth.uid(), 'senior_agent'))
      AND (agent_id IS NULL OR agent_id = auth.uid() OR agent_verified_by = auth.uid())
    )
  )
)
WITH CHECK (
  public.has_role(auth.uid(), 'manager')
  OR (
    (public.has_role(auth.uid(), 'agent') OR public.has_role(auth.uid(), 'senior_agent'))
    AND status = ANY (ARRAY[
      'pending','service_center_review','rejected','cancelled','deleted_by_agent','repaying'
    ])
  )
);

-- 2. Column-level guard: block direct (non-SECURITY DEFINER) client edits by agents
--    to any review / approval / funding / payout column.
CREATE OR REPLACE FUNCTION public.guard_agent_rent_request_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- Only police direct client writes. SECURITY DEFINER RPCs run as the function
  -- owner, so current_user is not the API role and those flows pass untouched.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- Privileged reviewers keep their existing rights.
  IF public.has_role(v_uid, 'manager')
     OR public.has_role(v_uid, 'super_admin')
     OR public.has_role(v_uid, 'ceo')
     OR public.has_role(v_uid, 'coo')
     OR public.has_role(v_uid, 'cfo')
     OR public.has_role(v_uid, 'tenant_ops')
     OR public.has_role(v_uid, 'landlord_ops')
     OR public.has_role(v_uid, 'agent_ops')
     OR public.has_role(v_uid, 'partner_ops')
     OR public.has_role(v_uid, 'financial_ops')
     OR public.has_role(v_uid, 'operations')
  THEN
    RETURN NEW;
  END IF;

  IF NOT (
    public.has_role(v_uid, 'agent')
    OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent')
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('pending','service_center_review','rejected','cancelled','deleted_by_agent','repaying')
  THEN
    RAISE EXCEPTION 'Agents cannot move a rent request to status %', NEW.status
      USING ERRCODE = '42501';
  END IF;

  IF NEW.tenant_ops_reviewed_by   IS DISTINCT FROM OLD.tenant_ops_reviewed_by
     OR NEW.tenant_ops_reviewed_at   IS DISTINCT FROM OLD.tenant_ops_reviewed_at
     OR NEW.landlord_ops_reviewed_by IS DISTINCT FROM OLD.landlord_ops_reviewed_by
     OR NEW.landlord_ops_reviewed_at IS DISTINCT FROM OLD.landlord_ops_reviewed_at
     OR NEW.agent_ops_reviewed_by    IS DISTINCT FROM OLD.agent_ops_reviewed_by
     OR NEW.agent_ops_reviewed_at    IS DISTINCT FROM OLD.agent_ops_reviewed_at
     OR NEW.coo_reviewed_by          IS DISTINCT FROM OLD.coo_reviewed_by
     OR NEW.coo_reviewed_at          IS DISTINCT FROM OLD.coo_reviewed_at
     OR NEW.cfo_reviewed_by          IS DISTINCT FROM OLD.cfo_reviewed_by
     OR NEW.cfo_reviewed_at          IS DISTINCT FROM OLD.cfo_reviewed_at
     OR NEW.manager_verified         IS DISTINCT FROM OLD.manager_verified
     OR NEW.manager_verified_by      IS DISTINCT FROM OLD.manager_verified_by
     OR NEW.manager_verified_at      IS DISTINCT FROM OLD.manager_verified_at
     OR NEW.approved_by              IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at              IS DISTINCT FROM OLD.approved_at
     OR NEW.supporter_id             IS DISTINCT FROM OLD.supporter_id
     OR NEW.funded_at                IS DISTINCT FROM OLD.funded_at
     OR NEW.disbursed_at             IS DISTINCT FROM OLD.disbursed_at
     OR NEW.fund_recipient_type      IS DISTINCT FROM OLD.fund_recipient_type
     OR NEW.fund_recipient_id        IS DISTINCT FROM OLD.fund_recipient_id
     OR NEW.fund_recipient_name      IS DISTINCT FROM OLD.fund_recipient_name
     OR NEW.fund_routed_at           IS DISTINCT FROM OLD.fund_routed_at
     OR NEW.payout_transaction_reference IS DISTINCT FROM OLD.payout_transaction_reference
     OR NEW.payout_method            IS DISTINCT FROM OLD.payout_method
     OR NEW.amount_repaid            IS DISTINCT FROM OLD.amount_repaid
     OR NEW.total_roi_paid           IS DISTINCT FROM OLD.total_roi_paid
     OR NEW.roi_payments_count       IS DISTINCT FROM OLD.roi_payments_count
  THEN
    RAISE EXCEPTION 'Agents cannot modify review, approval, funding or repayment fields on a rent request'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_agent_rent_request_columns ON public.rent_requests;
CREATE TRIGGER trg_guard_agent_rent_request_columns
BEFORE UPDATE ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.guard_agent_rent_request_columns();