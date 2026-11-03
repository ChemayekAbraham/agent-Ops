-- Gmail receipt INSERTs were aborted by statement_timeout (57014) while
-- trg_gmail_tx_auto_create_deposit waited on row locks held by the
-- email-auto-create-deposits-24h cron. That cron runs
-- auto_create_deposits_from_gmail(336) every 2 minutes. The trigger runs
-- auto_create_deposits_from_gmail(24) on every inbound receipt, in the
-- same transaction as the INSERT. Both paths lock gmail_transactions
-- (FOR UPDATE inside auto_record_merchant_float_return).
--
-- query_canceled is not caught by EXCEPTION WHEN OTHERS, so an 8s
-- statement timeout rolled the receipt back and the MoMo deposit email
-- was never stored. lock_not_available (55P03) is caught.
--
-- This migration only replaces two functions. It does not reattach the
-- trigger, change its WHEN predicates, or touch grants. CREATE OR REPLACE
-- keeps SECURITY DEFINER, search_path, ownership, and the existing
-- EXECUTE grants. auto_create_deposits_from_gmail_impl and
-- auto_record_merchant_float_return are unchanged.
--
-- The trigger still attempts the 24h sync, but it cannot block the INSERT:
--   * pg_try_advisory_xact_lock skips the sync when a scan already holds
--     the key. The cron retries within 2 minutes.
--   * lock_timeout is set to 1000ms for the sync call only, then restored
--     to whatever current_setting('lock_timeout') was, so a row-lock wait
--     becomes a catchable 55P03 and later triggers on this INSERT keep
--     the session lock_timeout.
-- The wrapper takes the same advisory key so the cron and the trigger
-- share one scan instead of locking the same rows against each other.
-- A second try_lock in the same transaction (trigger, then wrapper)
-- succeeds; advisory xact locks do not stack.

CREATE OR REPLACE FUNCTION public.trg_gmail_tx_auto_create_deposit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_prev_lock_timeout text;
begin
  if new.linked_deposit_request_id is null
     and new.parsed = true
     and new.amount is not null and new.amount > 0
     and new.transaction_id is not null
     and new.direction in ('in','credit') then
    if pg_try_advisory_xact_lock(hashtext('auto_create_deposits_from_gmail')) then
      v_prev_lock_timeout := current_setting('lock_timeout');
      perform set_config('lock_timeout', '1000ms', true);
      begin
        perform public.auto_create_deposits_from_gmail(24);
      exception when others then
        raise warning 'auto_create_deposits_from_gmail deferred to cron: %', sqlerrm;
      end;
      -- Restore even after a caught lock timeout. SET LOCAL would otherwise
      -- stay in force for the rest of this INSERT, including later triggers.
      perform set_config('lock_timeout', v_prev_lock_timeout, true);
    else
      raise warning 'auto_create_deposits_from_gmail deferred to cron: advisory lock busy';
    end if;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.auto_create_deposits_from_gmail(p_window_hours integer DEFAULT 336)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not pg_try_advisory_xact_lock(hashtext('auto_create_deposits_from_gmail')) then
    raise warning 'auto_create_deposits_from_gmail skipped: advisory lock busy';
    return 0;
  end if;
  return public.auto_create_deposits_from_gmail_impl(p_window_hours);
end;
$function$;
