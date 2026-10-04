
-- 1. Add columns
ALTER TABLE public.rent_requests
  ADD COLUMN IF NOT EXISTS agent_payment_status text NOT NULL DEFAULT 'paying'
    CHECK (agent_payment_status IN ('paying','not_paying','completed_auto')),
  ADD COLUMN IF NOT EXISTS agent_payment_status_reason text,
  ADD COLUMN IF NOT EXISTS agent_payment_status_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_payment_status_set_by uuid;

CREATE INDEX IF NOT EXISTS idx_rr_agent_payment_status
  ON public.rent_requests(agent_id, agent_payment_status);

-- 2. Updated eligibility view
CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
WITH active_rents AS (
  SELECT rr.agent_id, rr.id AS rent_request_id, rr.daily_repayment,
         rr.amount_repaid, rr.total_repayment, rr.agent_payment_status
  FROM public.rent_requests rr
  WHERE rr.status = ANY (ARRAY[
    'pending','agent_verified','tenant_ops_approved',
    'agent_ops_approved','landlord_ops_approved',
    'coo_approved','funded','repaying'
  ])
),
reversed AS (
  SELECT DISTINCT rent_request_id FROM public.agent_tenant_float_reversals
),
eligible_rents AS (
  SELECT ar.*
  FROM active_rents ar
  LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
  WHERE (rv.rent_request_id IS NULL OR COALESCE(ar.amount_repaid,0) > 0)
    AND ar.agent_payment_status = 'paying'
    AND COALESCE(ar.total_repayment,0) - COALESCE(ar.amount_repaid,0) > 0
),
expected AS (
  SELECT agent_id,
         COUNT(*)::int                              AS active_count,
         COALESCE(SUM(daily_repayment), 0)::numeric AS expected_daily
  FROM eligible_rents GROUP BY agent_id
),
collected AS (
  SELECT ac.agent_id,
    SUM(CASE WHEN (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
                = (now()         AT TIME ZONE 'Africa/Kampala')::date
             THEN ac.amount ELSE 0 END)::numeric AS paid_today,
    SUM(CASE WHEN (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
                = ((now() AT TIME ZONE 'Africa/Kampala')::date - 1)
             THEN ac.amount ELSE 0 END)::numeric AS paid_yesterday
  FROM public.agent_collections ac
  WHERE ac.created_at >= (
    ((now() AT TIME ZONE 'Africa/Kampala')::date - 1)::timestamp
    AT TIME ZONE 'Africa/Kampala'
  )
  GROUP BY ac.agent_id
)
SELECT e.agent_id, e.active_count, e.expected_daily,
       COALESCE(c.paid_today, 0)     AS paid_today,
       COALESCE(c.paid_yesterday, 0) AS paid_yesterday,
       CASE WHEN e.expected_daily > 0
            THEN ROUND(COALESCE(c.paid_today,0)     / e.expected_daily, 4)
            ELSE 0 END AS today_pct,
       CASE WHEN e.expected_daily > 0
            THEN ROUND(COALESCE(c.paid_yesterday,0) / e.expected_daily, 4)
            ELSE 0 END AS yesterday_pct,
       CASE WHEN e.expected_daily > 0
            THEN GREATEST(
              COALESCE(c.paid_today,0)     / e.expected_daily,
              COALESCE(c.paid_yesterday,0) / e.expected_daily)
            ELSE 0 END AS effective_pct
FROM expected e LEFT JOIN collected c USING (agent_id);

ALTER VIEW public.v_agent_daily_eligibility SET (security_invoker = on);
GRANT SELECT ON public.v_agent_daily_eligibility TO authenticated, anon, service_role;

-- 3. RPC: agent_set_rent_payment_status
CREATE OR REPLACE FUNCTION public.agent_set_rent_payment_status(
  p_rent_request_id uuid,
  p_status text,
  p_reason text
)
RETURNS public.rent_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller   uuid := auth.uid();
  v_rr       public.rent_requests;
  v_is_staff boolean;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_status NOT IN ('paying','not_paying') THEN
    RAISE EXCEPTION 'INVALID_STATUS: must be paying or not_paying'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p_rent_request_id FOR UPDATE;
  IF v_rr.id IS NULL THEN
    RAISE EXCEPTION 'RENT_REQUEST_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  v_is_staff := public.has_role(v_caller, 'manager')
             OR public.has_role(v_caller, 'operations')
             OR public.has_role(v_caller, 'coo')
             OR public.has_role(v_caller, 'super_admin');

  IF v_rr.agent_id <> v_caller AND NOT v_is_staff THEN
    RAISE EXCEPTION 'FORBIDDEN: only the assigned agent or ops staff can change payment status'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_status = 'not_paying' AND (p_reason IS NULL OR length(trim(p_reason)) < 10) THEN
    RAISE EXCEPTION 'REASON_REQUIRED: provide at least 10 characters explaining why this tenant is not paying'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.rent_requests
     SET agent_payment_status         = p_status,
         agent_payment_status_reason  = NULLIF(trim(coalesce(p_reason,'')),''),
         agent_payment_status_set_at  = now(),
         agent_payment_status_set_by  = v_caller
   WHERE id = p_rent_request_id
   RETURNING * INTO v_rr;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_caller,
    'rent.payment_status_changed',
    'rent_requests',
    p_rent_request_id,
    COALESCE(NULLIF(trim(coalesce(p_reason,'')),''), 'status_reset_paying'),
    jsonb_build_object('new_status', p_status, 'agent_id', v_rr.agent_id, 'tenant_id', v_rr.tenant_id)
  );

  INSERT INTO public.system_events (event_type, actor_id, payload)
  VALUES (
    'agent.rent.payment_status_changed',
    v_caller,
    jsonb_build_object(
      'rent_request_id', p_rent_request_id,
      'agent_id', v_rr.agent_id,
      'tenant_id', v_rr.tenant_id,
      'status', p_status,
      'reason', NULLIF(trim(coalesce(p_reason,'')),'')
    )
  );

  -- Best-effort trust signal (don't fail RPC if helper is missing)
  BEGIN
    PERFORM public.capture_trust_signal(v_rr.agent_id, 'behavior', 'agent_rent_payment_status_changed', 1,
      jsonb_build_object('rent_request_id', p_rent_request_id, 'status', p_status));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN v_rr;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agent_set_rent_payment_status(uuid, text, text)
  TO authenticated, service_role;

-- 4. Reactivation trigger: any positive collection flips not_paying back to paying
CREATE OR REPLACE FUNCTION public.reactivate_rent_payment_status_on_collection()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rr public.rent_requests;
BEGIN
  IF NEW.rent_request_id IS NULL OR COALESCE(NEW.amount,0) <= 0 THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_rr FROM public.rent_requests WHERE id = NEW.rent_request_id;
  IF v_rr.id IS NULL OR v_rr.agent_payment_status <> 'not_paying' THEN
    RETURN NEW;
  END IF;

  UPDATE public.rent_requests
     SET agent_payment_status        = 'paying',
         agent_payment_status_reason = 'auto_reactivated_on_collection',
         agent_payment_status_set_at = now(),
         agent_payment_status_set_by = NEW.agent_id
   WHERE id = NEW.rent_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    NEW.agent_id,
    'rent.payment_status_changed',
    'rent_requests',
    NEW.rent_request_id,
    'auto_reactivated_on_collection',
    jsonb_build_object('new_status','paying','trigger','agent_collection','collection_amount', NEW.amount)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_reactivate_rent_payment_status ON public.agent_collections;
CREATE TRIGGER tr_reactivate_rent_payment_status
  AFTER INSERT ON public.agent_collections
  FOR EACH ROW EXECUTE FUNCTION public.reactivate_rent_payment_status_on_collection();

-- 5. Nightly housekeeping: auto-complete fully repaid active rents
CREATE OR REPLACE FUNCTION public.auto_close_fully_repaid_rents()
RETURNS TABLE (closed_count int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int;
BEGIN
  WITH upd AS (
    UPDATE public.rent_requests
       SET status = 'completed',
           agent_payment_status = 'completed_auto',
           agent_payment_status_reason = 'auto_completed_fully_repaid',
           agent_payment_status_set_at = now()
     WHERE status = ANY (ARRAY['funded','repaying'])
       AND COALESCE(amount_repaid,0) >= COALESCE(total_repayment,0)
       AND COALESCE(total_repayment,0) > 0
     RETURNING id
  )
  SELECT count(*)::int INTO v_count FROM upd;
  closed_count := v_count;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.auto_close_fully_repaid_rents() TO service_role;

-- Schedule nightly at 02:00 Africa/Kampala = 23:00 UTC
DO $$ BEGIN
  PERFORM cron.unschedule('auto-close-fully-repaid-rents');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'auto-close-fully-repaid-rents',
  '0 23 * * *',
  $$ SELECT public.auto_close_fully_repaid_rents(); $$
);
