-- Review/resolution workflow for agent-flagged inactive tenants
CREATE TABLE IF NOT EXISTS public.tenant_inactive_reviews (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rent_request_id uuid NOT NULL UNIQUE,
  tenant_id uuid,
  status text NOT NULL DEFAULT 'acknowledged',
  acknowledged_by uuid,
  acknowledged_at timestamp with time zone,
  resolved_by uuid,
  resolved_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.tenant_inactive_reviews TO authenticated;
GRANT ALL ON public.tenant_inactive_reviews TO service_role;

ALTER TABLE public.tenant_inactive_reviews ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_inactive_reviews' AND policyname = 'Tenant ops can view inactive reviews') THEN
    CREATE POLICY "Tenant ops can view inactive reviews"
    ON public.tenant_inactive_reviews FOR SELECT TO authenticated
    USING (public.is_tenant_ops_staff(auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_inactive_reviews' AND policyname = 'Tenant ops can create inactive reviews') THEN
    CREATE POLICY "Tenant ops can create inactive reviews"
    ON public.tenant_inactive_reviews FOR INSERT TO authenticated
    WITH CHECK (public.is_tenant_ops_staff(auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_inactive_reviews' AND policyname = 'Tenant ops can update inactive reviews') THEN
    CREATE POLICY "Tenant ops can update inactive reviews"
    ON public.tenant_inactive_reviews FOR UPDATE TO authenticated
    USING (public.is_tenant_ops_staff(auth.uid()))
    WITH CHECK (public.is_tenant_ops_staff(auth.uid()));
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_tenant_inactive_reviews_updated_at ON public.tenant_inactive_reviews;
CREATE TRIGGER trg_tenant_inactive_reviews_updated_at
BEFORE UPDATE ON public.tenant_inactive_reviews
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Acknowledge: mark a banner row as reviewed (optionally with notes)
CREATE OR REPLACE FUNCTION public.ops_acknowledge_inactivation(p_rent_request_id uuid, p_notes text DEFAULT NULL)
 RETURNS public.tenant_inactive_reviews
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_row public.tenant_inactive_reviews;
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT tenant_id INTO v_tenant FROM public.rent_requests WHERE id = p_rent_request_id;

  INSERT INTO public.tenant_inactive_reviews (rent_request_id, tenant_id, status, acknowledged_by, acknowledged_at, notes)
  VALUES (p_rent_request_id, v_tenant, 'acknowledged', v_uid, now(), NULLIF(trim(coalesce(p_notes,'')),''))
  ON CONFLICT (rent_request_id) DO UPDATE
    SET status = CASE WHEN public.tenant_inactive_reviews.status = 'resolved' THEN 'resolved' ELSE 'acknowledged' END,
        acknowledged_by = COALESCE(public.tenant_inactive_reviews.acknowledged_by, EXCLUDED.acknowledged_by),
        acknowledged_at = COALESCE(public.tenant_inactive_reviews.acknowledged_at, EXCLUDED.acknowledged_at),
        notes = COALESCE(EXCLUDED.notes, public.tenant_inactive_reviews.notes)
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_uid, 'tenant.inactive_acknowledged', 'rent_requests', p_rent_request_id,
          COALESCE(NULLIF(trim(coalesce(p_notes,'')),''), 'acknowledged_review'),
          jsonb_build_object('tenant_id', v_tenant));

  RETURN v_row;
END;
$function$;

-- Resolve: close out a banner row; resolution notes are mandatory
CREATE OR REPLACE FUNCTION public.ops_resolve_inactivation(p_rent_request_id uuid, p_notes text)
 RETURNS public.tenant_inactive_reviews
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_row public.tenant_inactive_reviews;
BEGIN
  IF NOT public.is_tenant_ops_staff(v_uid) THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_notes IS NULL OR length(trim(p_notes)) < 10 THEN
    RAISE EXCEPTION 'NOTES_REQUIRED: provide at least 10 characters describing the resolution'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT tenant_id INTO v_tenant FROM public.rent_requests WHERE id = p_rent_request_id;

  INSERT INTO public.tenant_inactive_reviews (rent_request_id, tenant_id, status, acknowledged_by, acknowledged_at, resolved_by, resolved_at, notes)
  VALUES (p_rent_request_id, v_tenant, 'resolved', v_uid, now(), v_uid, now(), trim(p_notes))
  ON CONFLICT (rent_request_id) DO UPDATE
    SET status = 'resolved',
        resolved_by = EXCLUDED.resolved_by,
        resolved_at = EXCLUDED.resolved_at,
        acknowledged_by = COALESCE(public.tenant_inactive_reviews.acknowledged_by, EXCLUDED.acknowledged_by),
        acknowledged_at = COALESCE(public.tenant_inactive_reviews.acknowledged_at, EXCLUDED.acknowledged_at),
        notes = EXCLUDED.notes
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_uid, 'tenant.inactive_resolved', 'rent_requests', p_rent_request_id, trim(p_notes),
          jsonb_build_object('tenant_id', v_tenant));

  RETURN v_row;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.ops_acknowledge_inactivation(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_resolve_inactivation(uuid, text) TO authenticated;

-- Extend the banner RPC with review state; resolved rows drop off the banner
DROP FUNCTION IF EXISTS public.ops_recent_agent_inactivations(integer, integer);
CREATE OR REPLACE FUNCTION public.ops_recent_agent_inactivations(p_limit integer DEFAULT 25, p_since_hours integer DEFAULT 336)
 RETURNS TABLE(
   rent_request_id uuid,
   tenant_id uuid,
   tenant_name text,
   tenant_phone text,
   tenant_city text,
   agent_id uuid,
   agent_name text,
   reason text,
   marked_at timestamp with time zone,
   review_status text,
   review_notes text,
   acknowledged_at timestamp with time zone,
   reviewer_name text
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
    rr.agent_payment_status_reason,
    rr.agent_payment_status_set_at,
    COALESCE(tir.status, 'open'),
    tir.notes,
    tir.acknowledged_at,
    rp.full_name
  FROM public.rent_requests rr
  LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
  LEFT JOIN public.profiles ap ON ap.id = rr.agent_payment_status_set_by
  LEFT JOIN public.tenant_inactive_reviews tir ON tir.rent_request_id = rr.id
  LEFT JOIN public.profiles rp ON rp.id = COALESCE(tir.acknowledged_by, tir.resolved_by)
  WHERE rr.agent_payment_status = 'not_paying'
    AND rr.agent_payment_status_set_at >= now() - make_interval(hours => GREATEST(p_since_hours, 1))
    AND rr.agent_payment_status_set_by IS NOT NULL
    AND rr.agent_payment_status_set_by = rr.agent_id
    AND COALESCE(tir.status, 'open') <> 'resolved'
  ORDER BY rr.agent_payment_status_set_at DESC
  LIMIT GREATEST(LEAST(p_limit, 100), 1);
END;
$function$;