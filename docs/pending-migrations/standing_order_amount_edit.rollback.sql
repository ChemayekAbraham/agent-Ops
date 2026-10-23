-- Rollback for docs/pending-migrations/standing_order_amount_edit.sql
--   (sha256 0503a512b1f4e8b527285d345489773a8a0a42466079c5526e60fff1e520ffc1).
--
-- What it does, in one transaction:
--   1. Refuses, changing nothing, unless the save function and the audit rule are exactly the ones that file created.
--   2. Removes the save function public.standing_order_set_amount, so no further amount changes can be saved.
--   3. Restores the original audit rule (create, pause, resume, cancel) ONLY when no 'amount_edit' audit rows exist.
--      If any exist, the wider rule is kept: audit rows are never deleted, and the old rule would reject them.
--
-- What it does NOT do: it does not change any standing-order amount back. An amount changed through the function is
-- a recorded business change (previous amount in the audit row's details); reverse it, if needed, with a new
-- recorded change. It touches no payment run, wallet, balance, ledger entry or payment record.
--
-- Run as one transaction (it has its own BEGIN; ... COMMIT;). Function checks ignore carriage returns.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF to_regprocedure('public.standing_order_set_amount(uuid,numeric,timestamp with time zone,numeric,text)') IS NULL
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
          WHERE oid = to_regprocedure('public.standing_order_set_amount(uuid,numeric,timestamp with time zone,numeric,text)'))
        IS DISTINCT FROM 'd5ae31ba050f7f13bb8142a87e31da49'
     OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conname = 'standing_order_audit_log_action_check' AND conrelid = 'public.standing_order_audit_log'::regclass)
        IS DISTINCT FROM 'CHECK ((action = ANY (ARRAY[''create''::text, ''pause''::text, ''resume''::text, ''cancel''::text, ''amount_edit''::text])))' THEN
    RAISE EXCEPTION 'precondition failed: the standing-order amount change is not in the state standing_order_amount_edit.sql created; nothing was changed. Reverse by hand';
  END IF;
END
$pre$;

DROP FUNCTION public.standing_order_set_amount(uuid, numeric, timestamptz, numeric, text);

DO $rule$
DECLARE
  v_edits bigint;
BEGIN
  SELECT count(*) INTO v_edits FROM public.standing_order_audit_log WHERE action = 'amount_edit';
  IF v_edits = 0 THEN
    ALTER TABLE public.standing_order_audit_log DROP CONSTRAINT standing_order_audit_log_action_check;
    ALTER TABLE public.standing_order_audit_log
      ADD CONSTRAINT standing_order_audit_log_action_check
      CHECK (action IN ('create', 'pause', 'resume', 'cancel'));
    RAISE NOTICE 'standing-order rollback: save function removed; original audit rule restored';
  ELSE
    RAISE NOTICE 'standing-order rollback: save function removed; % amount_edit audit row(s) exist, so the audit rule keeps amount_edit (no-deletion rule)', v_edits;
  END IF;
END
$rule$;

COMMIT;
