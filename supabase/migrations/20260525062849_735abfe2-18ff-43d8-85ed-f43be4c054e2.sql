CREATE OR REPLACE FUNCTION public.tr_detect_agent_unblock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_elig         record;
  v_today        date;
  v_event_id     uuid;
  v_paid         numeric;
  v_expected     numeric;
  v_active       integer;
  v_pct          numeric;
  v_supabase_url text := 'https://wirntoujqoyjobfhyelc.supabase.co';
  v_service_key  text;
BEGIN
  v_today := ((now() AT TIME ZONE 'Africa/Kampala'))::date;

  IF EXISTS (
    SELECT 1 FROM public.agent_eligibility_unblock_events
    WHERE agent_id = NEW.agent_id AND kampala_day = v_today
  ) THEN
    RETURN NEW;
  END IF;

  SELECT
    COALESCE(active_count, 0)        AS active_count,
    COALESCE(expected_daily, 0)      AS expected_daily,
    COALESCE(paid_today, 0)          AS paid_today,
    COALESCE(effective_pct, 0)       AS effective_pct
  INTO v_elig
  FROM public.get_agent_daily_eligibility(ARRAY[NEW.agent_id]::uuid[])
  LIMIT 1;

  -- Normalise so a NULL row (no eligibility data) becomes safe zeros
  v_active   := COALESCE(v_elig.active_count, 0);
  v_expected := COALESCE(v_elig.expected_daily, 0);
  v_paid     := COALESCE(v_elig.paid_today, 0);
  v_pct      := COALESCE(v_elig.effective_pct, 0);

  -- Only fire on the threshold crossing: must be >= 20% AND have active rents
  IF v_active <= 0 OR v_pct < 0.20 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.agent_eligibility_unblock_events (
    agent_id, kampala_day, paid_today, expected_daily,
    ratio_pct, active_count, trigger_collection_id
  ) VALUES (
    NEW.agent_id, v_today, v_paid, v_expected,
    ROUND(v_pct * 100, 2), v_active, NEW.id
  )
  ON CONFLICT (agent_id, kampala_day) DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    INSERT INTO public.system_events (event_name, payload)
    VALUES (
      'agent.eligibility.unblocked',
      jsonb_build_object(
        'agent_id',       NEW.agent_id,
        'event_id',       v_event_id,
        'kampala_day',    v_today,
        'paid_today',     v_paid,
        'expected_daily', v_expected,
        'ratio_pct',      ROUND(v_pct * 100, 2),
        'active_count',   v_active,
        'threshold_pct',  20
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[tr_detect_agent_unblock] system_events insert failed: %', SQLERRM;
  END;

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
          'paid_today',     v_paid,
          'expected_daily', v_expected,
          'ratio_pct',      ROUND(v_pct * 100, 2),
          'active_count',   v_active
        )
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[tr_detect_agent_unblock] pg_net dispatch failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$function$;