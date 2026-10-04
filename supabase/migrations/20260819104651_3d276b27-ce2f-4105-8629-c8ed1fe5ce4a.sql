-- 1. Review table: rejection tracking
ALTER TABLE public.tenant_inactive_reviews
  ADD COLUMN IF NOT EXISTS rejected_by uuid,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_seen_at timestamptz;

-- Agents may read + acknowledge reviews that were sent back to them
DROP POLICY IF EXISTS "Agents can view reviews returned to them" ON public.tenant_inactive_reviews;
CREATE POLICY "Agents can view reviews returned to them"
ON public.tenant_inactive_reviews
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.rent_requests rr
    WHERE rr.id = tenant_inactive_reviews.rent_request_id
      AND rr.agent_id = (SELECT auth.uid())
  )
);

-- 2. Enriched ops list
DROP FUNCTION IF EXISTS public.ops_recent_agent_inactivations(integer, integer);
CREATE OR REPLACE FUNCTION public.ops_recent_agent_inactivations(
  p_limit integer DEFAULT 25,
  p_since_hours integer DEFAULT 336
)
RETURNS TABLE(
  rent_request_id uuid,
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  tenant_city text,
  agent_id uuid,
  agent_name text,
  agent_phone text,
  reason text,
  marked_at timestamptz,
  review_status text,
  review_notes text,
  acknowledged_at timestamptz,
  reviewer_name text,
  rent_amount numeric,
  daily_repayment numeric,
  total_repayment numeric,
  amount_repaid numeric,
  outstanding numeric,
  funded_at timestamptz,
  days_since_funded integer,
  last_collection_at timestamptz,
  last_collection_amount numeric,
  collections_count integer,
  days_since_last_collection integer,
  landlord_name text,
  landlord_phone text,
  house_title text,
  house_area text,
  trust_score numeric,
  tenancy_status text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  SELECT
    rr.id,
    rr.tenant_id,
    tp.full_name,
    tp.phone,
    tp.city,
    rr.agent_id,
    ap.full_name,
    agp.phone,
    rr.agent_payment_status_reason,
    rr.agent_payment_status_set_at,
    COALESCE(tir.status, 'open'),
    tir.notes,
    tir.acknowledged_at,
    rp.full_name,
    rr.rent_amount,
    rr.daily_repayment,
    rr.total_repayment,
    COALESCE(rr.amount_repaid, 0),
    GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0), 0),
    rr.funded_at,
    CASE WHEN rr.funded_at IS NOT NULL
      THEN EXTRACT(DAY FROM (now() - rr.funded_at))::int END,
    col.last_at,
    col.last_amount,
    COALESCE(col.cnt, 0)::int,
    CASE WHEN col.last_at IS NOT NULL
      THEN EXTRACT(DAY FROM (now() - col.last_at))::int END,
    lp.full_name,
    lp.phone,
    hl.title,
    NULLIF(concat_ws(', ', hl.district, hl.region), ''),
    ts.score,
    rr.tenancy_status
  FROM public.rent_requests rr
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = rr.agent_payment_status_set_by
  LEFT JOIN public.profiles agp ON agp.id = rr.agent_id
  LEFT JOIN public.profiles lp ON lp.id = rr.landlord_id
  LEFT JOIN public.house_listings hl ON hl.id = rr.house_listing_id
  LEFT JOIN public.welile_trust_score_cache ts ON ts.user_id = rr.tenant_id
  LEFT JOIN public.tenant_inactive_reviews tir ON tir.rent_request_id = rr.id
  LEFT JOIN public.profiles rp ON rp.id = COALESCE(tir.resolved_by, tir.rejected_by, tir.acknowledged_by)
  LEFT JOIN LATERAL (
    SELECT max(ac.created_at) AS last_at,
           count(*) AS cnt,
           (SELECT ac2.amount FROM public.agent_collections ac2
             WHERE ac2.tenant_id = rr.tenant_id
             ORDER BY ac2.created_at DESC LIMIT 1) AS last_amount
    FROM public.agent_collections ac
    WHERE ac.tenant_id = rr.tenant_id
  ) col ON true
  WHERE rr.agent_payment_status = 'not_paying'
    AND rr.agent_payment_status_set_at >= now() - make_interval(hours => GREATEST(p_since_hours, 1))
    AND rr.agent_payment_status_set_by IS NOT NULL
    AND rr.agent_payment_status_set_by = rr.agent_id
    AND COALESCE(tir.status, 'open') NOT IN ('resolved', 'rejected')
  ORDER BY rr.agent_payment_status_set_at DESC
  LIMIT GREATEST(LEAST(p_limit, 100), 1);
END;
$function$;

-- 3. Reject: send the flag back to the agent
CREATE OR REPLACE FUNCTION public.ops_reject_inactivation(
  p_rent_request_id uuid,
  p_notes text
)
RETURNS public.tenant_inactive_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rr public.rent_requests;
  v_row public.tenant_inactive_reviews;
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_notes IS NULL OR length(trim(p_notes)) < 10 THEN
    RAISE EXCEPTION 'NOTES_REQUIRED: provide at least 10 characters explaining the rejection'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p_rent_request_id;
  IF v_rr.id IS NULL THEN
    RAISE EXCEPTION 'rent_request_not_found';
  END IF;

  -- Put the tenant back on the agent's book (restores priority/eligibility)
  UPDATE public.rent_requests
     SET agent_payment_status = 'paying',
         agent_payment_status_reason = 'ops_rejected_inactive_flag: ' || trim(p_notes),
         agent_payment_status_set_at = now(),
         agent_payment_status_set_by = v_uid,
         tenant_ops_comment = trim(p_notes),
         tenant_ops_reviewed_by = v_uid,
         tenant_ops_reviewed_at = now(),
         updated_at = now()
   WHERE id = p_rent_request_id;

  INSERT INTO public.tenant_inactive_reviews (
    rent_request_id, tenant_id, status, acknowledged_by, acknowledged_at,
    rejected_by, rejected_at, notes
  )
  VALUES (
    p_rent_request_id, v_rr.tenant_id, 'rejected', v_uid, now(), v_uid, now(), trim(p_notes)
  )
  ON CONFLICT (rent_request_id) DO UPDATE
    SET status = 'rejected',
        rejected_by = EXCLUDED.rejected_by,
        rejected_at = EXCLUDED.rejected_at,
        agent_seen_at = NULL,
        acknowledged_by = COALESCE(public.tenant_inactive_reviews.acknowledged_by, EXCLUDED.acknowledged_by),
        acknowledged_at = COALESCE(public.tenant_inactive_reviews.acknowledged_at, EXCLUDED.acknowledged_at),
        notes = EXCLUDED.notes
  RETURNING * INTO v_row;

  -- Task back on the agent's dashboard
  IF v_rr.agent_id IS NOT NULL THEN
    INSERT INTO public.agent_tasks (
      agent_id, assigned_by, task_type, title, description, priority, status,
      tenant_id, rent_request_id, due_date
    )
    VALUES (
      v_rr.agent_id, v_uid, 'inactivation_rejected',
      'Tenant Ops returned an inactive flag',
      'Tenant Ops rejected your "not paying" flag. Reason: ' || trim(p_notes) ||
        ' — the tenant is back on your book; resume collection and update the status.',
      'high', 'pending',
      v_rr.tenant_id, p_rent_request_id, now() + interval '2 days'
    );
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_uid, 'tenant.inactive_rejected', 'rent_requests', p_rent_request_id, trim(p_notes),
          jsonb_build_object('tenant_id', v_rr.tenant_id, 'agent_id', v_rr.agent_id));

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('rent_request.returned_for_correction', v_rr.agent_id,
            jsonb_build_object(
              'source', 'tenant_ops_inactive_rejection',
              'rent_request_id', p_rent_request_id,
              'tenant_id', v_rr.tenant_id,
              'notes', trim(p_notes)
            ));
  EXCEPTION WHEN others THEN NULL;
  END;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.ops_reject_inactivation(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ops_reject_inactivation(uuid, text) TO authenticated;

-- 4. Agent-side: what was returned to me
CREATE OR REPLACE FUNCTION public.agent_returned_inactivations()
RETURNS TABLE(
  rent_request_id uuid,
  tenant_id uuid,
  tenant_name text,
  tenant_phone text,
  ops_notes text,
  rejected_at timestamptz,
  reviewer_name text,
  outstanding numeric,
  daily_repayment numeric,
  agent_seen_at timestamptz
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    tir.rent_request_id,
    rr.tenant_id,
    tp.full_name,
    tp.phone,
    tir.notes,
    tir.rejected_at,
    rp.full_name,
    GREATEST(COALESCE(rr.total_repayment, 0) - COALESCE(rr.amount_repaid, 0), 0),
    rr.daily_repayment,
    tir.agent_seen_at
  FROM public.tenant_inactive_reviews tir
  JOIN public.rent_requests rr ON rr.id = tir.rent_request_id
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles rp ON rp.id = tir.rejected_by
  WHERE tir.status = 'rejected'
    AND rr.agent_id = auth.uid()
    AND tir.agent_seen_at IS NULL
  ORDER BY tir.rejected_at DESC
  LIMIT 50;
$function$;

REVOKE ALL ON FUNCTION public.agent_returned_inactivations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_returned_inactivations() TO authenticated;

CREATE OR REPLACE FUNCTION public.agent_ack_returned_inactivation(p_rent_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.rent_requests rr
    WHERE rr.id = p_rent_request_id AND rr.agent_id = v_uid
  ) THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.tenant_inactive_reviews
     SET agent_seen_at = now()
   WHERE rent_request_id = p_rent_request_id
     AND status = 'rejected';

  UPDATE public.agent_tasks
     SET status = 'completed', completed_at = now(), updated_at = now()
   WHERE rent_request_id = p_rent_request_id
     AND agent_id = v_uid
     AND task_type = 'inactivation_rejected'
     AND status = 'pending';
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_ack_returned_inactivation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agent_ack_returned_inactivation(uuid) TO authenticated;