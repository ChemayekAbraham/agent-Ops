-- ============================================================================
-- Merchant Agent Real-Time Withdrawal Dispatch (Uber-style)
-- ============================================================================

-- 1. Online/Offline status for merchant (cash-out) agents.
--    Agents are ONLINE by default; only ONLINE + ACTIVE agents get dispatched.
ALTER TABLE public.cashout_agents
  ADD COLUMN IF NOT EXISTS is_online boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS online_changed_at timestamptz;

-- 2. Dispatch state on the withdrawal request itself.
ALTER TABLE public.withdrawal_requests
  ADD COLUMN IF NOT EXISTS dispatch_round integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dispatch_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispatch_claimed_by uuid,
  ADD COLUMN IF NOT EXISTS dispatch_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispatch_escalated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_dispatch_open
  ON public.withdrawal_requests (dispatch_expires_at)
  WHERE dispatch_claimed_by IS NULL;

-- 3. Enrich the notification log so it records the full audit trail:
--    channel (push/sms/email), per-agent response, dispatch round, claim/expiry.
ALTER TABLE public.withdrawal_notification_log
  ALTER COLUMN recipient_email DROP NOT NULL;

ALTER TABLE public.withdrawal_notification_log
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS recipient_phone text,
  ADD COLUMN IF NOT EXISTS response text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS dispatch_round integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_withdrawal_notif_log_recipient
  ON public.withdrawal_notification_log (recipient_id, created_at DESC);

-- Merchant agents can read their OWN dispatch notification rows (for history).
DROP POLICY IF EXISTS "Merchant agents read own dispatch notifications"
  ON public.withdrawal_notification_log;
CREATE POLICY "Merchant agents read own dispatch notifications"
  ON public.withdrawal_notification_log
  FOR SELECT
  TO authenticated
  USING (recipient_id = auth.uid());

-- 4. Realtime: surface dispatch + claim + notification changes live.
ALTER PUBLICATION supabase_realtime ADD TABLE public.withdrawal_notification_log;
ALTER PUBLICATION supabase_realtime ADD TABLE public.cashout_agents;

-- ============================================================================
-- RPCs
-- ============================================================================

-- Merchant sets their own Online/Offline availability.
CREATE OR REPLACE FUNCTION public.merchant_set_online(p_online boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_updated integer;
BEGIN
  UPDATE public.cashout_agents
     SET is_online = p_online,
         online_changed_at = now(),
         updated_at = now()
   WHERE agent_id = auth.uid();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- First eligible merchant to Accept atomically reserves the request.
-- Prevents two agents claiming the same withdrawal.
CREATE OR REPLACE FUNCTION public.accept_withdrawal_dispatch(p_withdrawal_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent_id uuid := auth.uid();
  v_row public.withdrawal_requests%ROWTYPE;
  v_open_statuses text[] := ARRAY['pending','requested','manager_approved','cfo_approved','fin_ops_approved'];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.cashout_agents
     WHERE agent_id = v_agent_id AND is_active = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_merchant_agent');
  END IF;

  SELECT * INTO v_row
    FROM public.withdrawal_requests
   WHERE id = p_withdrawal_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_row.dispatch_claimed_by IS NOT NULL AND v_row.dispatch_claimed_by <> v_agent_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_claimed');
  END IF;

  IF NOT (v_row.status = ANY (v_open_statuses)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_available', 'status', v_row.status);
  END IF;

  UPDATE public.withdrawal_requests
     SET dispatch_claimed_by = v_agent_id,
         dispatch_claimed_at = now(),
         assigned_cashout_agent_id = COALESCE(assigned_cashout_agent_id,
           (SELECT id FROM public.cashout_agents WHERE agent_id = v_agent_id LIMIT 1)),
         updated_at = now()
   WHERE id = p_withdrawal_id;

  -- Mark the accepting agent's log row.
  UPDATE public.withdrawal_notification_log
     SET response = 'accepted', claimed_at = now(), updated_at = now()
   WHERE withdrawal_id = p_withdrawal_id AND recipient_id = v_agent_id;

  -- Every other still-pending notification is now superseded.
  UPDATE public.withdrawal_notification_log
     SET response = 'superseded', claimed_at = now(), updated_at = now()
   WHERE withdrawal_id = p_withdrawal_id
     AND recipient_id <> v_agent_id
     AND response = 'pending';

  RETURN jsonb_build_object('ok', true, 'withdrawal_id', p_withdrawal_id);
END;
$$;

-- An agent explicitly dismisses (Ignore) a dispatch — recorded for the audit trail.
CREATE OR REPLACE FUNCTION public.ignore_withdrawal_dispatch(p_withdrawal_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_updated integer;
BEGIN
  UPDATE public.withdrawal_notification_log
     SET response = 'ignored', updated_at = now()
   WHERE withdrawal_id = p_withdrawal_id
     AND recipient_id = auth.uid()
     AND response = 'pending';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.merchant_set_online(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_withdrawal_dispatch(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ignore_withdrawal_dispatch(uuid) TO authenticated;