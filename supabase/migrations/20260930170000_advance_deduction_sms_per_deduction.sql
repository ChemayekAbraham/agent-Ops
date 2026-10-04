-- Agent Advance: SMS on EVERY credit-time and withdrawal-time deduction.
--
-- Supersedes the once-a-day summary of 20260930150000 (doc 172): on 30 Sep the
-- CFO asked for an SMS on every deduction, after Ian Muhwezi's UGX 250,000
-- withdrawal-time collect arrived with no text.
--
-- Fires on the wallet-side leg of exactly the two paths that send no SMS today:
--   * recover_agent_arrears_from_credit  "Missed advance repayment auto-recovered from new earning"
--   * withdrawal-time collect            "Advance installment collected before withdrawal"
-- The 6-hourly cron and the 16:50 UTC sweep already SMS on their own and are
-- deliberately not matched, so no agent gets two texts for one deduction.
--
-- net.http_post is asynchronous and only sent when the transaction commits, so
-- a rolled-back deduction sends nothing, and the edge function reads the
-- balance after this deduction is in. A failure to queue the SMS is swallowed:
-- money movement must never depend on a message.
--
-- The daily summary cron is unscheduled so the same deduction is not texted
-- twice. send_daily_advance_deduction_summary() and its tables are kept.

CREATE OR REPLACE FUNCTION public.sms_advance_deduction_on_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM net.http_post(
      url := 'https://wirntoujqoyjobfhyelc.supabase.co/functions/v1/notify-advance-deduction',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8"}'::jsonb,
      body := jsonb_build_object(
        'mode',     'deduction',
        'agent_id', NEW.user_id,
        'amount',   NEW.amount,
        'source',   'advance_deduction_each'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.sms_advance_deduction_on_ledger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sms_advance_deduction ON public.general_ledger;
CREATE TRIGGER trg_sms_advance_deduction
  AFTER INSERT ON public.general_ledger
  FOR EACH ROW
  WHEN (NEW.category = 'agent_repayment'
        AND NEW.direction = 'cash_out'
        AND NEW.ledger_scope = 'wallet'
        AND NEW.user_id IS NOT NULL
        AND NEW.amount > 0
        AND NEW.description IN (
              'Missed advance repayment auto-recovered from new earning',
              'Advance installment collected before withdrawal'))
  EXECUTE FUNCTION public.sms_advance_deduction_on_ledger();

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'advance-deduction-daily-sms-summary') THEN
    PERFORM cron.unschedule('advance-deduction-daily-sms-summary');
  END IF;
END
$cron$;
