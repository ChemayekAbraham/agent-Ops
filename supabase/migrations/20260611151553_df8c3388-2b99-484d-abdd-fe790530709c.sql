
-- In-app notification feed for recruiter override payouts
CREATE TABLE public.recruiter_override_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  recruiter_id uuid NOT NULL,
  sub_agent_id uuid,
  event_type text NOT NULL,
  source_table text,
  source_id text,
  label text,
  amount numeric NOT NULL DEFAULT 3000,
  status text NOT NULL DEFAULT 'credited',
  error_message text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  toast_seen_at timestamptz,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, UPDATE ON public.recruiter_override_events TO authenticated;
GRANT ALL ON public.recruiter_override_events TO service_role;

ALTER TABLE public.recruiter_override_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Recruiters view own override events"
  ON public.recruiter_override_events
  FOR SELECT
  TO authenticated
  USING (auth.uid() = recruiter_id);

CREATE POLICY "Recruiters update own override events"
  ON public.recruiter_override_events
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = recruiter_id)
  WITH CHECK (auth.uid() = recruiter_id);

-- One success record per verified item
CREATE UNIQUE INDEX uniq_recruiter_override_credited
  ON public.recruiter_override_events (event_type, source_id)
  WHERE status = 'credited';

CREATE INDEX idx_recruiter_override_recruiter_unseen
  ON public.recruiter_override_events (recruiter_id, toast_seen_at, occurred_at DESC);

ALTER TABLE public.recruiter_override_events REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.recruiter_override_events;

-- Update the override helper to log success / failure events for in-app toasts
CREATE OR REPLACE FUNCTION public.credit_recruiter_override(
  p_sub_agent_id uuid,
  p_event_type text,
  p_source_table text,
  p_source_id text,
  p_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_recruiter uuid;
  v_amount NUMERIC := 3000;
  v_idem TEXT;
  v_group_id uuid;
  v_desc TEXT;
BEGIN
  IF p_sub_agent_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_sub_agent');
  END IF;

  -- Find the agent who recruited this sub-agent
  SELECT parent_agent_id INTO v_recruiter
  FROM public.agent_subagents
  WHERE sub_agent_id = p_sub_agent_id
    AND status = 'verified'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_recruiter IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_recruiter');
  END IF;

  -- Never pay the recruiter for their own work
  IF v_recruiter = p_sub_agent_id THEN
    RETURN jsonb_build_object('status','skipped','reason','self');
  END IF;

  v_desc := 'UGX 3,000 recruiter override - ' || p_event_type ||
            COALESCE(' (' || p_label || ')', '');

  v_idem := 'recruiter_override:' || p_event_type || ':' || p_source_id;

  BEGIN
    v_group_id := public.create_ledger_transaction(
      jsonb_build_array(
        jsonb_build_object(
          'user_id', v_recruiter,
          'amount', v_amount,
          'direction', 'cash_in',
          'category', 'agent_commission',
          'ledger_scope', 'wallet',
          'recipient_type', 'user',
          'source_table', p_source_table,
          'source_id', p_source_id,
          'description', v_desc,
          'currency', 'UGX'
        ),
        jsonb_build_object(
          'user_id', v_recruiter,
          'amount', v_amount,
          'direction', 'cash_out',
          'category', 'marketing_expense',
          'ledger_scope', 'platform',
          'source_table', p_source_table,
          'source_id', p_source_id,
          'description', 'Platform expense: ' || v_desc,
          'currency', 'UGX'
        )
      ),
      v_idem
    );
  EXCEPTION WHEN OTHERS THEN
    -- Log a failure event so the recruiter sees a clear error toast
    INSERT INTO public.recruiter_override_events
      (recruiter_id, sub_agent_id, event_type, source_table, source_id, label, amount, status, error_message)
    VALUES
      (v_recruiter, p_sub_agent_id, p_event_type, p_source_table, p_source_id, p_label, v_amount, 'failed', SQLERRM);
    RETURN jsonb_build_object('status','error','recruiter_id',v_recruiter,'message',SQLERRM);
  END;

  -- Log the success event (idempotent on event_type + source_id)
  INSERT INTO public.recruiter_override_events
    (recruiter_id, sub_agent_id, event_type, source_table, source_id, label, amount, status)
  VALUES
    (v_recruiter, p_sub_agent_id, p_event_type, p_source_table, p_source_id, p_label, v_amount, 'credited')
  ON CONFLICT (event_type, source_id) WHERE (status = 'credited') DO NOTHING;

  RETURN jsonb_build_object('status','credited','recruiter_id',v_recruiter,'amount',v_amount,'group_id',v_group_id);
END;
$function$;
