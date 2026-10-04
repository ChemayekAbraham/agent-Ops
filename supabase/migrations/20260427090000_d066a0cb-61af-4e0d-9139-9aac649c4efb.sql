-- Atomic listing rejection RPC: updates status, logs audit, and notifies the agent.
-- SECURITY DEFINER bypasses block_all_notification_inserts trigger, matching the existing notify_* function pattern.

CREATE OR REPLACE FUNCTION public.reject_house_listing(
  p_listing_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_listing record;
  v_caller_name text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Authorization: Landlord Ops staff
  IF NOT (
    public.has_role(v_caller, 'super_admin'::app_role)
    OR public.has_role(v_caller, 'ceo'::app_role)
    OR public.has_role(v_caller, 'cto'::app_role)
    OR public.has_role(v_caller, 'manager'::app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to reject listings';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Rejection reason must be at least 10 characters';
  END IF;

  -- Lock the listing row
  SELECT id, title, agent_id, status
    INTO v_listing
    FROM public.house_listings
   WHERE id = p_listing_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Listing not found';
  END IF;

  IF v_listing.status = 'rejected' THEN
    RETURN jsonb_build_object('ok', true, 'already_rejected', true);
  END IF;

  -- Update listing status
  UPDATE public.house_listings
     SET status = 'rejected'
   WHERE id = p_listing_id;

  -- Resolve caller display name (best effort)
  SELECT COALESCE(full_name, 'Landlord Ops')
    INTO v_caller_name
    FROM public.profiles
   WHERE id = v_caller;

  -- Audit log (caller-attributed)
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_caller,
    'listing_rejected',
    'house_listings',
    p_listing_id::text,
    jsonb_build_object(
      'listing_title', v_listing.title,
      'reason', trim(p_reason),
      'rejected_by_name', v_caller_name
    )
  );

  -- Notify the listing agent (if any)
  IF v_listing.agent_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      v_listing.agent_id,
      '🚫 Listing Rejected',
      'Your listing "' || COALESCE(v_listing.title, 'Untitled') ||
        '" was rejected by ' || COALESCE(v_caller_name, 'Landlord Ops') ||
        '. Reason: ' || trim(p_reason),
      'warning',
      jsonb_build_object(
        'listing_id', v_listing.id,
        'listing_title', v_listing.title,
        'reason', trim(p_reason),
        'rejected_by', v_caller,
        'rejected_by_name', v_caller_name,
        'action', 'listing_rejected'
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'listing_id', v_listing.id,
    'agent_notified', v_listing.agent_id IS NOT NULL
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_house_listing(uuid, text) TO authenticated;

-- Ensure realtime delivery for the agent notification bell
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'notifications'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications';
  END IF;
END $$;