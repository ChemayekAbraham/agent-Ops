-- Agent Advance: one SMS per agent per day summarising credit-time and
-- withdrawal-time deductions.
--
-- BUILT 2026-09-30 -- NOT APPLIED. Needs the notify-advance-deduction edge
-- function deployed first (it gains a `daily_summary` mode).
--
-- THE GAP
-- -------
-- Two recovery paths take money from an agent's wallet and send no SMS:
--   * recover_agent_arrears_from_credit  (fires on every agent commission;
--     wallet leg "Missed advance repayment auto-recovered from new earning")
--   * the withdrawal-time collect        (wallet leg "Advance installment
--     collected before withdrawal")
-- Both write an in-app notification only. Ian Muhwezi had 10 such deductions on
-- 29 Sep (UGX 54,560) and no SMS. The daily cron and the 16:50 UTC sweep already
-- send their own SMS, so they are deliberately NOT counted here.
--
-- THE FIX
-- -------
-- send_daily_advance_deduction_summary() runs at 18:00 UTC (21:00 Kampala). It
-- sums the wallet-side legs of those two paths per agent since the previous run
-- (a rolling window, so deductions made after 21:00 land in the next SMS instead
-- of being dropped or counted twice) and asks notify-advance-deduction to send
-- ONE SMS. Nothing about any deduction, cap, balance or wallet movement changes.
--
-- Idempotency: advance_deduction_sms_summary_log is unique on (agent_id,
-- window_end); the window start is the latest window_end ever logged.

CREATE TABLE IF NOT EXISTS public.advance_deduction_sms_summary_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL,
  window_start timestamptz NOT NULL,
  window_end   timestamptz NOT NULL,
  amount       numeric NOT NULL,
  payments     integer NOT NULL,
  outstanding  numeric NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, window_end)
);
ALTER TABLE public.advance_deduction_sms_summary_log ENABLE ROW LEVEL SECURITY;
-- No policies: service role / SECURITY DEFINER only.

-- Window bookkeeping row, so an empty day still advances the window.
CREATE TABLE IF NOT EXISTS public.advance_deduction_sms_summary_runs (
  window_end   timestamptz PRIMARY KEY,
  window_start timestamptz NOT NULL,
  agents       integer NOT NULL DEFAULT 0
);
ALTER TABLE public.advance_deduction_sms_summary_runs ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.send_daily_advance_deduction_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_end     timestamptz := now();
  v_start   timestamptz;
  v_row     record;
  v_out     numeric;
  v_agents  integer := 0;
BEGIN
  SELECT COALESCE(max(window_end), v_end - interval '24 hours')
    INTO v_start
    FROM public.advance_deduction_sms_summary_runs;

  FOR v_row IN
    SELECT g.user_id AS agent_id,
           sum(g.amount)::numeric AS total,
           count(*)::int          AS payments
      FROM public.general_ledger g
     WHERE g.category = 'agent_repayment'
       AND g.direction = 'cash_out'
       AND g.ledger_scope = 'wallet'
       AND g.description IN (
             'Missed advance repayment auto-recovered from new earning',
             'Advance installment collected before withdrawal')
       AND g.created_at >  v_start
       AND g.created_at <= v_end
     GROUP BY g.user_id
    HAVING sum(g.amount) > 0
  LOOP
    BEGIN
      SELECT COALESCE(sum(outstanding_balance), 0) INTO v_out
        FROM public.agent_advances
       WHERE agent_id = v_row.agent_id
         AND status IN ('active', 'overdue');

      INSERT INTO public.advance_deduction_sms_summary_log
        (agent_id, window_start, window_end, amount, payments, outstanding)
      VALUES
        (v_row.agent_id, v_start, v_end, v_row.total, v_row.payments, v_out)
      ON CONFLICT (agent_id, window_end) DO NOTHING;

      IF FOUND THEN
        PERFORM net.http_post(
          url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/notify-advance-deduction',
          headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
          body := jsonb_build_object(
            'mode',        'daily_summary',
            'agent_id',    v_row.agent_id,
            'amount',      v_row.total,
            'payments',    v_row.payments,
            'outstanding', v_out,
            'source',      'advance_daily_deduction_summary'
          )
        );
        v_agents := v_agents + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One agent's failure must not stop the others.
      BEGIN
        INSERT INTO public.system_events (event_type, user_id, related_entity_type, metadata)
        VALUES ('advance_daily_sms_summary_failed', v_row.agent_id, 'agent_advance',
                jsonb_build_object('error', SQLERRM, 'amount', v_row.total));
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END;
  END LOOP;

  INSERT INTO public.advance_deduction_sms_summary_runs (window_end, window_start, agents)
  VALUES (v_end, v_start, v_agents);

  RETURN jsonb_build_object('window_start', v_start, 'window_end', v_end, 'agents', v_agents);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.send_daily_advance_deduction_summary() FROM PUBLIC, anon, authenticated;

-- 18:00 UTC = 21:00 Kampala. Unschedule/schedule from the migration, never
-- from inside the job itself.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'advance-deduction-daily-sms-summary') THEN
    PERFORM cron.unschedule('advance-deduction-daily-sms-summary');
  END IF;
  PERFORM cron.schedule(
    'advance-deduction-daily-sms-summary',
    '0 18 * * *',
    $$SELECT public.send_daily_advance_deduction_summary()$$
  );
END
$cron$;
