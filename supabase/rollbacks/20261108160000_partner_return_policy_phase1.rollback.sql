-- Rollback of 20261108160000_partner_return_policy_phase1 (DATA-FORWARD): portfolio and promissory-note writes go
-- back to exactly today's behaviour (a missing Returns rate = 15, any typed rate accepted, notes need no rate, nothing
-- queued for the CFO), the next-cycle job and the drift check stop, and the switch is turned off.
--
-- KEPT on purpose (data and audit; nothing is dropped or deleted):
--   * tables partner_return_policy (cutoff_at untouched: the cut-off never moves), partner_return_cohort (the
--     existing-partner list frozen at the cut-off), portfolio_rate_approvals (every CFO request and decision);
--   * investor_portfolios.entitled_rate / rate_basis / rate_decided_at / rate_existing_at_decision and every stored
--     rate (rows written while the gate was live keep the rate they got);
--   * promissory_notes.return_rate / return_rate_basis (each note keeps the percentage it was written at), and the
--     promissory_notes_return_rate_range check;
--   * partner_return_note_windows (promissory-note windows frozen at the cut-off);
--   * partner_return_legacy_portfolios (portfolios that predate the gate, frozen at the cut-off);
--   * every function (harmless without the triggers and jobs), the cut-off / list / note-window guard triggers that
--     protect the kept rows, idx_pwo_investor_portfolio_source, and trg_partner_return_carry_guard (a security fix:
--     only the owner's split/lock tools may create a carved-off portfolio, and no browser or edge session may change
--     its locked_from_portfolio_id later; no browser or edge code relies on doing either). Its post-cut-off refusal
--     to move a portfolio from one partner to another is REMOVED (step 2b): staff can re-point investor_id again,
--     as in production today.
-- After this, approvals still recorded through cfo_decide_portfolio_rate_requests() are not applied (the job is off),
-- and set_partner_return_policy() could still flip the flag, which changes nothing without the gate. Do not turn the
-- switch on again until the migration is re-applied. Re-applying it restores the gate, the note triggers, the jobs and
-- the no-default rule; the kept cut-off and list are reused (a later switch-on takes no new snapshot).
--
-- Idempotent: safe to run twice, and safe if the migration was only partly applied.
BEGIN;
-- psql sends the file in the client encoding. Pinned (takes effect for every statement after this one): a session
-- left at WIN1252 (psql on Windows without PGCLIENTENCODING) would store the non-ASCII characters below as mojibake.
SET client_encoding = 'UTF8';
SET LOCAL lock_timeout = '5s';

-- 1. FIRST the rate default comes back, so an insert without a rate is never left with neither the gate nor a default.
ALTER TABLE public.investor_portfolios ALTER COLUMN roi_percentage SET DEFAULT 15;

-- 2. Remove the portfolio gate (typed rates are accepted again; no CFO queueing; no decision stamps).
DROP TRIGGER IF EXISTS trg_partner_return_rate_policy ON public.investor_portfolios;

-- 2b. The carve-out guard stays, but without the post-cut-off investor move refusal (that protects the gate's
--     rates, which are gone): the body goes back to the carve-out check only and the trigger to its one column.
DO $carry$
BEGIN
  IF to_regclass('public.investor_portfolios') IS NULL
     OR to_regprocedure('public.guard_partner_return_carry()') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.guard_partner_return_carry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user IN ('authenticated', 'anon', 'service_role')
     AND (CASE WHEN TG_OP = 'INSERT'
               THEN NEW.locked_from_portfolio_id IS NOT NULL AND current_user <> 'service_role'
               ELSE NEW.locked_from_portfolio_id IS DISTINCT FROM OLD.locked_from_portfolio_id END) THEN
    RAISE EXCEPTION 'A portfolio carved from another one can only be created by the split or lock tools'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $function$
$fn$;
  REVOKE ALL ON FUNCTION public.guard_partner_return_carry() FROM PUBLIC, anon;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.investor_portfolios'::regclass
                AND t.tgname = 'trg_partner_return_carry_guard') THEN
    CREATE OR REPLACE TRIGGER trg_partner_return_carry_guard
      BEFORE INSERT OR UPDATE OF locked_from_portfolio_id ON public.investor_portfolios
      FOR EACH ROW EXECUTE FUNCTION public.guard_partner_return_carry();
  END IF;
END
$carry$;

-- 3. Promissory notes: defaults first (both columns are NOT NULL and were filled by the stamp trigger), then remove the
--    stamp and the browser guard.
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'promissory_notes' AND column_name = 'return_rate') THEN
    ALTER TABLE public.promissory_notes ALTER COLUMN return_rate SET DEFAULT 15;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'promissory_notes' AND column_name = 'return_rate_basis') THEN
    ALTER TABLE public.promissory_notes ALTER COLUMN return_rate_basis SET DEFAULT 'legacy';
  END IF;
END
$rb$;
DROP TRIGGER IF EXISTS trg_zz_stamp_note_return_rate ON public.promissory_notes;
DROP TRIGGER IF EXISTS trg_zz_guard_note_return_rate ON public.promissory_notes;

-- 4. Stop the next-cycle job and the 10-minute drift check.
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobname) FROM cron.job j
     WHERE j.jobname IN ('apply-portfolio-rate-changes-705pm', 'partner-rate-drift-check');
  END IF;
END
$cron$;

-- 5. Switch off. cutoff_at is not touched (trg_partner_return_policy_guard refuses any change to it and clears
--    enabled_at). Only a row that is still on is changed, so a second run writes nothing.
DO $off$
DECLARE
  v_n integer;
BEGIN
  IF to_regclass('public.partner_return_policy') IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.partner_return_policy
     SET enabled = false,
         release_ready = false,
         updated_by = NULL,
         updated_at = now(),
         note = concat_ws(' · ', NULLIF(btrim(note), ''),
                          'Switched off by the 20261108160000 rollback on '
                          || to_char(now() AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI') || ' (Kampala)')
   WHERE id AND (enabled OR release_ready);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, new_values, reason)
    VALUES (NULL, 'partner_return_policy_rollback', 'partner_return_policy', 'singleton',
            jsonb_build_object('enabled', false, 'release_ready', false), 'Rollback of 20261108160000_partner_return_policy_phase1 (data kept)');
  END IF;
END
$off$;
COMMIT;
