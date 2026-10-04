-- 1) Holding field so a freed house can be re-linked to the same tenant on restore
ALTER TABLE public.house_listings
  ADD COLUMN IF NOT EXISTS suspended_tenant_id uuid;

-- 2) Daily target view: exclude tenants the agent marked "not_paying"
CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
 WITH active_rents AS (
         SELECT rr.agent_id,
            rr.id AS rent_request_id,
            rr.daily_repayment,
            rr.amount_repaid,
            rr.total_repayment
           FROM rent_requests rr
          WHERE rr.status = ANY (ARRAY['funded'::text, 'repaying'::text])
            AND COALESCE(rr.agent_payment_status, 'paying') <> 'not_paying'
        ), reversed AS (
         SELECT DISTINCT agent_tenant_float_reversals.rent_request_id
           FROM agent_tenant_float_reversals
        ), eligible_rents AS (
         SELECT ar.agent_id,
            ar.rent_request_id,
            ar.daily_repayment,
            ar.amount_repaid,
            ar.total_repayment
           FROM active_rents ar
             LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
          WHERE (rv.rent_request_id IS NULL OR COALESCE(ar.amount_repaid, 0::numeric) > 0::numeric) AND (COALESCE(ar.total_repayment, 0::numeric) - COALESCE(ar.amount_repaid, 0::numeric)) > 0::numeric
        ), expected AS (
         SELECT eligible_rents.agent_id,
            count(*)::integer AS active_count,
            COALESCE(sum(eligible_rents.daily_repayment), 0::numeric) AS expected_daily
           FROM eligible_rents
          GROUP BY eligible_rents.agent_id
        ), collected AS (
         SELECT ac.agent_id,
            sum(
                CASE
                    WHEN (ac.created_at AT TIME ZONE 'Africa/Kampala'::text)::date = (now() AT TIME ZONE 'Africa/Kampala'::text)::date THEN ac.amount
                    ELSE 0::numeric
                END) AS paid_today,
            sum(
                CASE
                    WHEN (ac.created_at AT TIME ZONE 'Africa/Kampala'::text)::date = ((now() AT TIME ZONE 'Africa/Kampala'::text)::date - 1) THEN ac.amount
                    ELSE 0::numeric
                END) AS paid_yesterday
           FROM agent_collections ac
          WHERE ac.created_at >= (((now() AT TIME ZONE 'Africa/Kampala'::text)::date - 1)::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text)
          GROUP BY ac.agent_id
        )
 SELECT e.agent_id,
    e.active_count,
    e.expected_daily,
    COALESCE(c.paid_today, 0::numeric) AS paid_today,
    COALESCE(c.paid_yesterday, 0::numeric) AS paid_yesterday,
        CASE
            WHEN e.expected_daily > 0::numeric THEN round(COALESCE(c.paid_today, 0::numeric) / e.expected_daily, 4)
            ELSE 0::numeric
        END AS today_pct,
        CASE
            WHEN e.expected_daily > 0::numeric THEN round(COALESCE(c.paid_yesterday, 0::numeric) / e.expected_daily, 4)
            ELSE 0::numeric
        END AS yesterday_pct,
        CASE
            WHEN e.expected_daily > 0::numeric THEN GREATEST(COALESCE(c.paid_today, 0::numeric) / e.expected_daily, COALESCE(c.paid_yesterday, 0::numeric) / e.expected_daily)
            ELSE 0::numeric
        END AS effective_pct
   FROM expected e
     LEFT JOIN collected c USING (agent_id);

-- 3) Inactivation now frees / restores the tenant's house listing + landlord link
CREATE OR REPLACE FUNCTION public.agent_set_rent_payment_status(p_rent_request_id uuid, p_status text, p_reason text)
 RETURNS rent_requests
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller   uuid := auth.uid();
  v_rr       public.rent_requests;
  v_is_staff boolean;
  v_freed    integer := 0;
  v_restored integer := 0;
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

  -- ===== Priority move: free / restore the tenant's house listing =====
  IF p_status = 'not_paying' THEN
    -- Detach tenant from their house listing(s): house returns to Priority 1 (empty)
    WITH freed AS (
      UPDATE public.house_listings
         SET suspended_tenant_id = tenant_id,
             tenant_id           = NULL,
             status              = 'available'
       WHERE tenant_id = v_rr.tenant_id
       RETURNING 1
    )
    SELECT count(*) INTO v_freed FROM freed;

    -- Clear the landlord-level tenant link too (classification keys off both)
    UPDATE public.landlords
       SET tenant_id = NULL
     WHERE tenant_id = v_rr.tenant_id;
  ELSE
    -- Restore tenant to the previously held listing(s): house returns to Placed
    WITH restored AS (
      UPDATE public.house_listings
         SET tenant_id           = suspended_tenant_id,
             suspended_tenant_id = NULL,
             status              = 'occupied'
       WHERE suspended_tenant_id = v_rr.tenant_id
       RETURNING 1
    )
    SELECT count(*) INTO v_restored FROM restored;

    -- Re-link the landlord if this rent request's landlord is now empty
    IF v_rr.landlord_id IS NOT NULL THEN
      UPDATE public.landlords
         SET tenant_id = v_rr.tenant_id
       WHERE id = v_rr.landlord_id
         AND tenant_id IS NULL;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (
    v_caller,
    'rent.payment_status_changed',
    'rent_requests',
    p_rent_request_id,
    COALESCE(NULLIF(trim(coalesce(p_reason,'')),''), 'status_reset_paying'),
    jsonb_build_object(
      'new_status', p_status,
      'agent_id', v_rr.agent_id,
      'tenant_id', v_rr.tenant_id,
      'houses_freed', v_freed,
      'houses_restored', v_restored
    )
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
      'houses_freed', v_freed,
      'houses_restored', v_restored,
      'reason', NULLIF(trim(coalesce(p_reason,'')),'')
    )
  );

  -- Surface to the Tenant Ops realtime inbox feed when an AGENT (not ops staff)
  -- marks a tenant inactive, so ops sees it prominently right away.
  IF p_status = 'not_paying' AND NOT v_is_staff THEN
    BEGIN
      INSERT INTO public.ops_inbox_events (scope, bucket, delta, reason, related_id)
      VALUES ('tenant', 'at_risk', 1, 'agent_marked_inactive', v_rr.tenant_id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  -- Best-effort trust signal (don't fail RPC if helper is missing)
  BEGIN
    PERFORM public.capture_trust_signal(v_rr.agent_id, 'behavior', 'agent_rent_payment_status_changed', 1,
      jsonb_build_object('rent_request_id', p_rent_request_id, 'status', p_status));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN v_rr;
END;
$function$;