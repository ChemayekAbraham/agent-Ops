ALTER TABLE public.agent_bike_leases
  ADD COLUMN IF NOT EXISTS ops_approved_by uuid,
  ADD COLUMN IF NOT EXISTS ops_approved_by_name text,
  ADD COLUMN IF NOT EXISTS coo_approved_by uuid,
  ADD COLUMN IF NOT EXISTS coo_approved_by_name text,
  ADD COLUMN IF NOT EXISTS cfo_disbursed_by uuid,
  ADD COLUMN IF NOT EXISTS cfo_disbursed_by_name text;

CREATE OR REPLACE FUNCTION public.sync_bike_lease_from_sale()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_prev public.agent_bike_leases; v_uid uuid := auth.uid(); v_name text;
BEGIN
  IF lower(COALESCE(NEW.item_name,'')) NOT LIKE '%spiro%' THEN RETURN NEW; END IF;
  SELECT * INTO v_prev FROM public.agent_bike_leases WHERE sale_id = NEW.id;
  IF v_uid IS NOT NULL THEN SELECT full_name INTO v_name FROM public.profiles WHERE id = v_uid; END IF;
  INSERT INTO public.agent_bike_leases AS b (sale_id, agent_id, agent_name, agent_phone, brand, model, tracking_reference,
    valuation_amount, lease_term_months, wallet_recovery_rate, amount_paid, amount_outstanding, status, rejection_reason,
    ops_approved_at, coo_approved_at, cfo_disbursed_at, lease_activated_at, disbursed_amount, created_at)
  VALUES (NEW.id, NEW.customer_id, NEW.client_name, NEW.client_phone, COALESCE(NEW.brand,'Spiro'), NEW.model_type, NEW.tracking_reference,
    COALESCE(NULLIF(NEW.valuation_amount,0), NULLIF(NEW.total_amount,0), NEW.total_revenue, 0),
    COALESCE(NEW.lease_term_months,12), NEW.lease_daily_rate, COALESCE(NEW.amount_paid,0), COALESCE(NEW.amount_outstanding,0),
    COALESCE(NEW.order_status,'submitted'), NEW.rejection_reason, NEW.ops_approved_at, NEW.coo_approved_at,
    NEW.cfo_disbursed_at, NEW.lease_activated_at, NEW.disbursed_amount, COALESCE(NEW.created_at, now()))
  ON CONFLICT (sale_id) DO UPDATE SET
    agent_id = EXCLUDED.agent_id, agent_name = EXCLUDED.agent_name, agent_phone = EXCLUDED.agent_phone,
    model = EXCLUDED.model, tracking_reference = EXCLUDED.tracking_reference,
    valuation_amount = EXCLUDED.valuation_amount, lease_term_months = EXCLUDED.lease_term_months,
    wallet_recovery_rate = EXCLUDED.wallet_recovery_rate, amount_paid = EXCLUDED.amount_paid,
    amount_outstanding = EXCLUDED.amount_outstanding, status = EXCLUDED.status, rejection_reason = EXCLUDED.rejection_reason,
    ops_approved_at = EXCLUDED.ops_approved_at, coo_approved_at = EXCLUDED.coo_approved_at,
    cfo_disbursed_at = EXCLUDED.cfo_disbursed_at, lease_activated_at = EXCLUDED.lease_activated_at,
    disbursed_amount = EXCLUDED.disbursed_amount, updated_at = now()
  RETURNING id INTO v_id;

  -- Stamp the approver the first time each stage's timestamp appears.
  IF v_uid IS NOT NULL THEN
    UPDATE public.agent_bike_leases SET
      ops_approved_by = CASE WHEN NEW.ops_approved_at IS NOT NULL AND ops_approved_by IS NULL
        AND v_prev.ops_approved_at IS DISTINCT FROM NEW.ops_approved_at THEN v_uid ELSE ops_approved_by END,
      ops_approved_by_name = CASE WHEN NEW.ops_approved_at IS NOT NULL AND ops_approved_by IS NULL
        AND v_prev.ops_approved_at IS DISTINCT FROM NEW.ops_approved_at THEN v_name ELSE ops_approved_by_name END,
      coo_approved_by = CASE WHEN NEW.coo_approved_at IS NOT NULL AND coo_approved_by IS NULL
        AND v_prev.coo_approved_at IS DISTINCT FROM NEW.coo_approved_at THEN v_uid ELSE coo_approved_by END,
      coo_approved_by_name = CASE WHEN NEW.coo_approved_at IS NOT NULL AND coo_approved_by IS NULL
        AND v_prev.coo_approved_at IS DISTINCT FROM NEW.coo_approved_at THEN v_name ELSE coo_approved_by_name END,
      cfo_disbursed_by = CASE WHEN NEW.cfo_disbursed_at IS NOT NULL AND cfo_disbursed_by IS NULL
        AND v_prev.cfo_disbursed_at IS DISTINCT FROM NEW.cfo_disbursed_at THEN v_uid ELSE cfo_disbursed_by END,
      cfo_disbursed_by_name = CASE WHEN NEW.cfo_disbursed_at IS NOT NULL AND cfo_disbursed_by IS NULL
        AND v_prev.cfo_disbursed_at IS DISTINCT FROM NEW.cfo_disbursed_at THEN v_name ELSE cfo_disbursed_by_name END
    WHERE id = v_id;
  END IF;

  IF v_prev.id IS NULL
     OR v_prev.valuation_amount IS DISTINCT FROM COALESCE(NULLIF(NEW.valuation_amount,0), NULLIF(NEW.total_amount,0), NEW.total_revenue, 0)
     OR v_prev.lease_term_months IS DISTINCT FROM COALESCE(NEW.lease_term_months,12)
     OR v_prev.lease_activated_at IS DISTINCT FROM NEW.lease_activated_at THEN
    PERFORM public._generate_bike_lease_schedule(v_id);
  END IF;
  RETURN NEW;
END $function$;

-- Backfill from existing approval audit records
UPDATE public.agent_bike_leases b SET ops_approved_by = a.user_id, ops_approved_by_name = p.full_name
FROM public.audit_logs a LEFT JOIN public.profiles p ON p.id = a.user_id
WHERE a.record_id = b.sale_id::text AND a.action_type = 'bike_lease_ops_verified' AND b.ops_approved_by IS NULL;
UPDATE public.agent_bike_leases b SET coo_approved_by = a.user_id, coo_approved_by_name = p.full_name
FROM public.audit_logs a LEFT JOIN public.profiles p ON p.id = a.user_id
WHERE a.record_id = b.sale_id::text AND a.action_type = 'bike_lease_coo_approved' AND b.coo_approved_by IS NULL;
UPDATE public.agent_bike_leases b SET cfo_disbursed_by = a.user_id, cfo_disbursed_by_name = p.full_name
FROM public.audit_logs a LEFT JOIN public.profiles p ON p.id = a.user_id
WHERE a.record_id = b.sale_id::text AND a.action_type = 'bike_lease_cfo_disbursed' AND b.cfo_disbursed_by IS NULL;