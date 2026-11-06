-- Restores the insert trigger that runs auto_create_deposits_from_gmail(24),
-- and removes the single-row filter and the non-blocking lock branch.
-- Run as one transaction. Does not touch get_merchant_float_positions,
-- general_ledger, or wallets.

SET lock_timeout = '5s';

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

DROP FUNCTION IF EXISTS public.auto_create_deposit_from_gmail_row(uuid);

DO $unpatch_adv$
DECLARE
  src text;
  old text := $adv_new$  -- Serialise per desk so two receipts cannot both read the same float.
  -- The insert trigger asks for a non-blocking lock and defers when the
  -- desk is already being recorded. Cron keeps the waiting lock.
  IF current_setting('welile.gmail_float_return_lock', true) = 'skip_locked' THEN
    IF NOT pg_try_advisory_xact_lock(hashtext('merchant_float_return:' || p_agent_id::text)) THEN
      RETURN jsonb_build_object('ok', false, 'outcome', 'busy_deferred');
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('merchant_float_return:' || p_agent_id::text));
  END IF;$adv_new$;
  new text := $adv_old$  -- Serialise per desk so two receipts cannot both read the same float.
  PERFORM pg_advisory_xact_lock(hashtext('merchant_float_return:' || p_agent_id::text));$adv_old$;
  hits int;
BEGIN
  src := pg_get_functiondef('public.auto_record_merchant_float_return(uuid,uuid,text)'::regprocedure);
  hits := (length(src) - length(replace(src, old, ''))) / length(old);
  IF hits <> 1 THEN
    RAISE EXCEPTION 'desk-lock rollback anchor matched % times, expected 1', hits;
  END IF;
  EXECUTE replace(src, old, new);
END
$unpatch_adv$;

DO $unpatch_lock$
DECLARE
  src text;
  old text := $lock_new$  IF current_setting('welile.gmail_float_return_lock', true) = 'skip_locked' THEN
    SELECT g.id, g.amount, g.transaction_id, g.counterparty, g.direction,
           g.parsed, g.linked_deposit_request_id
      INTO v_tx
      FROM gmail_transactions g
     WHERE g.id = p_gmail_transaction_id
     FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      IF EXISTS (
        SELECT 1 FROM gmail_transactions g WHERE g.id = p_gmail_transaction_id
      ) THEN
        RETURN jsonb_build_object('ok', false, 'outcome', 'busy_deferred');
      END IF;
      RETURN jsonb_build_object('ok', false, 'outcome', 'gmail_row_not_found');
    END IF;
  ELSE
    SELECT g.id, g.amount, g.transaction_id, g.counterparty, g.direction,
           g.parsed, g.linked_deposit_request_id
      INTO v_tx
      FROM gmail_transactions g
     WHERE g.id = p_gmail_transaction_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'outcome', 'gmail_row_not_found');
    END IF;
  END IF;$lock_new$;
  new text := $lock_old$  SELECT g.id, g.amount, g.transaction_id, g.counterparty, g.direction,
         g.parsed, g.linked_deposit_request_id
    INTO v_tx
    FROM gmail_transactions g
   WHERE g.id = p_gmail_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'gmail_row_not_found');
  END IF;$lock_old$;
  hits int;
BEGIN
  src := pg_get_functiondef('public.auto_record_merchant_float_return(uuid,uuid,text)'::regprocedure);
  hits := (length(src) - length(replace(src, old, ''))) / length(old);
  IF hits <> 1 THEN
    RAISE EXCEPTION 'FOR UPDATE rollback anchor matched % times, expected 1', hits;
  END IF;
  EXECUTE replace(src, old, new);
END
$unpatch_lock$;

DO $unpatch_impl$
DECLARE
  src text;
  old text := $impl_new$  v_norm_tid    text;
  v_only_gmail_id uuid;
begin
  -- Set by auto_create_deposit_from_gmail_row. Null on the cron path.
  v_only_gmail_id := nullif(current_setting('welile.gmail_deposit_only_id', true), '')::uuid;
  for v_tx in
    select g.id, g.amount, g.transaction_id, g.counterparty, g.counterparty_name,
           g.channel, g.internal_date,
           g.subject, g.snippet, g.raw_body, g.from_email
      from gmail_transactions g
     where g.linked_deposit_request_id is null
       and g.parsed = true
       and g.direction in ('in','credit')
       and g.amount is not null
       and g.amount > 0
       and g.transaction_id is not null
       and length(trim(g.transaction_id)) > 0
       and (g.internal_date is null
            or g.internal_date >= (now() - (p_window_hours || ' hours')::interval))
       and (v_only_gmail_id is null or g.id = v_only_gmail_id)
     order by g.internal_date desc nulls last
     limit 200$impl_new$;
  new text := $impl_old$  v_norm_tid    text;
begin
  for v_tx in
    select g.id, g.amount, g.transaction_id, g.counterparty, g.counterparty_name,
           g.channel, g.internal_date,
           g.subject, g.snippet, g.raw_body, g.from_email
      from gmail_transactions g
     where g.linked_deposit_request_id is null
       and g.parsed = true
       and g.direction in ('in','credit')
       and g.amount is not null
       and g.amount > 0
       and g.transaction_id is not null
       and length(trim(g.transaction_id)) > 0
       and (g.internal_date is null
            or g.internal_date >= (now() - (p_window_hours || ' hours')::interval))
     order by g.internal_date desc nulls last
     limit 200$impl_old$;
  hits int;
BEGIN
  src := pg_get_functiondef('public.auto_create_deposits_from_gmail_impl(integer)'::regprocedure);
  hits := (length(src) - length(replace(src, old, ''))) / length(old);
  IF hits <> 1 THEN
    RAISE EXCEPTION 'impl rollback anchor matched % times, expected 1', hits;
  END IF;
  EXECUTE replace(src, old, new);
END
$unpatch_impl$;

RESET lock_timeout;
