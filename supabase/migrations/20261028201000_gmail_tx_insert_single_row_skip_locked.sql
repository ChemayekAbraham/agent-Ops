-- Gmail receipt INSERTs are still cancelled with SQLSTATE 57014
-- (canceling statement due to statement timeout) inside
-- trg_gmail_tx_auto_create_deposit. The trigger calls
-- auto_create_deposits_from_gmail(24), the full 24 hour batch, in the
-- same transaction as the PostgREST INSERT. That batch calls
-- auto_record_merchant_float_return, which does
-- SELECT ... FROM gmail_transactions WHERE id = ... FOR UPDATE
-- and blocks on row locks held by the cron or another ingest.
--
-- PL/pgSQL EXCEPTION WHEN OTHERS does not catch query_canceled (57014).
-- lock_not_available (55P03) is catchable; a statement_timeout that fires
-- while the batch is locking a tuple is not. The INSERT rolls back and
-- the MoMo receipt row is lost. The 2-minute cron cannot store a row
-- that never committed.
--
-- This migration does not run the 24h batch on the insert path.
-- The trigger processes only NEW.id, through auto_create_deposit_from_gmail_row.
-- The cron keeps auto_create_deposits_from_gmail(336) and its blocking
-- FOR UPDATE. get_merchant_float_positions is not modified. No table,
-- general_ledger, or wallets shape changes.
--
-- The single-row path sets two transaction-local GUCs and then calls the
-- existing impl:
--   welile.gmail_deposit_only_id   — impl loop keeps every other predicate
--                                    and adds "this id only"
--   welile.gmail_float_return_lock — auto_record_merchant_float_return
--                                    takes FOR UPDATE SKIP LOCKED and, if
--                                    the receipt row is locked by someone
--                                    else, returns outcome busy_deferred
--                                    before any merchant_float_returns or
--                                    ledger_reconciled_tids write. The same
--                                    flag makes the per-desk advisory lock
--                                    pg_try_advisory_xact_lock so that wait
--                                    cannot become an uncatchable 57014.
-- Both GUCs are cleared before the helper returns. Unset, the impl still
-- scans the window and auto_record still waits on FOR UPDATE. Idempotency
-- and the ledger entries are the same statements as before.
--
-- Bodies of the two existing functions are patched from pg_get_functiondef
-- so every other line stays as it is in the database this migration runs
-- on. A missing anchor raises and the migration rolls back.

CREATE OR REPLACE FUNCTION public.auto_create_deposit_from_gmail_row(p_gmail_transaction_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_created integer := 0;
begin
  if p_gmail_transaction_id is null then
    return 0;
  end if;
  -- Transaction-local. The cron never sets these, so its batch and its
  -- blocking row lock stay as they are. Cleared before we return so a
  -- later trigger in this INSERT does not inherit the one-row filter.
  perform set_config('welile.gmail_deposit_only_id', p_gmail_transaction_id::text, true);
  perform set_config('welile.gmail_float_return_lock', 'skip_locked', true);
  begin
    v_created := public.auto_create_deposits_from_gmail_impl(24);
    perform set_config('welile.gmail_deposit_only_id', '', true);
    perform set_config('welile.gmail_float_return_lock', '', true);
    return v_created;
  exception when others then
    perform set_config('welile.gmail_deposit_only_id', '', true);
    perform set_config('welile.gmail_float_return_lock', '', true);
    raise;
  end;
end;
$function$;

REVOKE ALL ON FUNCTION public.auto_create_deposit_from_gmail_row(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auto_create_deposit_from_gmail_row(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_create_deposit_from_gmail_row(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_gmail_tx_auto_create_deposit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.linked_deposit_request_id is null
     and new.parsed = true
     and new.amount is not null and new.amount > 0
     and new.transaction_id is not null
     and new.direction in ('in','credit') then
    begin
      -- One receipt. The 24h/336h batch stays on email-auto-create-deposits-24h.
      -- WHEN OTHERS does not catch query_canceled (57014), so this path must
      -- not scan or lock the rest of the window.
      perform public.auto_create_deposit_from_gmail_row(new.id);
    exception when others then
      raise warning 'auto_create_deposit_from_gmail_row deferred to cron: %', sqlerrm;
    end;
  end if;
  return new;
end;
$function$;

DO $patch_impl$
DECLARE
  src text;
  old text := $impl_old$  v_norm_tid    text;
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
  new text := $impl_new$  v_norm_tid    text;
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
  hits int;
BEGIN
  src := pg_get_functiondef('public.auto_create_deposits_from_gmail_impl(integer)'::regprocedure);
  IF position('v_only_gmail_id' in src) > 0 THEN
    RAISE NOTICE 'auto_create_deposits_from_gmail_impl already filters to one id';
  ELSE
    hits := (length(src) - length(replace(src, old, ''))) / length(old);
    IF hits <> 1 THEN
      RAISE EXCEPTION 'auto_create_deposits_from_gmail_impl candidate query matched % times, expected 1', hits;
    END IF;
    EXECUTE replace(src, old, new);
  END IF;
END
$patch_impl$;

DO $patch_lock$
DECLARE
  src text;
  old text := $lock_old$  SELECT g.id, g.amount, g.transaction_id, g.counterparty, g.direction,
         g.parsed, g.linked_deposit_request_id
    INTO v_tx
    FROM gmail_transactions g
   WHERE g.id = p_gmail_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'outcome', 'gmail_row_not_found');
  END IF;$lock_old$;
  new text := $lock_new$  IF current_setting('welile.gmail_float_return_lock', true) = 'skip_locked' THEN
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
  hits int;
BEGIN
  src := pg_get_functiondef('public.auto_record_merchant_float_return(uuid,uuid,text)'::regprocedure);
  IF position('busy_deferred' in src) > 0 THEN
    RAISE NOTICE 'auto_record_merchant_float_return already returns busy_deferred';
  ELSE
    hits := (length(src) - length(replace(src, old, ''))) / length(old);
    IF hits <> 1 THEN
      RAISE EXCEPTION 'auto_record_merchant_float_return FOR UPDATE block matched % times, expected 1', hits;
    END IF;
    EXECUTE replace(src, old, new);
  END IF;
END
$patch_lock$;

DO $patch_adv$
DECLARE
  src text;
  old text := $adv_old$  -- Serialise per desk so two receipts cannot both read the same float.
  PERFORM pg_advisory_xact_lock(hashtext('merchant_float_return:' || p_agent_id::text));$adv_old$;
  new text := $adv_new$  -- Serialise per desk so two receipts cannot both read the same float.
  -- The insert trigger asks for a non-blocking lock and defers when the
  -- desk is already being recorded. Cron keeps the waiting lock.
  IF current_setting('welile.gmail_float_return_lock', true) = 'skip_locked' THEN
    IF NOT pg_try_advisory_xact_lock(hashtext('merchant_float_return:' || p_agent_id::text)) THEN
      RETURN jsonb_build_object('ok', false, 'outcome', 'busy_deferred');
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('merchant_float_return:' || p_agent_id::text));
  END IF;$adv_new$;
  hits int;
BEGIN
  src := pg_get_functiondef('public.auto_record_merchant_float_return(uuid,uuid,text)'::regprocedure);
  IF position('pg_try_advisory_xact_lock(hashtext(''merchant_float_return:''' in src) > 0 THEN
    RAISE NOTICE 'auto_record_merchant_float_return desk lock already non-blocking on the trigger path';
  ELSE
    hits := (length(src) - length(replace(src, old, ''))) / length(old);
    IF hits <> 1 THEN
      RAISE EXCEPTION 'auto_record_merchant_float_return desk lock matched % times, expected 1', hits;
    END IF;
    EXECUTE replace(src, old, new);
  END IF;
END
$patch_adv$;

DO $check$
DECLARE
  impl text := pg_get_functiondef('public.auto_create_deposits_from_gmail_impl(integer)'::regprocedure);
  rec text := pg_get_functiondef('public.auto_record_merchant_float_return(uuid,uuid,text)'::regprocedure);
  trg text := pg_get_functiondef('public.trg_gmail_tx_auto_create_deposit()'::regprocedure);
BEGIN
  IF position('v_only_gmail_id is null or g.id = v_only_gmail_id' in impl) = 0 THEN
    RAISE EXCEPTION 'impl was not restricted to the trigger row';
  END IF;
  IF position('FOR UPDATE SKIP LOCKED' in rec) = 0
     OR position('busy_deferred' in rec) = 0
     OR position(E'FOR UPDATE;\n' in rec) = 0
     OR position('pg_advisory_xact_lock(hashtext(''merchant_float_return:''' in rec) = 0 THEN
    RAISE EXCEPTION 'float-return lock patch is incomplete';
  END IF;
  IF position('merchant_float_returns' in rec) = 0
     OR position('ledger_reconciled_tids' in rec) = 0
     OR position('already_recorded' in rec) = 0 THEN
    RAISE EXCEPTION 'auto_record_merchant_float_return lost idempotency or ledger writes';
  END IF;
  IF position('auto_create_deposits_from_gmail(' in trg) > 0
     OR position('auto_create_deposit_from_gmail_row' in trg) = 0 THEN
    RAISE EXCEPTION 'trigger still runs the 24h batch';
  END IF;
END
$check$;
