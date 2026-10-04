-- 1. New platform control: proxy agent withdrawal priority (default ON = current behaviour)
INSERT INTO public.treasury_controls (control_key, enabled)
VALUES ('proxy_payout_priority', true)
ON CONFLICT (control_key) DO NOTHING;

-- 2. Let every authenticated/anon client read this flag so the payout queue UI can
--    mirror exactly what the database enforces (merchant agents are not CFO/CTO).
DROP POLICY IF EXISTS "Public can read maintenance and payout flags" ON public.treasury_controls;
CREATE POLICY "Public can read maintenance and payout flags"
ON public.treasury_controls
FOR SELECT
TO anon, authenticated
USING (control_key = ANY (ARRAY[
  'maintenance_mode',
  'maintenance_message',
  'maintenance_until',
  'payouts_ui_enabled',
  'withdrawals_paused',
  'proxy_payout_priority'
]));

-- 3. The priority gate now honours the switch.
CREATE OR REPLACE FUNCTION public.assert_no_urgent_proxy_priority(p_withdrawal_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_priority text;
  v_block uuid;
  v_enforced boolean;
BEGIN
  -- CTO Platform Control: when the proxy priority switch is OFF, the queue is
  -- free and normal withdrawals may be claimed in any order.
  SELECT enabled INTO v_enforced
    FROM public.treasury_controls
   WHERE control_key = 'proxy_payout_priority';

  IF COALESCE(v_enforced, true) = false THEN
    RETURN NULL;
  END IF;

  SELECT priority_level INTO v_priority
    FROM public.withdrawal_requests WHERE id = p_withdrawal_id;

  -- The urgent proxy payout itself is always claimable.
  IF COALESCE(v_priority, '') = 'urgent_proxy' THEN
    RETURN NULL;
  END IF;

  SELECT w.id INTO v_block
    FROM public.withdrawal_requests w
   WHERE w.priority_level = 'urgent_proxy'
     AND w.assigned_cashout_agent_id IS NULL
     AND w.processed_at IS NULL
     AND w.fin_ops_reference IS NULL
     AND w.status IN ('pending','requested','manager_approved','cfo_approved','fin_ops_approved')
   ORDER BY w.created_at ASC
   LIMIT 1
   FOR UPDATE;

  RETURN v_block;
END;
$$;