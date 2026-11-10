-- Promissory notes are fulfilled by 31 Dec 2026 while Partner Returns stays off (owner, 2026-11-10:
-- "keep the switch off for now ... promissory note fulfillment dates to be max date 31 dec this yr,
-- we shall turn the switch on next yr").
--
--   1. partner_return_policy.note_due_by: the latest fulfilment date a note may carry; NULL = no limit.
--      It clears itself when the CEO turns Partner Returns on (owner: "until the switch is on").
--   2. promissory_notes: a note recorded on or before note_due_by must be fulfilled by it, and a note
--      with no date gets note_due_by. A note recorded after note_due_by is not limited, so a switch-on
--      that slips into January never blocks new notes.
--   3. get_partner_return_policy() returns note_due_by, so the note screens cap their date pickers.
--   4. One-off (only while the switch is off and before the deadline): set note_due_by to 2026-12-31 and
--      move every open note (pending/activated, money still owed) that is due later or has no date to
--      2026-12-31, one audit_logs row per note with its old date. No SMS is sent for the move (owner).
--
-- Money is untouched: no note trigger keyed on these columns posts to the ledger or pays commission
-- (receivable recognition fires on status, commission on approval_bonus_paid, rate guards on
-- return_rate / partner_user_id / agent_id). Note windows (partner_return_note_windows) are frozen
-- at the 9 Nov cut-off and are not changed.

ALTER TABLE public.partner_return_policy ADD COLUMN IF NOT EXISTS note_due_by date;
COMMENT ON COLUMN public.partner_return_policy.note_due_by IS
  'Latest fulfilment date for promissory notes recorded on or before it (NULL = no limit). Cleared when Partner Returns is switched on. Owner decision 2026-11-10.';

-- 1. Clear the deadline at switch-on; audit every change of it. Fires after the guard (name order),
--    so a refused switch-on changes nothing.
CREATE OR REPLACE FUNCTION public.partner_return_policy_note_due_by()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.enabled AND NOT OLD.enabled THEN
    NEW.note_due_by := NULL;
  END IF;
  IF NEW.note_due_by IS DISTINCT FROM OLD.note_due_by THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, old_values, new_values, reason)
    VALUES (auth.uid(), 'partner_note_due_by_changed', 'partner_return_policy', 'singleton',
            jsonb_build_object('note_due_by', OLD.note_due_by),
            jsonb_build_object('note_due_by', NEW.note_due_by),
            CASE WHEN NEW.enabled AND NOT OLD.enabled
                 THEN 'Cleared by the Partner Returns switch-on'
                 ELSE COALESCE(NULLIF(current_setting('app.change_reason', true), ''), 'Note deadline changed') END);
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.partner_return_policy_note_due_by() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_partner_return_policy_note_due_by ON public.partner_return_policy;
CREATE TRIGGER trg_partner_return_policy_note_due_by
  BEFORE UPDATE ON public.partner_return_policy
  FOR EACH ROW EXECUTE FUNCTION public.partner_return_policy_note_due_by();

-- 2. Every writer of promissory_notes (agent RPC, staff edit screen, NeexaBot, service code).
CREATE OR REPLACE FUNCTION public.enforce_promissory_note_due_by()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_by date;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.fulfilment_due_on IS NOT DISTINCT FROM OLD.fulfilment_due_on
     AND NEW.recorded_on IS NOT DISTINCT FROM OLD.recorded_on THEN
    RETURN NEW;
  END IF;
  SELECT p.note_due_by INTO v_by FROM public.partner_return_policy p WHERE p.id;
  IF v_by IS NULL OR NEW.recorded_on IS NULL OR NEW.recorded_on > v_by THEN
    RETURN NEW;
  END IF;
  IF NEW.fulfilment_due_on IS NULL THEN
    NEW.fulfilment_due_on := v_by;
  ELSIF NEW.fulfilment_due_on > v_by THEN
    RAISE EXCEPTION 'FULFILMENT_AFTER_DEADLINE: promissory notes must be fulfilled by %. Pick a date on or before it.',
      to_char(v_by, 'FMDD Mon YYYY')
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.enforce_promissory_note_due_by() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_note_due_by ON public.promissory_notes;
CREATE TRIGGER trg_enforce_note_due_by
  BEFORE INSERT OR UPDATE OF fulfilment_due_on, recorded_on ON public.promissory_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_promissory_note_due_by();

-- 3. The public policy answer carries the deadline (CREATE OR REPLACE keeps the anon/authenticated grants).
CREATE OR REPLACE FUNCTION public.get_partner_return_policy()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'enabled', COALESCE(p.enabled, false),
    'new_contract_rate', public.partner_new_contract_rate(),
    'policy_rate', p.new_contract_rate,
    'legacy_rate', p.legacy_rate,
    'existing_partner_mode', p.existing_partner_mode,
    'existing_partner_cap', p.existing_partner_cap,
    'employee_rate', p.employee_rate,
    'cutoff_at', p.cutoff_at,
    'enabled_at', p.enabled_at,
    'updated_at', p.updated_at,
    'note_due_by', p.note_due_by)
  FROM public.partner_return_policy p WHERE p.id;
$function$;

-- 4. One-off: set the deadline and move the open notes. Skipped once the switch is on or the date has
--    passed, so a re-run never brings the 2026 deadline back.
DO $migration$
DECLARE
  v_by    constant date := DATE '2026-12-31';
  v_moved integer;
BEGIN
  IF (SELECT p.enabled FROM public.partner_return_policy p WHERE p.id)
     OR (now() AT TIME ZONE 'Africa/Kampala')::date > v_by THEN
    RAISE NOTICE 'note_due_by one-off skipped (switch on or deadline passed)';
    RETURN;
  END IF;

  PERFORM set_config('app.change_reason',
    'Owner instruction 2026-11-10: promissory notes are fulfilled by 31 Dec 2026; Partner Returns stays off until next year', true);
  UPDATE public.partner_return_policy SET note_due_by = v_by WHERE id AND note_due_by IS DISTINCT FROM v_by;

  CREATE TEMP TABLE _note_due_move ON COMMIT DROP AS
    SELECT n.id, n.fulfilment_due_on AS old_due
      FROM public.promissory_notes n
     WHERE n.status IN ('pending', 'activated')
       AND n.amount > COALESCE(n.total_collected, 0)
       AND n.recorded_on <= v_by
       AND (n.fulfilment_due_on IS NULL OR n.fulfilment_due_on > v_by)
     FOR UPDATE;

  UPDATE public.promissory_notes n
     SET fulfilment_due_on = v_by
    FROM _note_due_move m
   WHERE n.id = m.id;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, old_values, new_values, reason)
  SELECT NULL, 'promissory_note_due_date_capped', 'promissory_notes', m.id::text,
         jsonb_build_object('fulfilment_due_on', m.old_due),
         jsonb_build_object('fulfilment_due_on', v_by),
         'Owner instruction 2026-11-10: open promissory notes are fulfilled by 31 Dec 2026 (due later or no date before); no SMS sent for the move'
    FROM _note_due_move m;

  RAISE NOTICE 'note_due_by set to %, % open notes moved', v_by, v_moved;
END
$migration$;
