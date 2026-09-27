-- Agent Advance recovery: make the deduction notification actually reach the agent.
--
-- PROPOSED -- NOT APPLIED. Review before this is run against production.
--
-- THE GAP
-- -------
-- `notify_agent_advance_deducted` is an AFTER INSERT trigger on
-- `agent_advance_ledger` that fires on every row with amount_deducted > 0, so
-- it already covers all three recovery paths plus the daily cron and voluntary
-- repayment. It builds a correct message. It has never delivered one.
--
-- It inserts with `type` = 'success' or 'info'. `block_all_notification_inserts`
-- is a BEFORE INSERT trigger on `notifications` that RETURNS NULL -- silently,
-- with no error -- for any type outside its allowlist:
--
--   merchandise_recovery, director_requisition, advance_arrears, budget,
--   staff_requisition, hr_birthday, rd_alert, lending_repayment
--
-- 'success' and 'info' are not on it. Measured in production:
--
--   agent_advance_ledger rows with amount_deducted > 0 ......... 3,524
--   notifications with metadata->>'event' = 'advance_deducted' ..... 0
--
-- Probed directly (rolled back): inserting type 'info' -> 0 rows,
-- type 'success' -> 0 rows, type 'advance_arrears' -> 1 row.
--
-- Per-path behaviour before this change:
--   recover_agent_arrears_from_credit  in-app only, one aggregate message per
--                                      credit event, type 'advance_arrears'
--                                      (allowed, 903 delivered). Carries the
--                                      amount only -- no balance, no advance
--                                      reference, no timestamp.
--   sweep_agent_advance_recovery       SMS only, via net.http_post to the
--                                      notify-advance-deduction edge function.
--                                      Amount + outstanding, but the outstanding
--                                      it quotes is read from the agent's OLDEST
--                                      open advance, which need not be the one
--                                      deducted. No advance reference, no time.
--   apply_roi_advance_recovery         nothing at all. No in-app, no SMS.
--
-- THE FIX
-- -------
-- One change to the trigger function that already runs on all paths. Only the
-- notification is touched: no calculation, cap, eligibility rule, wallet
-- movement or deduction amount changes anywhere.
--
--   * type becomes 'advance_arrears' so the row survives the allowlist.
--   * The message states the amount, that it went to Agent Advance arrears, the
--     remaining balance, the advance reference and the date and time.
--   * Remaining balance is taken from NEW.closing_balance, NOT from
--     agent_advances. Verified in production (rolled back): under the corrected
--     write order the daybook row is inserted BEFORE the advance row is
--     updated, so at AFTER INSERT time agent_advances still holds the
--     pre-payment figures -- outstanding read as 2,105,165.48 when the true
--     post-deduction balance was 2,080,165.48. NEW.closing_balance is correct
--     on every path.
--   * A duplicate guard keyed on the daybook row id.
--
-- Fires only on a committed deduction: the trigger runs inside the same
-- transaction as the deduction, so if any step fails -- guard rejection,
-- solvency, mapped balance -- the notification is discarded with everything
-- else. Nothing is emitted for a failed or rolled-back deduction.
--
-- The insert is wrapped so a notification failure can never abort a deduction.
-- Money movement must not depend on a message being written.
--
-- SCOPE NOTE, PLEASE READ
-- -----------------------
-- This trigger is global to `agent_advance_ledger`, so the fix also switches on
-- in-app notifications for the daily cron and voluntary repayment, not just the
-- three recovery paths. Those two already send their own SMS from their edge
-- functions, so their agents would get SMS plus a new in-app entry. There is no
-- way to scope this by path: `recovery_source` is 'wallet_daily' for both the
-- cron and the credit-time intercept, so the two cannot be told apart.
-- If that wider reach is not wanted, say so and this needs a different shape.

CREATE OR REPLACE FUNCTION public.notify_agent_advance_deducted()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id uuid;
  v_ref      text;
  v_when     text;
BEGIN
  IF NEW.amount_deducted IS NULL OR NEW.amount_deducted <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT agent_id INTO v_agent_id FROM public.agent_advances WHERE id = NEW.advance_id;
  IF v_agent_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- One notification per daybook row, never two.
  IF EXISTS (
    SELECT 1 FROM public.notifications
     WHERE user_id = v_agent_id
       AND metadata->>'daybook_id' = NEW.id::text
  ) THEN
    RETURN NEW;
  END IF;

  v_ref  := upper(substr(replace(NEW.advance_id::text, '-', ''), 1, 8));
  v_when := to_char(timezone('Africa/Kampala', now()), 'DD Mon YYYY HH24:MI');

  -- A notification must never be able to abort a deduction.
  BEGIN
    INSERT INTO public.notifications (user_id, title, message, type, metadata)
    VALUES (
      v_agent_id,
      'Advance arrears deduction',
      'UGX ' || to_char(NEW.amount_deducted, 'FM999,999,990') ||
      ' was deducted from your wallet on ' || v_when ||
      ' and applied to your Agent Advance arrears (ref ' || v_ref || '). ' ||
      'Remaining advance balance: UGX ' || to_char(NEW.closing_balance, 'FM999,999,990') || '.',
      'advance_arrears',
      jsonb_build_object(
        'event',            'advance_deducted',
        'daybook_id',       NEW.id,
        'advance_id',       NEW.advance_id,
        'advance_ref',      v_ref,
        'amount_deducted',  NEW.amount_deducted,
        'opening_balance',  NEW.opening_balance,
        'closing_balance',  NEW.closing_balance,
        'deduction_status', NEW.deduction_status,
        'recovery_source',  NEW.recovery_source,
        'deducted_at',      timezone('Africa/Kampala', now()),
        'send_push',        true
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$function$;
