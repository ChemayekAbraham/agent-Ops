
-- Helper: is this user a landlord-ops operator (admins or staff granted the dashboard)?
CREATE OR REPLACE FUNCTION public.is_landlord_ops(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_role(_user_id, 'super_admin'::app_role)
    OR public.has_role(_user_id, 'ceo'::app_role)
    OR public.has_role(_user_id, 'cto'::app_role)
    OR public.has_role(_user_id, 'manager'::app_role)
    OR EXISTS (
      SELECT 1 FROM public.staff_permissions
      WHERE user_id = _user_id AND permitted_dashboard = 'landlord-ops'
    );
$$;

-- ─── Rejections log ───
CREATE TABLE public.agent_listing_rejections (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid NOT NULL,
  listing_id uuid,
  reason text NOT NULL,
  rejected_by uuid,
  rejected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_listing_rejections_agent ON public.agent_listing_rejections(agent_id, rejected_at DESC);

GRANT SELECT ON public.agent_listing_rejections TO authenticated;
GRANT ALL ON public.agent_listing_rejections TO service_role;
ALTER TABLE public.agent_listing_rejections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents read own rejections"
  ON public.agent_listing_rejections FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid() OR public.is_landlord_ops(auth.uid()));

-- ─── Blocks ───
CREATE TABLE public.agent_listing_blocks (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id uuid NOT NULL,
  blocked_until timestamptz NOT NULL,
  reason text NOT NULL,
  auto_blocked boolean NOT NULL DEFAULT false,
  rejection_count integer,
  active boolean NOT NULL DEFAULT true,
  blocked_by uuid,
  unblocked_at timestamptz,
  unblocked_by uuid,
  unblock_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_listing_blocks_agent ON public.agent_listing_blocks(agent_id, created_at DESC);
CREATE INDEX idx_agent_listing_blocks_active ON public.agent_listing_blocks(agent_id) WHERE active;

GRANT SELECT ON public.agent_listing_blocks TO authenticated;
GRANT ALL ON public.agent_listing_blocks TO service_role;
ALTER TABLE public.agent_listing_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents read own blocks"
  ON public.agent_listing_blocks FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid() OR public.is_landlord_ops(auth.uid()));

CREATE TRIGGER trg_agent_listing_blocks_updated_at
  BEFORE UPDATE ON public.agent_listing_blocks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── Read my active block (for the agent's listing dialog) ───
CREATE OR REPLACE FUNCTION public.get_my_listing_block()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_block record;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  SELECT * INTO v_block
  FROM public.agent_listing_blocks
  WHERE agent_id = v_uid AND active AND blocked_until > now()
  ORDER BY blocked_until DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('blocked', false);
  END IF;

  RETURN jsonb_build_object(
    'blocked', true,
    'blocked_until', v_block.blocked_until,
    'reason', v_block.reason,
    'auto_blocked', v_block.auto_blocked,
    'rejection_count', v_block.rejection_count
  );
END;
$$;

-- ─── Manual block (landlord-ops / admin) ───
CREATE OR REPLACE FUNCTION public.block_agent_listing(p_agent_id uuid, p_reason text, p_days integer DEFAULT 2)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_block_id uuid;
  v_until timestamptz;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_landlord_ops(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to block agents';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Block reason must be at least 10 characters';
  END IF;
  IF p_agent_id IS NULL THEN RAISE EXCEPTION 'Agent is required'; END IF;

  v_until := now() + make_interval(days => GREATEST(COALESCE(p_days, 2), 1));

  -- Deactivate any existing active blocks, then create a fresh one.
  UPDATE public.agent_listing_blocks
     SET active = false, updated_at = now()
   WHERE agent_id = p_agent_id AND active;

  INSERT INTO public.agent_listing_blocks (agent_id, blocked_until, reason, auto_blocked, blocked_by)
  VALUES (p_agent_id, v_until, trim(p_reason), false, v_caller)
  RETURNING id INTO v_block_id;

  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  VALUES (
    p_agent_id,
    '🚫 House posting blocked',
    'You have been blocked from posting houses until ' || to_char(v_until, 'Mon DD, YYYY HH24:MI') ||
      '. Reason: ' || trim(p_reason),
    'warning',
    jsonb_build_object('action', 'listing_block', 'blocked_until', v_until, 'reason', trim(p_reason))
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'agent_listing_blocked', 'agent_listing_blocks', v_block_id::text,
    jsonb_build_object('agent_id', p_agent_id, 'reason', trim(p_reason), 'blocked_until', v_until));

  RETURN jsonb_build_object('ok', true, 'block_id', v_block_id, 'blocked_until', v_until);
END;
$$;

-- ─── Manual unblock (landlord-ops / admin) ───
CREATE OR REPLACE FUNCTION public.unblock_agent_listing(p_agent_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_count integer;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_landlord_ops(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to unblock agents';
  END IF;
  IF p_agent_id IS NULL THEN RAISE EXCEPTION 'Agent is required'; END IF;

  UPDATE public.agent_listing_blocks
     SET active = false,
         unblocked_at = now(),
         unblocked_by = v_caller,
         unblock_reason = NULLIF(trim(COALESCE(p_reason, '')), ''),
         updated_at = now()
   WHERE agent_id = p_agent_id AND active;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      p_agent_id,
      '✅ House posting unblocked',
      'You can post houses again.' ||
        CASE WHEN NULLIF(trim(COALESCE(p_reason, '')), '') IS NOT NULL THEN ' Note: ' || trim(p_reason) ELSE '' END,
      'success',
      jsonb_build_object('action', 'listing_unblock', 'reason', p_reason)
    );

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
    VALUES (v_caller, 'agent_listing_unblocked', 'agent_listing_blocks', p_agent_id::text,
      jsonb_build_object('agent_id', p_agent_id, 'reason', p_reason));
  END IF;

  RETURN jsonb_build_object('ok', true, 'unblocked', v_count > 0);
END;
$$;

-- ─── Recreate reject_house_listing with rejection logging + auto-block ───
CREATE OR REPLACE FUNCTION public.reject_house_listing(p_listing_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_listing record;
  v_caller_name text;
  v_last_block_at timestamptz;
  v_rej_count integer;
  v_until timestamptz;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT public.is_landlord_ops(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to reject listings';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Rejection reason must be at least 10 characters';
  END IF;

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

  UPDATE public.house_listings
     SET status = 'rejected'
   WHERE id = p_listing_id;

  SELECT COALESCE(full_name, 'Landlord Ops')
    INTO v_caller_name
    FROM public.profiles
   WHERE id = v_caller;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (
    v_caller, 'listing_rejected', 'house_listings', p_listing_id::text,
    jsonb_build_object('listing_title', v_listing.title, 'reason', trim(p_reason), 'rejected_by_name', v_caller_name)
  );

  IF v_listing.agent_id IS NOT NULL THEN
    -- Notify agent of rejection
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      v_listing.agent_id,
      '🚫 Listing Rejected',
      'Your listing "' || COALESCE(v_listing.title, 'Untitled') ||
        '" was rejected by ' || COALESCE(v_caller_name, 'Landlord Ops') ||
        '. Reason: ' || trim(p_reason),
      'warning',
      jsonb_build_object(
        'listing_id', v_listing.id, 'listing_title', v_listing.title, 'reason', trim(p_reason),
        'rejected_by', v_caller, 'rejected_by_name', v_caller_name, 'action', 'listing_rejected'
      )
    );

    -- Log the rejection for the 3-strike counter
    INSERT INTO public.agent_listing_rejections (agent_id, listing_id, reason, rejected_by)
    VALUES (v_listing.agent_id, p_listing_id, trim(p_reason), v_caller);

    -- Count rejections since the agent's most recent block (resets each block)
    SELECT created_at INTO v_last_block_at
    FROM public.agent_listing_blocks
    WHERE agent_id = v_listing.agent_id
    ORDER BY created_at DESC
    LIMIT 1;

    SELECT count(*) INTO v_rej_count
    FROM public.agent_listing_rejections
    WHERE agent_id = v_listing.agent_id
      AND rejected_at > COALESCE(v_last_block_at, '-infinity'::timestamptz);

    -- Auto-block on the 3rd rejection if not already actively blocked
    IF v_rej_count >= 3 AND NOT EXISTS (
        SELECT 1 FROM public.agent_listing_blocks
        WHERE agent_id = v_listing.agent_id AND active AND blocked_until > now()
    ) THEN
      v_until := now() + interval '2 days';
      INSERT INTO public.agent_listing_blocks (agent_id, blocked_until, reason, auto_blocked, rejection_count)
      VALUES (
        v_listing.agent_id, v_until,
        'You have been blocked from posting houses for 2 days because 3 of your listings were rejected. Most recent reason: ' || trim(p_reason),
        true, v_rej_count
      );

      INSERT INTO public.notifications (user_id, title, message, type, metadata)
      VALUES (
        v_listing.agent_id,
        '🚫 House posting blocked (3 rejections)',
        'You have been blocked from posting houses until ' || to_char(v_until, 'Mon DD, YYYY HH24:MI') ||
          ' because 3 of your listings were rejected. Most recent reason: ' || trim(p_reason),
        'warning',
        jsonb_build_object('action', 'listing_block', 'blocked_until', v_until, 'auto_blocked', true)
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'listing_id', v_listing.id,
    'agent_notified', v_listing.agent_id IS NOT NULL,
    'rejection_count', v_rej_count,
    'auto_blocked', (v_until IS NOT NULL)
  );
END;
$function$;

-- ─── Enforce block on new listings (server-side backstop) ───
CREATE OR REPLACE FUNCTION public.enforce_agent_listing_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_block record;
BEGIN
  IF NEW.agent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT blocked_until, reason INTO v_block
  FROM public.agent_listing_blocks
  WHERE agent_id = NEW.agent_id AND active AND blocked_until > now()
  ORDER BY blocked_until DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'AGENT_LISTING_BLOCKED: % (until %)', v_block.reason, to_char(v_block.blocked_until, 'Mon DD, YYYY HH24:MI');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_agent_listing_block
  BEFORE INSERT ON public.house_listings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_listing_block();
