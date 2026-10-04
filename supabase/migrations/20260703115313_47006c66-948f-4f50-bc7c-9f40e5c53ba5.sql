
-- 1. Add freeze scope to agent blocks
ALTER TABLE public.agent_listing_blocks
  ADD COLUMN IF NOT EXISTS freeze_scope text NOT NULL DEFAULT 'listing';

ALTER TABLE public.agent_listing_blocks
  DROP CONSTRAINT IF EXISTS agent_listing_blocks_freeze_scope_check;
ALTER TABLE public.agent_listing_blocks
  ADD CONSTRAINT agent_listing_blocks_freeze_scope_check
  CHECK (freeze_scope IN ('listing', 'all'));

-- 2. Helper: is this agent under a FULL activity freeze right now?
CREATE OR REPLACE FUNCTION public.is_agent_frozen(p_agent_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agent_listing_blocks
    WHERE agent_id = p_agent_id
      AND active
      AND freeze_scope = 'all'
      AND blocked_until > now()
  );
$$;

-- 3. Recreate block RPC with an optional scope argument
DROP FUNCTION IF EXISTS public.block_agent_listing(uuid, text, integer);
CREATE OR REPLACE FUNCTION public.block_agent_listing(
  p_agent_id uuid,
  p_reason text,
  p_days integer DEFAULT 2,
  p_scope text DEFAULT 'listing'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_block_id uuid;
  v_until timestamptz;
  v_scope text := lower(coalesce(p_scope, 'listing'));
  v_title text;
  v_msg_prefix text;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_landlord_ops(v_caller) THEN
    RAISE EXCEPTION 'Not authorized to block agents';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Block reason must be at least 10 characters';
  END IF;
  IF p_agent_id IS NULL THEN RAISE EXCEPTION 'Agent is required'; END IF;
  IF v_scope NOT IN ('listing', 'all') THEN v_scope := 'listing'; END IF;

  v_until := now() + make_interval(days => GREATEST(COALESCE(p_days, 2), 1));

  UPDATE public.agent_listing_blocks
     SET active = false, updated_at = now()
   WHERE agent_id = p_agent_id AND active;

  INSERT INTO public.agent_listing_blocks (agent_id, blocked_until, reason, auto_blocked, blocked_by, freeze_scope)
  VALUES (p_agent_id, v_until, trim(p_reason), false, v_caller, v_scope)
  RETURNING id INTO v_block_id;

  IF v_scope = 'all' THEN
    v_title := '🚫 Account frozen';
    v_msg_prefix := 'Your account has been frozen. No agent activities can take place until ';
  ELSE
    v_title := '🚫 House posting blocked';
    v_msg_prefix := 'You have been blocked from posting houses until ';
  END IF;

  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  VALUES (
    p_agent_id,
    v_title,
    v_msg_prefix || to_char(v_until, 'Mon DD, YYYY HH24:MI') || '. Reason: ' || trim(p_reason),
    'warning',
    jsonb_build_object('action', 'listing_block', 'freeze_scope', v_scope, 'blocked_until', v_until, 'reason', trim(p_reason))
  );

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_caller, 'agent_listing_blocked', 'agent_listing_blocks', v_block_id::text,
    jsonb_build_object('agent_id', p_agent_id, 'reason', trim(p_reason), 'freeze_scope', v_scope, 'blocked_until', v_until));

  RETURN jsonb_build_object('ok', true, 'block_id', v_block_id, 'blocked_until', v_until, 'freeze_scope', v_scope);
END;
$function$;

-- 4. Update self-read to expose scope
CREATE OR REPLACE FUNCTION public.get_my_listing_block()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    'rejection_count', v_block.rejection_count,
    'freeze_scope', v_block.freeze_scope
  );
END;
$function$;

-- 5. Full-freeze enforcement trigger for all agent activity tables
CREATE OR REPLACE FUNCTION public.enforce_agent_full_freeze()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_block record;
BEGIN
  IF NEW.agent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT blocked_until, reason INTO v_block
  FROM public.agent_listing_blocks
  WHERE agent_id = NEW.agent_id
    AND active
    AND freeze_scope = 'all'
    AND blocked_until > now()
  ORDER BY blocked_until DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'AGENT_ACCOUNT_FROZEN: % (until %)', v_block.reason, to_char(v_block.blocked_until, 'Mon DD, YYYY HH24:MI');
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_agent_full_freeze ON public.agent_collections;
CREATE TRIGGER trg_enforce_agent_full_freeze BEFORE INSERT ON public.agent_collections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_full_freeze();

DROP TRIGGER IF EXISTS trg_enforce_agent_full_freeze ON public.field_collections;
CREATE TRIGGER trg_enforce_agent_full_freeze BEFORE INSERT ON public.field_collections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_full_freeze();

DROP TRIGGER IF EXISTS trg_enforce_agent_full_freeze ON public.agent_visits;
CREATE TRIGGER trg_enforce_agent_full_freeze BEFORE INSERT ON public.agent_visits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_full_freeze();

DROP TRIGGER IF EXISTS trg_enforce_agent_full_freeze ON public.agent_receipts;
CREATE TRIGGER trg_enforce_agent_full_freeze BEFORE INSERT ON public.agent_receipts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_full_freeze();

DROP TRIGGER IF EXISTS trg_enforce_agent_full_freeze ON public.agent_tasks;
CREATE TRIGGER trg_enforce_agent_full_freeze BEFORE INSERT ON public.agent_tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_full_freeze();

DROP TRIGGER IF EXISTS trg_enforce_agent_full_freeze ON public.offline_collection_submissions;
CREATE TRIGGER trg_enforce_agent_full_freeze BEFORE INSERT ON public.offline_collection_submissions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_full_freeze();

DROP TRIGGER IF EXISTS trg_enforce_agent_full_freeze ON public.property_viewings;
CREATE TRIGGER trg_enforce_agent_full_freeze BEFORE INSERT ON public.property_viewings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_full_freeze();
