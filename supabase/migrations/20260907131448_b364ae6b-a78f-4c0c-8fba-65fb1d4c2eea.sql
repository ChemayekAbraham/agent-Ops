CREATE OR REPLACE FUNCTION public.mark_proxy_commission_completed(p_id uuid, p_note text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE q public.proxy_commission_queue%ROWTYPE;
BEGIN
  IF NOT public.is_proxy_commission_admin() THEN
    RAISE EXCEPTION 'NOT_AUTHORISED: only Partner Operations may complete proxy commissions';
  END IF;

  SELECT * INTO q FROM public.proxy_commission_queue WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','skipped','reason','not_found');
  END IF;
  IF q.status <> 'pending' THEN
    RETURN jsonb_build_object('status','skipped','reason','not_pending','current_status',q.status);
  END IF;

  UPDATE public.proxy_commission_queue
     SET status = 'paid',
         decided_by = auth.uid(),
         decided_at = now(),
         decision_note = COALESCE(NULLIF(btrim(p_note), ''), 'Marked completed without a new payment')
   WHERE id = p_id;

  RETURN jsonb_build_object('status','completed','id',p_id,'amount',q.amount,'moved_money',false);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_proxy_commission_completed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_proxy_commission_completed(uuid, text) TO authenticated, service_role;