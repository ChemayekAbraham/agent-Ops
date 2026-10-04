-- 1. Unblock events table
CREATE TABLE IF NOT EXISTS public.agent_eligibility_unblock_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  kampala_day     date NOT NULL,
  paid_today      numeric NOT NULL,
  expected_daily  numeric NOT NULL,
  ratio_pct       numeric NOT NULL,
  active_count    integer NOT NULL,
  trigger_collection_id uuid NULL,
  sms_sent        boolean NOT NULL DEFAULT false,
  sms_sent_at     timestamptz NULL,
  toast_seen_at   timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, kampala_day)
);

CREATE INDEX IF NOT EXISTS idx_unblock_events_agent_day
  ON public.agent_eligibility_unblock_events (agent_id, kampala_day DESC);

ALTER TABLE public.agent_eligibility_unblock_events ENABLE ROW LEVEL SECURITY;

-- Agents see their own
CREATE POLICY "Agents view own unblock events"
ON public.agent_eligibility_unblock_events
FOR SELECT TO authenticated
USING (agent_id = auth.uid());

-- Agents may mark their own toast as seen
CREATE POLICY "Agents update own toast_seen"
ON public.agent_eligibility_unblock_events
FOR UPDATE TO authenticated
USING (agent_id = auth.uid())
WITH CHECK (agent_id = auth.uid());

-- Staff (manager / super_admin / coo) see all
CREATE POLICY "Staff view all unblock events"
ON public.agent_eligibility_unblock_events
FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'manager')
  OR public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'coo')
);

-- 2. Trigger function — fires after every agent_collections insert
CREATE OR REPLACE FUNCTION public.tr_detect_agent_unblock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_elig         record;
  v_today        date;
  v_event_id     uuid;
  v_supabase_url text := 'https://wirntoujqoyjobfhyelc.supabase.co';
  v_service_key  text;
BEGIN
  -- Today in Africa/Kampala
  v_today := ((now() AT TIME ZONE 'Africa/Kampala'))::date;

  -- Skip if we already recorded an unblock for this agent today
  IF EXISTS (
    SELECT 1 FROM public.agent_eligibility_unblock_events
    WHERE agent_id = NEW.agent_id AND kampala_day = v_today
  ) THEN
    RETURN NEW;
  END IF;

  -- Recompute today's eligibility from the authoritative RPC
  SELECT
    COALESCE(active_count, 0)        AS active_count,
    COALESCE(expected_daily, 0)      AS expected_daily,
    COALESCE(paid_today, 0)          AS paid_today,
    COALESCE(effective_pct, 0)       AS effective_pct
  INTO v_elig
  FROM public.get_agent_daily_eligibility(ARRAY[NEW.agent_id]::uuid[])
  LIMIT 1;

  -- Only fire on the threshold crossing: must be >= 20% AND have active rents
  IF v_elig.active_count <= 0 OR v_elig.effective_pct < 0.20 THEN
    RETURN NEW;
  END IF;

  -- Insert the event row (UNIQUE guards against trigger races)
  INSERT INTO public.agent_eligibility_unblock_events (
    agent_id, kampala_day, paid_today, expected_daily,
    ratio_pct, active_count, trigger_collection_id
  ) VALUES (
    NEW.agent_id, v_today, v_elig.paid_today, v_elig.expected_daily,
    ROUND(v_elig.effective_pct * 100, 2), v_elig.active_count, NEW.id
  )
  ON CONFLICT (agent_id, kampala_day) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Emit a system_event for downstream consumers
  BEGIN
    INSERT INTO public.system_events (event_name, payload)
    VALUES (
      'agent.eligibility.unblocked',
      jsonb_build_object(
        'agent_id',       NEW.agent_id,
        'event_id',       v_event_id,
        'kampala_day',    v_today,
        'paid_today',     v_elig.paid_today,
        'expected_daily', v_elig.expected_daily,
        'ratio_pct',      ROUND(v_elig.effective_pct * 100, 2),
        'active_count',   v_elig.active_count,
        'threshold_pct',  20
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[tr_detect_agent_unblock] system_events insert failed: %', SQLERRM;
  END;

  -- Fire the SMS edge function via pg_net (fire-and-forget)
  BEGIN
    SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

    IF v_service_key IS NOT NULL THEN
      PERFORM net.http_post(
        url     := v_supabase_url || '/functions/v1/notify-agent-unblocked',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body    := jsonb_build_object(
          'event_id',       v_event_id,
          'agent_id',       NEW.agent_id,
          'paid_today',     v_elig.paid_today,
          'expected_daily', v_elig.expected_daily,
          'ratio_pct',      ROUND(v_elig.effective_pct * 100, 2),
          'active_count',   v_elig.active_count
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[tr_detect_agent_unblock] pg_net dispatch failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_detect_agent_unblock ON public.agent_collections;
CREATE TRIGGER trg_detect_agent_unblock
AFTER INSERT ON public.agent_collections
FOR EACH ROW
EXECUTE FUNCTION public.tr_detect_agent_unblock();