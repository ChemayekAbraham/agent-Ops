-- Partner Returns per person (Phase 1: the database core)
--
-- Owner decisions (Pius, 2026-11-06), replacing the per-contract design of 2026-11-04:
--   * The switch ships OFF. While it is off everything behaves exactly as today.
--   * The cut-off is the moment the switch is FIRST turned on. It is recorded once and never
--     moves, even if the switch is later turned off and on again.
--   * Existing partners = people holding a live portfolio (active or locked) at the cut-off,
--     plus people who had signed a written partnership agreement that was not yet
--     countersigned. Their existing portfolios keep their stored rate (20, 15, 14, 10 ...),
--     renewals and top-ups included. A NEW portfolio for an existing partner earns their own
--     rate: the highest rate among their live portfolios at the cut-off (no cap; a cap is a
--     setting). Signed-agreement partners get the legacy 15%.
--   * Employees (active HR staff) earn 20% on new portfolios and salary reinvestment, with no
--     CFO approval.
--   * Promissory notes keep their percentage. Notes written before the cut-off read 15%; a
--     note written after it carries the person's rate (10% for a new or unknown partner).
--     A person linked to a note earns at least the note's rate on portfolios opened within
--     the note's window (due date, or the cut-off if later, plus note_grace_days), and keeps
--     that rate on new portfolios while a portfolio funded under the note is still live.
--   * Everyone else, including a partner who redeemed everything and comes back, is a new
--     partner at 10%.
--   * Only the CEO turns the switch on or off.
--   * Any other rate typed by staff, and any change to an existing portfolio's rate, waits
--     for the CFO; the rate in force does not move until the CFO approves, and an approved
--     rate applies from the next cycle.
--   * The tenant side (Rent Plan fee split, 360 tenant engine) is untouched.
--
-- Design
--   * ONE decider: partner_rates_for(uuid[]) returns (partner_id, rate, basis, existing) for any
--     set of people in one query. Everything else (the portfolio gate, promissory-note stamping,
--     agreements, edge functions, screens) reads its answer and never works a rate out itself.
--   * The gate trigger fills a missing rate from the decider, holds any other typed rate for
--     the CFO, and stamps each new portfolio with the rate it was entitled to and why
--     (entitled_rate, rate_basis, rate_decided_at, rate_existing_at_decision). Those stamps never
--     change afterwards and
--     are what the conformance check compares against.
--   * investor_portfolios.roi_percentage has NO default: if the gate is ever missing, an insert
--     without a rate fails loudly instead of silently taking a stale number.
--   * Monitoring: record_partner_return_policy_drift() runs every 10 minutes and emails the CEO,
--     CFO and policy.alert_emails only when a problem starts or ends.
--   * The switch cannot go on until the release migration sets release_ready (every creation
--     path, agreement, edge function and screen takes the person's rate) and every
--     assert_partner_return_policy_intact() check passes. Settings changes are audited and emailed.
--   * Promissory-note windows are frozen at the cut-off (partner_return_note_windows), so later
--     edits to a note's dates cannot stretch them; after the cut-off a browser cannot link a
--     note to a person directly.
--   * Only the owner's split/lock tools may create a carved-off portfolio
--     (trg_partner_return_carry_guard): it keeps its parent's rate and skips the funding debit.
--     After the cut-off the same guard stops a browser or edge session from moving a portfolio
--     from one partner to another (the new holder would get the old holder's rate).

-- 1s, not 5s: while this waits for its lock every reader and writer of the table queues behind it
-- (ACCESS EXCLUSIVE blocks plain SELECTs). On a lock timeout nothing is applied; the file is one
-- transaction and idempotent, so retry the apply (outside the payout cron windows).
SET LOCAL lock_timeout = '1s';

-- Take the strong table locks once, up front, in a fixed order, so nothing is upgraded midway
-- (an upgrade can deadlock with a transaction that already read a portfolio). The DDL below
-- is quick; apply outside the 00:00, 06:00, 15:00-16:10 and 21:00 UTC jobs.
LOCK TABLE public.investor_portfolios, public.promissory_notes IN ACCESS EXCLUSIVE MODE;

-- ===========================================================================
-- 1. Tables and columns
-- ===========================================================================

-- 1a. The switch and its settings (one row).
CREATE TABLE IF NOT EXISTS public.partner_return_policy (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled               boolean NOT NULL DEFAULT false,
  new_contract_rate     numeric(6,2) NOT NULL DEFAULT 10 CHECK (new_contract_rate > 0 AND new_contract_rate <= 100),
  legacy_rate           numeric(6,2) NOT NULL DEFAULT 15 CHECK (legacy_rate > 0 AND legacy_rate <= 100),
  existing_partner_mode text NOT NULL DEFAULT 'own' CHECK (existing_partner_mode IN ('own', 'fixed')),
  existing_partner_rate numeric(6,2) NOT NULL DEFAULT 15 CHECK (existing_partner_rate > 0 AND existing_partner_rate <= 100),
  existing_partner_cap  numeric(6,2) CHECK (existing_partner_cap IS NULL OR (existing_partner_cap > 0 AND existing_partner_cap <= 100)),
  employee_rate         numeric(6,2) NOT NULL DEFAULT 20 CHECK (employee_rate > 0 AND employee_rate <= 100),
  note_grace_days       integer NOT NULL DEFAULT 30 CHECK (note_grace_days >= 0 AND note_grace_days <= 365),
  -- Set to true only by the release migration (Phase 7), once every creation path, agreement,
  -- edge function and screen takes the person's rate. The switch cannot be turned on before that.
  release_ready         boolean NOT NULL DEFAULT false,
  cutoff_at             timestamptz,
  enabled_at            timestamptz,
  alert_emails          text[] NOT NULL DEFAULT '{}',
  updated_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  note                  text
);
COMMENT ON TABLE public.partner_return_policy IS
  'Partner Returns switch and per-person rules. enabled=false keeps today''s behaviour. cutoff_at is written once, at the first switch-on, and never moves. Change the switch only through set_partner_return_policy() (CEO).';
COMMENT ON COLUMN public.partner_return_policy.existing_partner_mode IS
  'own = an existing partner''s new portfolio earns the highest rate among their live portfolios at the cut-off (capped by existing_partner_cap when set); fixed = existing_partner_rate.';

INSERT INTO public.partner_return_policy (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.partner_return_policy ENABLE ROW LEVEL SECURITY;
-- Control table: read-only even for the service role; only the SECURITY DEFINER functions
-- below (running as the owner) change it. Deliberate exception to "service_role gets all four".
REVOKE ALL ON public.partner_return_policy FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.partner_return_policy TO service_role;
DROP POLICY IF EXISTS mfa_required_for_staff ON public.partner_return_policy;
CREATE POLICY mfa_required_for_staff ON public.partner_return_policy AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

-- 1b. Who counted as an existing partner at the cut-off. Filled once, by the first switch-on.
CREATE TABLE IF NOT EXISTS public.partner_return_cohort (
  partner_id      uuid PRIMARY KEY,
  basis           text NOT NULL CHECK (basis IN ('live_portfolio', 'signed_agreement')),
  live_portfolios integer NOT NULL DEFAULT 0,
  min_rate        numeric(6,2),
  max_rate        numeric(6,2),
  snapshot_at     timestamptz NOT NULL
);
COMMENT ON TABLE public.partner_return_cohort IS
  'Existing partners frozen at the Partner Returns cut-off (first switch-on). Append-only: written only by the switch-on snapshot; cannot be edited or deleted.';

ALTER TABLE public.partner_return_cohort ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_return_cohort FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.partner_return_cohort TO service_role;
DROP POLICY IF EXISTS mfa_required_for_staff ON public.partner_return_cohort;
CREATE POLICY mfa_required_for_staff ON public.partner_return_cohort AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

-- 1b2. Promissory-note windows frozen at the cut-off. A note written before the cut-off gives
--      the person linked to it at least the note's rate until ends_on. The end date is fixed
--      here, from the note's dates as they stood at the cut-off, so editing a due date later
--      cannot stretch it. Notes written after the cut-off carry the person's own rate and
--      grant nothing extra, so they need no window.
--      Who it is for is frozen too (partner_note_window_applies): a note linked at the cut-off
--      grants its window only to that person, wherever the note is moved later; a note nobody
--      was linked to grants it to whoever it is linked to later, except the agent on it at the
--      cut-off and the agent who holds it now.
--      The note's contacts are frozen too (contact_phones: last 9 digits of its WhatsApp and phone
--      numbers; contact_email: lower-cased): Phase 4's D3 proof (_note_contact_proven) is checked
--      against them, so a contact edited after the cut-off cannot steer the window to whoever
--      proved the new number. A contact corrected later goes through Partner Ops.
CREATE TABLE IF NOT EXISTS public.partner_return_note_windows (
  note_id         uuid PRIMARY KEY,
  return_rate     numeric(6,2) NOT NULL,
  ends_on         date NOT NULL,
  snapshot_at     timestamptz NOT NULL,
  partner_user_id uuid,
  agent_id        uuid,
  contact_phones  text[],
  contact_email   text
);
ALTER TABLE public.partner_return_note_windows ADD COLUMN IF NOT EXISTS partner_user_id uuid;
ALTER TABLE public.partner_return_note_windows ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE public.partner_return_note_windows ADD COLUMN IF NOT EXISTS contact_phones text[];
ALTER TABLE public.partner_return_note_windows ADD COLUMN IF NOT EXISTS contact_email text;
COMMENT ON TABLE public.partner_return_note_windows IS
  'Promissory notes written before the Partner Returns cut-off, the last day each one still grants its rate, the person and agent on the note at the cut-off (who the window is for), and the note''s phone numbers (last 9 digits) and email at the cut-off (what the person must prove). Append-only: written only by the switch-on snapshot.';

ALTER TABLE public.partner_return_note_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_return_note_windows FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.partner_return_note_windows TO service_role;
DROP POLICY IF EXISTS mfa_required_for_staff ON public.partner_return_note_windows;
CREATE POLICY mfa_required_for_staff ON public.partner_return_note_windows AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

-- 1b3. Portfolios that existed before the gate, frozen at the cut-off. They have no decision
--      stamp; any other unstamped portfolio was written with the gate bypassed. (Dates cannot be
--      used: some live portfolios carry a future created_at, and renewals move created_at.)
CREATE TABLE IF NOT EXISTS public.partner_return_legacy_portfolios (
  portfolio_id uuid PRIMARY KEY,
  snapshot_at  timestamptz NOT NULL
);
COMMENT ON TABLE public.partner_return_legacy_portfolios IS
  'Portfolios without a Partner Returns decision stamp at the cut-off (they predate the gate). Append-only: written only by the switch-on snapshot.';

ALTER TABLE public.partner_return_legacy_portfolios ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_return_legacy_portfolios FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.partner_return_legacy_portfolios TO service_role;
DROP POLICY IF EXISTS mfa_required_for_staff ON public.partner_return_legacy_portfolios;
CREATE POLICY mfa_required_for_staff ON public.partner_return_legacy_portfolios AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

-- 1c. CFO approval requests (unchanged shape; standard_rate now holds the person's entitled
--     rate for a new portfolio, or the rate in force for a change).
CREATE TABLE IF NOT EXISTS public.portfolio_rate_approvals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Deferred: the gate records the request in a BEFORE INSERT trigger, before the
  -- portfolio row exists; the reference is checked at commit.
  portfolio_id   uuid NOT NULL REFERENCES public.investor_portfolios(id) ON DELETE CASCADE
                   DEFERRABLE INITIALLY DEFERRED,
  requested_rate numeric(6,2) NOT NULL CHECK (requested_rate > 0 AND requested_rate <= 100),
  rate_in_force  numeric(6,2) NOT NULL,
  standard_rate  numeric(6,2) NOT NULL,
  -- note_late_link: a promissory note that existed at the cut-off was linked to the person only
  -- after they had opened a portfolio inside the note's window (queued by Phase 2).
  source         text NOT NULL CHECK (source IN ('new_portfolio', 'rate_change', 'note_late_link')),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  requested_by   uuid,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid,
  decided_at     timestamptz,
  decided_xact   bigint,
  decision_note  text,
  applied_at     timestamptz,
  applied_xact   bigint
);
COMMENT ON TABLE public.portfolio_rate_approvals IS
  'Partner Returns rates waiting for (or decided by) the CFO. Written by trg_partner_return_rate_policy; decided by cfo_decide_portfolio_rate_requests(); an approved rate applies from the next cycle via apply_due_portfolio_rate_changes().';

CREATE UNIQUE INDEX IF NOT EXISTS portfolio_rate_approvals_one_pending
  ON public.portfolio_rate_approvals (portfolio_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_rate_approvals_one_scheduled
  ON public.portfolio_rate_approvals (portfolio_id) WHERE status = 'approved' AND applied_at IS NULL;
-- At most one OPEN request (pending or scheduled) per portfolio. The gate and the late link replace
-- the open requests they see before writing theirs; a request another transaction commits (and the
-- CFO approves) in between is then a conflict for their ON CONFLICT ... DO NOTHING (this index is
-- an arbiter too), so they retry and apply the same rule instead of leaving a pending request beside
-- a scheduled one (which would make the CFO's approval of it fail).
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_rate_approvals_one_open
  ON public.portfolio_rate_approvals (portfolio_id)
  WHERE status = 'pending' OR (status = 'approved' AND applied_at IS NULL);
CREATE INDEX IF NOT EXISTS portfolio_rate_approvals_status_requested
  ON public.portfolio_rate_approvals (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS portfolio_rate_approvals_portfolio
  ON public.portfolio_rate_approvals (portfolio_id);

ALTER TABLE public.portfolio_rate_approvals ENABLE ROW LEVEL SECURITY;
-- Read-only for the service role: requests are written only by the gate and decided only by
-- the CFO function (both SECURITY DEFINER), so no service-key holder can forge an approval.
REVOKE ALL ON public.portfolio_rate_approvals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.portfolio_rate_approvals TO service_role;
DROP POLICY IF EXISTS mfa_required_for_staff ON public.portfolio_rate_approvals;
CREATE POLICY mfa_required_for_staff ON public.portfolio_rate_approvals AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok())) WITH CHECK ((SELECT public.staff_mfa_ok()));

-- 1d. Each new portfolio records the rate it was entitled to and why. Nullable, no default:
--     metadata-only, no table rewrite. Never changed after insert (the gate resets them).
ALTER TABLE public.investor_portfolios
  ADD COLUMN IF NOT EXISTS entitled_rate   numeric(6,2),
  ADD COLUMN IF NOT EXISTS rate_basis      text,
  ADD COLUMN IF NOT EXISTS rate_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS rate_existing_at_decision boolean;
COMMENT ON COLUMN public.investor_portfolios.rate_existing_at_decision IS
  'Whether the person counted as an existing partner (or a signer still holding) when this portfolio''s rate was decided, whatever basis won (employee or a promissory note can win a tie). Also stamped while the switch is off again after the cut-off (the rate stays the legacy or typed one). partner_rates_for counts a live portfolio with true as continuing, so an existing partner who is also staff keeps their own rate after leaving HR, and one who opens a portfolio during an off period keeps theirs when the switch comes back on. NULL: decided before any cut-off, no investor yet, or carried.';
COMMENT ON COLUMN public.investor_portfolios.rate_basis IS
  'Why the portfolio got its starting rate (set once at insert by trg_partner_return_rate_policy): new, existing_partner, signed_agreement, promissory_note, employee, salary_reinvestment, carried, switch_off, typed_switch_off, new_no_investor.';

-- 1e. Promissory notes keep their percentage. Existing notes read 15 without any row being
--     rewritten (constant default, then dropped: PG11+ stores it as the missing value, so no
--     trigger fires and updated_at history is untouched). New notes are stamped by a trigger.
ALTER TABLE public.promissory_notes ADD COLUMN IF NOT EXISTS return_rate numeric(6,2) NOT NULL DEFAULT 15;
ALTER TABLE public.promissory_notes ALTER COLUMN return_rate DROP DEFAULT;
ALTER TABLE public.promissory_notes ADD COLUMN IF NOT EXISTS return_rate_basis text NOT NULL DEFAULT 'legacy';
ALTER TABLE public.promissory_notes ALTER COLUMN return_rate_basis DROP DEFAULT;
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promissory_notes_return_rate_range'
                    AND conrelid = 'public.promissory_notes'::regclass) THEN
    ALTER TABLE public.promissory_notes ADD CONSTRAINT promissory_notes_return_rate_range
      CHECK (return_rate > 0 AND return_rate <= 100) NOT VALID;
  END IF;
END $c$;
COMMENT ON COLUMN public.promissory_notes.return_rate IS
  'Monthly Partner Returns rate the note was written at (fixed at creation: 15 before the cut-off, the person''s rate after it). Honoured when the note is funded.';

-- 1f. The CFO next-cycle job looks up Returns payouts by portfolio; this was a sequential scan.
CREATE INDEX IF NOT EXISTS idx_pwo_investor_portfolio_source
  ON public.pending_wallet_operations (source_id) WHERE source_table = 'investor_portfolios';


-- ===========================================================================
-- 2. The one rule
-- ===========================================================================

-- Which portfolio statuses count as "live" (held). One definition for every check.
CREATE OR REPLACE FUNCTION public.partner_live_portfolio_statuses()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT ARRAY['active', 'locked']::text[] $function$;
REVOKE ALL ON FUNCTION public.partner_live_portfolio_statuses() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_live_portfolio_statuses() TO authenticated, service_role;

-- The decider. One query for any number of people; the policy row is read once.
-- Switch off: everyone gets the legacy rate (today's behaviour).
-- Switch on: the HIGHEST of every rate the person qualifies for:
--   * new partner (always);
--   * employee (active HR staff);
--   * existing partner: on the cut-off list AND still holding what made them existing - a live
--     portfolio from before the cut-off, or one opened as an existing partner. A partner who
--     redeemed everything and came back is new: their new 10% portfolio does not restore it;
--   * signed agreement: on the cut-off list as a signer, until they redeem everything funded
--     after the cut-off;
--   * promissory note (only when p_include_notes): a note written before the cut-off whose
--     frozen window is still open, or a live portfolio that was opened on a note's rate (its
--     stamped entitled_rate, never a later CFO-approved change).
-- facts/parts are MATERIALIZED: otherwise every EXISTS is copied into each CASE/GREATEST and
-- planning alone costs ~10 ms per call.
-- Per person: 1 hr_staff probe (unique), 1 cohort probe (pk), portfolio probes on
-- (investor_id, status) (plus one pk probe per carve-out level of a live split/lock portfolio),
-- note probes on partner_user_id + window pk.
-- Whether a pre-cut-off note's window counts for a person (owner and agent as frozen at the
-- cut-off, see partner_return_note_windows): a note linked at the cut-off counts only for that
-- person; a note nobody was linked to counts for whoever it is linked to later, except the agent
-- who wrote it and the agent who holds it now (an agent cannot give themselves 15% by opening
-- their own note's activation link, or after receiving the note in a book transfer).
DROP FUNCTION IF EXISTS public.partner_note_window_applies(uuid, uuid, uuid);
CREATE OR REPLACE FUNCTION public.partner_note_window_applies(p_owner uuid, p_agent_then uuid, p_agent_now uuid, p_person uuid)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p_owner IS NOT NULL THEN p_owner = p_person
              ELSE p_agent_then IS DISTINCT FROM p_person AND p_agent_now IS DISTINCT FROM p_person END;
$function$;
REVOKE ALL ON FUNCTION public.partner_note_window_applies(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- THE open-window test: a pre-cut-off note's frozen window counts for p_person today when the note
-- still counts (pending, activated or fulfilled), its frozen end date has not passed (Kampala) and
-- the window is for that person (partner_note_window_applies). partner_rates_for uses it, and so do
-- Phase 4's activation contact check and the note-link hold, so all three always agree.
CREATE OR REPLACE FUNCTION public.partner_note_window_open(p_note_status text, p_ends_on date, p_owner uuid,
                                                           p_agent_then uuid, p_agent_now uuid, p_person uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_note_status IN ('pending', 'activated', 'fulfilled')
     AND p_ends_on >= (now() AT TIME ZONE 'Africa/Kampala')::date
     AND public.partner_note_window_applies(p_owner, p_agent_then, p_agent_now, p_person);
$function$;
REVOKE ALL ON FUNCTION public.partner_note_window_open(text, date, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- existing: true when the existing-partner or signed-agreement rate applies to the person right now
-- (or would, while the switch is off after a cut-off), whichever rate won. The gate keeps it on each new portfolio (rate_existing_at_decision).
-- DROP + CREATE: the result gained that column (a re-apply drops and re-creates it too); the grants
-- below are the only ones it ever had (service_role only).
DROP FUNCTION IF EXISTS public.partner_rates_for(uuid[]);
DROP FUNCTION IF EXISTS public.partner_rates_for(uuid[], boolean);
CREATE FUNCTION public.partner_rates_for(p_ids uuid[], p_include_notes boolean DEFAULT true)
 RETURNS TABLE (partner_id uuid, rate numeric, basis text, existing boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH RECURSIVE pol AS MATERIALIZED (
    SELECT p.* FROM public.partner_return_policy p WHERE p.id
  ), ids AS (
    SELECT DISTINCT u AS pid FROM unnest(COALESCE(p_ids, '{}'::uuid[])) u WHERE u IS NOT NULL
  ), chain AS (
    -- Each live portfolio, then the portfolios it was carved from (split / lock: locked_from_portfolio_id),
    -- the same investor's only, at most 32 levels, never visiting a portfolio twice. Phase 4 (§2.7 #1): a
    -- split of a split (or a lock of a split) keeps the partner existing after the original and the
    -- middle portfolio are redeemed.
    SELECT ip.investor_id AS pid, ip.locked_from_portfolio_id AS up, ip.rate_decided_at, ip.rate_basis,
           ip.rate_existing_at_decision AS ex, ARRAY[ip.id] AS seen
      FROM ids i
      JOIN public.investor_portfolios ip
        ON ip.investor_id = i.pid AND ip.status = ANY (public.partner_live_portfolio_statuses())
    UNION ALL
    SELECT c.pid, par.locked_from_portfolio_id, par.rate_decided_at, par.rate_basis, par.rate_existing_at_decision,
           c.seen || par.id
      FROM chain c
      JOIN public.investor_portfolios par ON par.id = c.up AND par.investor_id = c.pid
     WHERE cardinality(c.seen) < 32 AND par.id <> ALL (c.seen)
  ), continuing AS MATERIALIZED (
    -- Still holding what made them existing: a live portfolio whose carve-out chain holds a portfolio
    -- from before the cut-off (or before the gate), or one opened by an existing partner or signer:
    -- on that basis, or recorded as existing at the decision (an existing partner who is also staff
    -- gets 'employee' on a tie at 20, a note's rate can win too; their portfolio still keeps them
    -- existing). A chain that starts from a portfolio opened as a new partner stays new.
    SELECT DISTINCT c.pid
      FROM chain c, pol
     WHERE c.rate_decided_at IS NULL
        OR c.rate_decided_at < pol.cutoff_at
        OR c.rate_basis IN ('existing_partner', 'signed_agreement')
        OR c.ex
  ), facts AS MATERIALIZED (
    SELECT i.pid,
           EXISTS (SELECT 1 FROM public.hr_staff s WHERE s.user_id = i.pid AND s.active) AS is_staff,
           co.basis AS cohort_basis,
           co.max_rate AS cohort_max,
           k.pid IS NOT NULL AS has_live_continuing,
           EXISTS (SELECT 1 FROM public.investor_portfolios ip, pol
                    WHERE ip.investor_id = i.pid
                      AND ip.rate_decided_at >= pol.cutoff_at
                      AND (ip.status = ANY (public.partner_live_portfolio_statuses())
                           OR ip.status = 'redeemed')) AS funded_since_cutoff,
           CASE WHEN p_include_notes THEN
             (SELECT max(x.rate) FROM (
                SELECT ip.entitled_rate AS rate FROM public.investor_portfolios ip
                 WHERE ip.investor_id = i.pid
                   AND ip.status = ANY (public.partner_live_portfolio_statuses())
                   AND ip.rate_basis = 'promissory_note'
                UNION ALL
                -- A note linked late: the CFO-approved catch-up counts like a note-funded portfolio.
                SELECT a.requested_rate FROM public.investor_portfolios ip
                  JOIN public.portfolio_rate_approvals a ON a.portfolio_id = ip.id
                 WHERE ip.investor_id = i.pid
                   AND ip.status = ANY (public.partner_live_portfolio_statuses())
                   AND a.source = 'note_late_link' AND a.status = 'approved'
                   AND a.applied_at IS NOT NULL) x)
           END AS note_portfolio_rate,
           CASE WHEN p_include_notes THEN
             (SELECT max(w.return_rate)
                FROM public.promissory_notes n
                JOIN public.partner_return_note_windows w ON w.note_id = n.id
               WHERE n.partner_user_id = i.pid
                 AND public.partner_note_window_open(n.status, w.ends_on, w.partner_user_id, w.agent_id, n.agent_id, i.pid))
           END AS open_note_rate
      FROM ids i
      LEFT JOIN public.partner_return_cohort co ON co.partner_id = i.pid
      LEFT JOIN continuing k ON k.pid = i.pid             -- one row per person (DISTINCT): a hash join, not a scan per person
  ), parts AS MATERIALIZED (
    SELECT f.pid,
           pol.enabled,
           pol.legacy_rate,
           pol.new_contract_rate AS r_new,
           CASE WHEN f.is_staff THEN pol.employee_rate END AS r_employee,
           CASE WHEN f.cohort_basis = 'live_portfolio' AND f.has_live_continuing THEN
                  CASE pol.existing_partner_mode
                    WHEN 'fixed' THEN pol.existing_partner_rate
                    ELSE LEAST(f.cohort_max, COALESCE(pol.existing_partner_cap, f.cohort_max))
                  END
           END AS r_existing,
           CASE WHEN f.cohort_basis = 'signed_agreement'
                 AND (f.has_live_continuing OR NOT f.funded_since_cutoff)
                THEN pol.legacy_rate END AS r_signed,
           GREATEST(f.note_portfolio_rate, f.open_note_rate) AS r_note
      FROM facts f CROSS JOIN pol
  )
  SELECT x.pid,
         trim_scale(CASE WHEN NOT x.enabled THEN x.legacy_rate ELSE x.best END),
         CASE WHEN NOT x.enabled THEN 'switch_off'
              WHEN x.r_employee IS NOT NULL AND x.r_employee = x.best THEN 'employee'
              WHEN x.r_existing IS NOT NULL AND x.r_existing = x.best THEN 'existing_partner'
              WHEN x.r_signed   IS NOT NULL AND x.r_signed   = x.best THEN 'signed_agreement'
              WHEN x.r_note     IS NOT NULL AND x.r_note     = x.best THEN 'promissory_note'
              ELSE 'new' END,
         -- Whether the person counts as existing, computed with the switch off too (after a cut-off;
         -- before one the cohort is empty, so false): the gate stamps it on portfolios opened during
         -- an off period, so they keep the person existing when the switch comes back on. Rate and
         -- basis stay the switch-off ones.
         (x.r_existing IS NOT NULL OR x.r_signed IS NOT NULL)
    FROM (SELECT p.*, GREATEST(p.r_new, p.r_employee, p.r_existing, p.r_signed, p.r_note) AS best
            FROM parts p) x;
$function$;
REVOKE ALL ON FUNCTION public.partner_rates_for(uuid[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_rates_for(uuid[], boolean) TO service_role;
COMMENT ON FUNCTION public.partner_rates_for(uuid[], boolean) IS
  'THE Partner Returns rule: the rate a NEW portfolio earns for each person, and why. Batch-first; never call it in a loop. Not granted to browsers: the basis reveals staff and existing-partner status.';

CREATE OR REPLACE FUNCTION public.partner_rate_for(p_partner uuid)
 RETURNS TABLE (rate numeric, basis text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT r.rate, r.basis FROM public.partner_rates_for(ARRAY[p_partner], true) r;
$function$;
REVOKE ALL ON FUNCTION public.partner_rate_for(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_rate_for(uuid) TO service_role;

-- What a NEW partner earns right now: the public rate for offers, share links and calculators
-- (10 when the switch is on, the legacy 15 while it is off). Never a person's own rate.
CREATE OR REPLACE FUNCTION public.partner_new_contract_rate()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (SELECT trim_scale(CASE WHEN p.enabled THEN p.new_contract_rate ELSE p.legacy_rate END)
       FROM public.partner_return_policy p WHERE p.id),
    15::numeric);
$function$;
REVOKE ALL ON FUNCTION public.partner_new_contract_rate() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_new_contract_rate() TO authenticated, service_role;

-- The rate a promissory note is written at: legacy while the switch is off; after it, the
-- person's own rate WITHOUT any note basis (so a new note can never extend an old note's 15%);
-- the new-partner rate when no person is linked yet.
CREATE OR REPLACE FUNCTION public.partner_note_rate_for(p_partner uuid)
 RETURNS TABLE (rate numeric, basis text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT trim_scale(CASE WHEN NOT p.enabled THEN p.legacy_rate
                         WHEN p_partner IS NULL THEN p.new_contract_rate
                         ELSE r.rate END),
         CASE WHEN NOT p.enabled THEN 'legacy'
              WHEN p_partner IS NULL THEN 'new'
              ELSE r.basis END
    FROM public.partner_return_policy p
    LEFT JOIN LATERAL (SELECT x.rate, x.basis FROM public.partner_rates_for(ARRAY[p_partner], false) x) r ON true
   WHERE p.id;
$function$;
REVOKE ALL ON FUNCTION public.partner_note_rate_for(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_note_rate_for(uuid) TO service_role;

-- The cut-off moment (public: get_partner_return_policy already shows it). Used by the note
-- guard, which runs as the browser's role.
CREATE OR REPLACE FUNCTION public.partner_return_cutoff_at()
 RETURNS timestamptz
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT p.cutoff_at FROM public.partner_return_policy p WHERE p.id $function$;
REVOKE ALL ON FUNCTION public.partner_return_cutoff_at() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_return_cutoff_at() TO anon, authenticated, service_role;

-- One lock per person for rate decisions. Everything that decides a person's rate, or catches it up,
-- takes it first: the portfolio gate (section 5), and in Phase 2 the late-link trigger and the
-- rent-facilitation reward stamp. Without it, a portfolio opened while a note is being linked to the
-- same person can miss the note, and the late-link catch-up can miss the portfolio.
-- The keys are bucketed (256): a transaction that touches thousands of people (a bulk link, a
-- backfill) holds at most 256 advisory locks instead of one per person, which could fill the shared
-- lock table (production: 64 x 160 = 10,240 entries) and fail other sessions. Two people in the same
-- bucket only wait for each other's transaction. One call takes its buckets in ascending order, so
-- two calls never deadlock each other; a transaction that decides several people through separate
-- calls (row triggers in a bulk statement or script) takes them in row order, so two such bulk
-- transactions running at the same time can deadlock (one is rolled back). Every production path
-- decides one person per transaction (smoke_promissory_support_modes decides two and always rolls
-- back); run bulk rate-deciding SQL one at a time. Held until the transaction ends.
CREATE OR REPLACE FUNCTION public.partner_rate_lock(p_people uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_bucket integer;
BEGIN
  FOR v_bucket IN
    SELECT DISTINCT hashtext(x.p::text) & 255 FROM unnest(p_people) AS x(p) WHERE x.p IS NOT NULL ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('partner-rate'), v_bucket);
  END LOOP;
END $function$;
REVOKE ALL ON FUNCTION public.partner_rate_lock(uuid[]) FROM PUBLIC, anon, authenticated, service_role;


-- ===========================================================================
-- 3. Guards on the control tables
-- ===========================================================================

-- * The cut-off is set only by the first switch-on, and then never changes.
-- * The switch cannot go on until the Phase 2 migration has marked every creation path ready.
-- * The first switch-on freezes, in the same transaction, the existing-partner list and the
--   windows of promissory notes written before it. Every way of turning the switch on (the CEO
--   function, or a database-owner session) goes through this trigger.
-- * Any change to a setting (rates, mode, cap, grace, recipients, readiness) is audited and
--   emailed. The switch itself and the new-partner rate are audited by set_partner_return_policy.
CREATE OR REPLACE FUNCTION public.partner_return_policy_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_broken text;
  v_lt     text := current_setting('lock_timeout');
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'The Partner Returns policy row cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF NEW.cutoff_at IS DISTINCT FROM OLD.cutoff_at THEN
    RAISE EXCEPTION 'The Partner Returns cut-off is set only by the first switch-on and never changes'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.enabled AND NOT OLD.enabled THEN
    IF NOT NEW.release_ready THEN
      RAISE EXCEPTION 'Partner Returns cannot be turned on yet: the release (creation paths, agreements, edge functions and screens using each person''s rate) is not complete'
        USING ERRCODE = '55000';
    END IF;
    -- Everything the rule depends on must be in place. rates_conform is history, not a
    -- precondition; the readiness flag was checked just above.
    SELECT string_agg(c.check_name, ', ' ORDER BY c.check_name) INTO v_broken
      FROM public.assert_partner_return_policy_intact() c
     WHERE NOT c.ok AND c.check_name NOT IN ('rates_conform', 'release_ready');
    IF v_broken IS NOT NULL THEN
      RAISE EXCEPTION 'Partner Returns cannot be turned on: these checks fail: % (see assert_partner_return_policy_intact())', v_broken
        USING ERRCODE = '55000';
    END IF;
    -- Phase 4's release-only checks (4b masks, the security migration, ...). The assert runs them only
    -- once release_ready is stored, so one UPDATE that sets release_ready and enabled together would
    -- skip them; NEW.release_ready is required above, so run them as release checks here.
    IF to_regprocedure('public._partner_return_phase4_checks(boolean)') IS NOT NULL THEN
      SELECT string_agg(c.check_name, ', ' ORDER BY c.check_name) INTO v_broken
        FROM public._partner_return_phase4_checks(true) c
       WHERE NOT c.ok;
      IF v_broken IS NOT NULL THEN
        RAISE EXCEPTION 'Partner Returns cannot be turned on: these release checks fail: % (see _partner_return_phase4_checks(true))', v_broken
          USING ERRCODE = '55000';
      END IF;
    END IF;
    NEW.enabled_at := clock_timestamp();
    IF OLD.cutoff_at IS NULL THEN
      -- The snapshot must see everything committed before it (READ COMMITTED takes a fresh
      -- snapshot per statement, after the lock below).
      IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Turn Partner Returns on in a READ COMMITTED transaction (found %)',
          current_setting('transaction_isolation') USING ERRCODE = '55000';
      END IF;
      -- Hold new portfolio writes for the few hundred milliseconds the snapshot takes, so nobody is
      -- half in, half out. SHARE waits for in-flight writers to commit and does not block reads.
      -- While it waits, every other portfolio writer queues behind it, so it waits at most 0.5 s and
      -- then gives up with nothing changed (switch on outside the payout cron windows; retry).
      PERFORM set_config('lock_timeout', '500ms', true);
      BEGIN
        LOCK TABLE public.investor_portfolios IN SHARE MODE;
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'Partner Returns was not switched on: portfolios are being updated right now (a payout, top-up or rate change in progress). Nothing was changed; try again in a minute.'
          USING ERRCODE = '55P03',
                HINT = 'Switch on outside the payout runs (06:00-09:30, 15:00-16:20, 20:50-21:15, 23:50-00:15 and 01:30-01:50 UTC).';
      END;
      PERFORM set_config('lock_timeout', v_lt, true);
      NEW.cutoff_at := clock_timestamp();
      PERFORM set_config('app.partner_cohort_snapshot', 'on', true);

      INSERT INTO public.partner_return_cohort (partner_id, basis, live_portfolios, min_rate, max_rate, snapshot_at)
      SELECT ip.investor_id, 'live_portfolio', count(*)::int, min(ip.roi_percentage), max(ip.roi_percentage), NEW.cutoff_at
        FROM public.investor_portfolios ip
       WHERE ip.investor_id IS NOT NULL
         AND ip.status = ANY (public.partner_live_portfolio_statuses())
       GROUP BY ip.investor_id
      UNION ALL
      SELECT pa.partner_id, 'signed_agreement', 0, NULL, NULL, NEW.cutoff_at
        FROM public.partner_agreements pa
       WHERE pa.partner_signature_data_url IS NOT NULL
         AND pa.countersigned_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.investor_portfolios ip
                          WHERE ip.investor_id = pa.partner_id
                            AND ip.status = ANY (public.partner_live_portfolio_statuses()));

      -- Note windows: the later of the note's due date (or recorded date) and the cut-off date,
      -- plus the grace days, frozen now, with who the window is for and the contacts to prove.
      INSERT INTO public.partner_return_note_windows (note_id, return_rate, ends_on, snapshot_at, partner_user_id, agent_id,
                                                      contact_phones, contact_email)
      SELECT n.id, n.return_rate,
             GREATEST(COALESCE(n.fulfilment_due_on, n.recorded_on),
                      (NEW.cutoff_at AT TIME ZONE 'Africa/Kampala')::date) + NEW.note_grace_days,
             NEW.cutoff_at, n.partner_user_id, n.agent_id,
             array_remove(ARRAY[public.normalize_phone_last9(n.whatsapp_number),
                                public.normalize_phone_last9(n.phone_number)], NULL),
             lower(NULLIF(btrim(n.email), ''))
        FROM public.promissory_notes n
       WHERE n.status IN ('pending', 'activated', 'fulfilled');

      INSERT INTO public.partner_return_legacy_portfolios (portfolio_id, snapshot_at)
      SELECT ip.id, NEW.cutoff_at FROM public.investor_portfolios ip WHERE ip.rate_decided_at IS NULL;

      PERFORM set_config('app.partner_cohort_snapshot', 'off', true);
    END IF;
  ELSIF OLD.enabled AND NOT NEW.enabled THEN
    NEW.enabled_at := NULL;   -- "on since"; the cut-off stays where it is
  END IF;

  IF (NEW.legacy_rate, NEW.existing_partner_mode, NEW.existing_partner_rate, NEW.existing_partner_cap,
      NEW.employee_rate, NEW.note_grace_days, NEW.alert_emails, NEW.release_ready)
     IS DISTINCT FROM
     (OLD.legacy_rate, OLD.existing_partner_mode, OLD.existing_partner_rate, OLD.existing_partner_cap,
      OLD.employee_rate, OLD.note_grace_days, OLD.alert_emails, OLD.release_ready) THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, old_values, new_values, reason)
    VALUES (auth.uid(), 'partner_return_policy_settings_changed', 'partner_return_policy', 'singleton',
            to_jsonb(OLD), to_jsonb(NEW), NEW.note);
    PERFORM public._partner_return_alert(
      'Partner Returns settings changed',
      'A Partner Returns setting was changed'
        || CASE WHEN auth.uid() IS NULL THEN ' from a database-owner session.' ELSE '.' END
        || E'\nLegacy rate: ' || OLD.legacy_rate || ' -> ' || NEW.legacy_rate
        || E'\nExisting partners: ' || OLD.existing_partner_mode || ' -> ' || NEW.existing_partner_mode
        || ' (fixed ' || OLD.existing_partner_rate || ' -> ' || NEW.existing_partner_rate
        || ', cap ' || COALESCE(OLD.existing_partner_cap::text, 'none') || ' -> ' || COALESCE(NEW.existing_partner_cap::text, 'none') || ')'
        || E'\nEmployees: ' || OLD.employee_rate || ' -> ' || NEW.employee_rate
        || E'\nNote grace days: ' || OLD.note_grace_days || ' -> ' || NEW.note_grace_days
        || E'\nReady to switch on: ' || OLD.release_ready || ' -> ' || NEW.release_ready,
      'settings:' || txid_current()::text);
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.partner_return_policy_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_partner_return_policy_guard ON public.partner_return_policy;
CREATE TRIGGER trg_partner_return_policy_guard
  BEFORE UPDATE OR DELETE ON public.partner_return_policy
  FOR EACH ROW EXECUTE FUNCTION public.partner_return_policy_guard();

-- The existing-partner list and the note windows are append-only and written only by the
-- switch-on snapshot.
CREATE OR REPLACE FUNCTION public.partner_return_cohort_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND COALESCE(current_setting('app.partner_cohort_snapshot', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'This list is fixed at the Partner Returns cut-off and cannot be changed (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END $function$;
REVOKE ALL ON FUNCTION public.partner_return_cohort_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_partner_return_cohort_guard ON public.partner_return_cohort;
CREATE TRIGGER trg_partner_return_cohort_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.partner_return_cohort
  FOR EACH ROW EXECUTE FUNCTION public.partner_return_cohort_guard();
DROP TRIGGER IF EXISTS trg_partner_return_cohort_no_truncate ON public.partner_return_cohort;
CREATE TRIGGER trg_partner_return_cohort_no_truncate
  BEFORE TRUNCATE ON public.partner_return_cohort
  FOR EACH STATEMENT EXECUTE FUNCTION public.partner_return_cohort_guard();

DROP TRIGGER IF EXISTS trg_partner_return_note_windows_guard ON public.partner_return_note_windows;
CREATE TRIGGER trg_partner_return_note_windows_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.partner_return_note_windows
  FOR EACH ROW EXECUTE FUNCTION public.partner_return_cohort_guard();
DROP TRIGGER IF EXISTS trg_partner_return_note_windows_no_truncate ON public.partner_return_note_windows;
CREATE TRIGGER trg_partner_return_note_windows_no_truncate
  BEFORE TRUNCATE ON public.partner_return_note_windows
  FOR EACH STATEMENT EXECUTE FUNCTION public.partner_return_cohort_guard();

DROP TRIGGER IF EXISTS trg_partner_return_legacy_guard ON public.partner_return_legacy_portfolios;
CREATE TRIGGER trg_partner_return_legacy_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.partner_return_legacy_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.partner_return_cohort_guard();
DROP TRIGGER IF EXISTS trg_partner_return_legacy_no_truncate ON public.partner_return_legacy_portfolios;
CREATE TRIGGER trg_partner_return_legacy_no_truncate
  BEFORE TRUNCATE ON public.partner_return_legacy_portfolios
  FOR EACH STATEMENT EXECUTE FUNCTION public.partner_return_cohort_guard();


-- ===========================================================================
-- 4. Promissory notes: stamp the rate once; the browser cannot change it later
-- ===========================================================================

-- BEFORE INSERT, runs as the owner so it can read the rule. Ignores any client-supplied rate.
-- Named to fire after trg_link_promissory_note_partner, so partner_user_id is already linked.
CREATE OR REPLACE FUNCTION public.stamp_promissory_note_return_rate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rate  numeric;
  v_basis text;
BEGIN
  SELECT r.rate, r.basis INTO v_rate, v_basis FROM public.partner_note_rate_for(NEW.partner_user_id) r;
  NEW.return_rate       := COALESCE(v_rate, 15);
  NEW.return_rate_basis := COALESCE(v_basis, 'legacy');
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.stamp_promissory_note_return_rate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_zz_stamp_note_return_rate ON public.promissory_notes;
CREATE TRIGGER trg_zz_stamp_note_return_rate
  BEFORE INSERT ON public.promissory_notes
  FOR EACH ROW EXECUTE FUNCTION public.stamp_promissory_note_return_rate();

-- BEFORE UPDATE, runs as the CALLER. A browser session (authenticated/anon) or an edge function
-- (service_role; activate-promissory-note takes the account from the request) may not:
--   * change a note's rate or its basis;
--   * move a note from one person to another (a linked note carries that person's rate);
--   * after the cut-off, link a note that had no person (a pre-cut-off note carries 15%, so
--     linking decides who gets it). Genuine linking runs through the owner's SECURITY DEFINER
--     functions (link_promissory_notes_for_user, link_proxy_records_on_profile,
--     promissory_confirm_arrival_match), which this guard does not affect (Phase 4's
--     trg_zz_guard_note_window_link, named to fire after this one, holds any of their links that
--     would open a pre-cut-off window for a person who has not proved the note's contact).
CREATE OR REPLACE FUNCTION public.guard_promissory_note_return_rate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user IN ('authenticated', 'anon', 'service_role') THEN
    IF NEW.return_rate IS DISTINCT FROM OLD.return_rate
       OR NEW.return_rate_basis IS DISTINCT FROM OLD.return_rate_basis THEN
      RAISE EXCEPTION 'A promissory note''s Returns rate is fixed when the note is written'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.partner_user_id IS NOT NULL AND NEW.partner_user_id IS DISTINCT FROM OLD.partner_user_id THEN
      RAISE EXCEPTION 'A promissory note cannot be moved to another partner'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.partner_user_id IS NULL AND NEW.partner_user_id IS NOT NULL
       AND public.partner_return_cutoff_at() IS NOT NULL THEN
      RAISE EXCEPTION 'Link a promissory note to a partner through the partner-linking tools, not directly'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.guard_promissory_note_return_rate() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_zz_guard_note_return_rate ON public.promissory_notes;
CREATE TRIGGER trg_zz_guard_note_return_rate
  BEFORE UPDATE OF return_rate, return_rate_basis, partner_user_id ON public.promissory_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_promissory_note_return_rate();


-- ===========================================================================
-- 5. The portfolio gate
-- ===========================================================================

-- 5a. A carved-off (split / lock) portfolio keeps its parent's rate and skips the funding debit,
--     so only the owner's split_portfolio_principal / lock_portfolio_principal (SECURITY
--     DEFINER) may create one. Runs as the CALLER, before the gate. No browser code sets
--     locked_from_portfolio_id; this also closes a browser route to an unfunded portfolio.
--     The link never changes afterwards from a browser or edge session (authenticated, anon or
--     service_role): partner_rates_for walks it to decide who is still an existing partner, so
--     re-pointing a new portfolio at a redeemed pre-cut-off one would make a returning partner
--     existing again (staff hold a column UPDATE grant and admin UPDATE policies on the table).
--     Production's only writers are the owner-run split / lock tools (inserts) and
--     delete_portfolio_and_refund (owner-run), checked 2026-11-07.
--     After the cut-off a browser or edge session also cannot move a portfolio from one partner to
--     ANOTHER (investor_id non-null to a different non-null value): the gate keeps the old stamps when
--     the old investor was set, so a COO or manager UPDATE would hand an existing partner's 20%
--     portfolio to a new partner with no CFO request (production lets staff update investor_id: a
--     column UPDATE grant, the COO / manager UPDATE policies, and the field-immutability trigger
--     exempts staff). Setting it from NULL (activate-supporter) or to NULL (delete-user) - the only
--     investor_id writers in src and edge code - stays allowed; owner-run tools are not affected.
--     Before any cut-off nothing changes (switch-off parity).
CREATE OR REPLACE FUNCTION public.guard_partner_return_carry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user IN ('authenticated', 'anon', 'service_role') THEN
    IF (CASE WHEN TG_OP = 'INSERT'
             THEN NEW.locked_from_portfolio_id IS NOT NULL AND current_user <> 'service_role'
             ELSE NEW.locked_from_portfolio_id IS DISTINCT FROM OLD.locked_from_portfolio_id END) THEN
      RAISE EXCEPTION 'A portfolio carved from another one can only be created by the split or lock tools'
        USING ERRCODE = '42501';
    END IF;
    -- After the cut-off a portfolio's rate belongs to the person it was decided for: moving it to another
    -- partner would hand that person the old holder's rate (a new partner holding 20%) with no CFO request.
    IF TG_OP = 'UPDATE' AND OLD.investor_id IS NOT NULL AND NEW.investor_id IS NOT NULL
       AND NEW.investor_id <> OLD.investor_id AND public.partner_return_cutoff_at() IS NOT NULL THEN
      RAISE EXCEPTION 'A portfolio cannot be moved to another partner after the Partner Returns cut-off; open a new portfolio for them (their own rate) or ask the CFO'
        USING ERRCODE = '42501';
    END IF;
    -- The same move in two steps (X -> NULL -> Y). After the cut-off a portfolio may lose its partner only
    -- by being cancelled (delete-user does exactly that), and may gain one only when it is a live invite
    -- (activate-supporter links invite portfolios by invite_id) or an invite the gate re-decides
    -- (new_no_investor). A cancelled, redeemed or rejected portfolio is never handed to anyone.
    IF TG_OP = 'UPDATE' AND public.partner_return_cutoff_at() IS NOT NULL THEN
      IF OLD.investor_id IS NOT NULL AND NEW.investor_id IS NULL AND NEW.status IS DISTINCT FROM 'cancelled' THEN
        RAISE EXCEPTION 'After the Partner Returns cut-off a portfolio can lose its partner only by being cancelled'
          USING ERRCODE = '42501';
      END IF;
      IF OLD.investor_id IS NULL AND NEW.investor_id IS NOT NULL
         AND OLD.rate_basis IS DISTINCT FROM 'new_no_investor'
         AND NOT (OLD.invite_id IS NOT NULL AND OLD.status NOT IN ('cancelled', 'redeemed', 'rejected')) THEN
        RAISE EXCEPTION 'A portfolio cannot be given to a partner after the Partner Returns cut-off unless it is their invite; open a new portfolio for them (their own rate) or ask the CFO'
          USING ERRCODE = '42501';
      END IF;
      -- An orphaned (cancelled) portfolio cannot be revived into a claimable invite either.
      IF OLD.investor_id IS NULL AND OLD.status IN ('cancelled', 'redeemed', 'rejected')
         AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'After the Partner Returns cut-off a closed portfolio with no partner cannot be reopened'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.guard_partner_return_carry() FROM PUBLIC, anon;

-- 5b. The gate.
-- INSERT
--   switch off: fill a missing rate with the legacy rate; accept any typed rate; queue nothing.
--   switch on:
--     * a split or lock child of a live parent of the same investor keeps the parent's rate;
--     * salary reinvestment (context set by the payroll function) earns the employee rate;
--     * a missing rate takes the person's rate from the decider; a typed rate equal to it is
--       accepted; any other typed rate is stored at the person's rate and queued for the CFO.
--   Every insert is stamped with entitled_rate / rate_basis / rate_decided_at. After a cut-off,
--   switch on or off, a portfolio with an investor also records whether that person counts as an
--   existing partner (rate_existing_at_decision; off: the rate stays the legacy or typed one).
-- UPDATE
--   * an invite portfolio (no investor yet) that gets its investor is decided again for them (a
--     pending typed-rate request on it is then measured against their rate). That covers invites
--     opened while on (new_no_investor) and invites opened while off AFTER the cut-off (switch_off /
--     typed_switch_off): claimed while on, the claimant's rate applies and a typed rate waits for the
--     CFO, exactly like new_no_investor (D14 honours only offers made before the cut-off); claimed
--     while off, the off rate stays and the existing flag is stamped. Invites opened before the
--     cut-off keep their rate.
--   * the per-person rate lock is taken with a lock_timeout of at most 3 s (the caller's value is
--     restored afterwards), so a creation queued behind a bulk note link fails fast with a
--     retryable 55P03 instead of hanging (runbook: docs/partner-returns-10pct/runbook-bulk-links.md);
--   * switch off: rate changes apply as today; after a cut-off they are also recorded as an
--     applied request, so the conformance check can explain them;
--   * switch on: every rate change waits for the CFO with the old rate kept in force, except the
--     next-cycle job applying an approved request in its own transaction; a portfolio under a
--     Returns hold is left for trg_zz_portfolio_return_hold to refuse, as today.
--   Decision stamps never change otherwise.
-- Fires after the existing BEFORE triggers (alphabetical order).
CREATE OR REPLACE FUNCTION public.enforce_partner_return_rate_policy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pol    public.partner_return_policy%ROWTYPE;
  v_on     boolean;
  v_rate   numeric;
  v_basis  text;
  v_ex     boolean;
  v_parent record;
  v_ctx    text := COALESCE(current_setting('app.partner_rate_context', true), '');
  v_lt     text := current_setting('lock_timeout');
BEGIN
  SELECT * INTO v_pol FROM public.partner_return_policy p WHERE p.id;
  v_on := COALESCE(v_pol.enabled, false);

  IF TG_OP = 'UPDATE' THEN
    -- An invite portfolio receives its investor: decide the rate for that person now. Invites opened
    -- while the switch was on (new-partner rate), and invites opened while it was off AFTER the
    -- cut-off (an offer made after the cut-off is not honoured, D14), are decided for the claimant.
    -- Switch on: the claimant's rate; a rate typed while off waits for the CFO like any typed rate.
    -- Switch off: the legacy rate (an on-invite never keeps the new-partner rate, which would put an
    -- existing partner below their own rate with nothing flagged) or the rate typed while off; the
    -- existing flag is stamped either way. Invites opened before the cut-off keep their rate.
    IF OLD.investor_id IS NULL AND NEW.investor_id IS NOT NULL
       AND NEW.roi_percentage IS NOT DISTINCT FROM OLD.roi_percentage
       AND OLD.roi_percentage IS NOT DISTINCT FROM OLD.entitled_rate
       AND (OLD.rate_basis = 'new_no_investor'
            OR (OLD.rate_basis IN ('switch_off', 'typed_switch_off')
                AND v_pol.cutoff_at IS NOT NULL
                AND OLD.rate_decided_at >= v_pol.cutoff_at)) THEN
      v_ex := NULL;
      IF v_on OR v_pol.cutoff_at IS NOT NULL THEN
        -- Bounded wait (G1): at most 3 s, never longer than the caller's own lock_timeout.
        IF v_lt::interval = interval '0' OR v_lt::interval > interval '3 seconds' THEN
          PERFORM set_config('lock_timeout', '3s', true);
        END IF;
        BEGIN
          PERFORM public.partner_rate_lock(ARRAY[NEW.investor_id]);
        EXCEPTION WHEN lock_not_available THEN
          RAISE EXCEPTION 'The portfolio was not saved: this partner''s Returns rate is being updated by another change right now. Nothing was changed; try again in a minute.'
            USING ERRCODE = '55P03',
                  HINT = 'A bulk note link or contact backfill holds the rate lock; it is released when that change finishes.';
        END;
        PERFORM set_config('lock_timeout', v_lt, true);
        SELECT r.rate, r.basis, r.existing INTO v_rate, v_basis, v_ex
          FROM public.partner_rates_for(ARRAY[NEW.investor_id], true) r;
      END IF;
      IF v_on THEN
        -- A rate typed while off on an invite opened after the cut-off: the claimant's rate applies and
        -- the typed rate waits for the CFO (no pending request exists: the off path never queues one).
        IF OLD.rate_basis = 'typed_switch_off' AND OLD.roi_percentage IS DISTINCT FROM v_rate THEN
          INSERT INTO public.portfolio_rate_approvals
            (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
          VALUES (NEW.id, OLD.roi_percentage, v_rate, v_rate, 'new_portfolio', auth.uid());
        END IF;
      ELSIF OLD.rate_basis = 'new_no_investor' THEN
        v_rate  := trim_scale(COALESCE(v_pol.legacy_rate, 15));
        v_basis := 'switch_off';
      ELSE
        v_rate  := OLD.roi_percentage;                -- opened while off, claimed while off: rate kept
        v_basis := OLD.rate_basis;
      END IF;
      NEW.roi_percentage  := v_rate;
      NEW.entitled_rate   := v_rate;
      NEW.rate_basis      := v_basis;
      NEW.rate_decided_at := clock_timestamp();
      NEW.rate_existing_at_decision := v_ex;
      -- A rate typed on the invite waits for the CFO against the new-partner rate. Measure it against
      -- the claimant's rate now, so the CFO sees a lowering of an existing partner as a lowering.
      UPDATE public.portfolio_rate_approvals
         SET standard_rate = v_rate, rate_in_force = v_rate
       WHERE portfolio_id = NEW.id AND status = 'pending' AND source = 'new_portfolio';
      RETURN NEW;
    END IF;

    NEW.entitled_rate   := OLD.entitled_rate;
    NEW.rate_basis      := OLD.rate_basis;
    NEW.rate_decided_at := OLD.rate_decided_at;
    NEW.rate_existing_at_decision := OLD.rate_existing_at_decision;

    IF NEW.roi_percentage IS NOT DISTINCT FROM OLD.roi_percentage THEN
      RETURN NEW;
    END IF;

    IF NOT v_on THEN
      IF v_pol.cutoff_at IS NOT NULL THEN
        INSERT INTO public.portfolio_rate_approvals
          (portfolio_id, requested_rate, rate_in_force, standard_rate, source, status, requested_by,
           decided_by, decided_at, decision_note, applied_at, applied_xact)
        VALUES (NEW.id, NEW.roi_percentage, OLD.roi_percentage, OLD.roi_percentage, 'rate_change', 'approved',
                auth.uid(), auth.uid(), now(), 'Applied directly while Partner Returns was switched off',
                now(), txid_current());
      END IF;
      RETURN NEW;                                   -- switch off: today's behaviour
    END IF;

    -- The next-cycle job applying an approved rate in this same transaction.
    IF EXISTS (SELECT 1 FROM public.portfolio_rate_approvals a
                WHERE a.portfolio_id = NEW.id
                  AND a.status = 'approved'
                  AND a.applied_xact = txid_current()
                  AND a.requested_rate = NEW.roi_percentage) THEN
      RETURN NEW;
    END IF;

    -- Under a Returns hold: leave the change for trg_zz_portfolio_return_hold to refuse.
    IF public.is_portfolio_on_hold(NEW.id) THEN
      RETURN NEW;
    END IF;

    -- Any other change: a newer request replaces an older open or scheduled one. The open requests are
    -- locked in id order first, as the CFO decision locks them, so one rate change and a CFO decision
    -- cannot deadlock (one transaction changing several portfolios locks them portfolio by portfolio
    -- and can: change Returns rates one portfolio per transaction). A request that another
    -- transaction opened for this portfolio and committed while this one waited (a late-linked note's
    -- catch-up, or a second staff change) is replaced the same way on a second try, as if it had come
    -- first, instead of failing the change. No sub-transaction: a bulk edit stays cheap.
    FOR v_try IN 1..2 LOOP
      PERFORM 1 FROM public.portfolio_rate_approvals a
       WHERE a.portfolio_id = NEW.id
         AND (a.status = 'pending' OR (a.status = 'approved' AND a.applied_at IS NULL))
       ORDER BY a.id FOR UPDATE;
      UPDATE public.portfolio_rate_approvals
         SET status = 'superseded', decided_at = COALESCE(decided_at, now()),
             decision_note = concat_ws(' · ', decision_note, 'Superseded: replaced by a newer rate request')
       WHERE portfolio_id = NEW.id
         AND (status = 'pending' OR (status = 'approved' AND applied_at IS NULL));
      INSERT INTO public.portfolio_rate_approvals
        (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
      VALUES (NEW.id, NEW.roi_percentage, OLD.roi_percentage, OLD.roi_percentage, 'rate_change', auth.uid())
      ON CONFLICT (portfolio_id) WHERE status = 'pending' DO NOTHING;
      EXIT WHEN FOUND;
      IF v_try = 2 THEN
        RAISE EXCEPTION 'Another Returns rate request for this portfolio was opened at the same moment; try again'
          USING ERRCODE = '23505', CONSTRAINT = 'portfolio_rate_approvals_one_pending';
      END IF;
    END LOOP;
    NEW.roi_percentage := OLD.roi_percentage;      -- the old rate stays until the CFO approves
    RETURN NEW;
  END IF;

  -- INSERT
  NEW.rate_decided_at := clock_timestamp();
  NEW.rate_existing_at_decision := NULL;

  IF NOT v_on THEN
    -- Off after a cut-off: record whether the person counts as existing (rate and basis stay the
    -- switch-off ones), so a portfolio opened during an off period keeps an existing partner existing
    -- when the switch comes back on.
    -- Rate lock with a bounded wait (G1), as on the switch-on path below. Never before a cut-off.
    IF NEW.investor_id IS NOT NULL AND v_pol.cutoff_at IS NOT NULL THEN
      IF v_lt::interval = interval '0' OR v_lt::interval > interval '3 seconds' THEN
        PERFORM set_config('lock_timeout', '3s', true);
      END IF;
      BEGIN
        PERFORM public.partner_rate_lock(ARRAY[NEW.investor_id]);
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'The portfolio was not saved: this partner''s Returns rate is being updated by another change right now. Nothing was changed; try again in a minute.'
          USING ERRCODE = '55P03',
                HINT = 'A bulk note link or contact backfill holds the rate lock; it is released when that change finishes.';
      END;
      PERFORM set_config('lock_timeout', v_lt, true);
      SELECT r.existing INTO v_ex FROM public.partner_rates_for(ARRAY[NEW.investor_id], true) r;
      NEW.rate_existing_at_decision := COALESCE(v_ex, false);
    END IF;
    IF NEW.roi_percentage IS NULL THEN
      NEW.roi_percentage := trim_scale(COALESCE(v_pol.legacy_rate, 15));
      NEW.rate_basis := 'switch_off';
    ELSE
      NEW.rate_basis := 'typed_switch_off';
    END IF;
    NEW.entitled_rate := NEW.roi_percentage;
    RETURN NEW;
  END IF;

  -- Split / lock child (only the owner's split and lock tools get here, see 5a): keeps the rate
  -- of a LIVE parent of the same investor.
  IF NEW.locked_from_portfolio_id IS NOT NULL AND NEW.investor_id IS NOT NULL THEN
    SELECT ip.investor_id, ip.roi_percentage, ip.status INTO v_parent
      FROM public.investor_portfolios ip WHERE ip.id = NEW.locked_from_portfolio_id;
    IF FOUND AND v_parent.investor_id = NEW.investor_id
       AND v_parent.status = ANY (public.partner_live_portfolio_statuses())
       AND (NEW.roi_percentage IS NULL OR NEW.roi_percentage = v_parent.roi_percentage) THEN
      NEW.roi_percentage := v_parent.roi_percentage;
      NEW.entitled_rate  := v_parent.roi_percentage;
      NEW.rate_basis     := 'carried';
      RETURN NEW;
    END IF;
  END IF;

  -- The person's rate, and whether they count as an existing partner right now, kept on the portfolio
  -- whichever basis wins (employee on a tie, a note's rate, salary reinvestment): partner_rates_for
  -- counts a live portfolio opened by an existing partner as continuing, so they keep their own rate.
  -- The rate lock waits at most 3 s (never longer than the caller's own lock_timeout), then fails
  -- with a clear retryable error instead of hanging behind a bulk note link (G1).
  IF NEW.investor_id IS NOT NULL THEN
    IF v_lt::interval = interval '0' OR v_lt::interval > interval '3 seconds' THEN
      PERFORM set_config('lock_timeout', '3s', true);
    END IF;
    BEGIN
      PERFORM public.partner_rate_lock(ARRAY[NEW.investor_id]);
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'The portfolio was not saved: this partner''s Returns rate is being updated by another change right now. Nothing was changed; try again in a minute.'
        USING ERRCODE = '55P03',
              HINT = 'A bulk note link or contact backfill holds the rate lock; it is released when that change finishes.';
    END;
    PERFORM set_config('lock_timeout', v_lt, true);
    SELECT r.rate, r.basis, r.existing INTO v_rate, v_basis, v_ex
      FROM public.partner_rates_for(ARRAY[NEW.investor_id], true) r;
    NEW.rate_existing_at_decision := v_ex;
  END IF;

  -- Salary reinvestment: the payroll function sets this context; browsers cannot set app.* settings.
  -- Earns the employee rate even on a leaver's final payslip.
  IF v_ctx = 'salary_reinvestment'
     AND (NEW.roi_percentage IS NULL OR NEW.roi_percentage = v_pol.employee_rate) THEN
    NEW.roi_percentage := trim_scale(v_pol.employee_rate);
    NEW.entitled_rate  := v_pol.employee_rate;
    NEW.rate_basis     := 'salary_reinvestment';
    RETURN NEW;
  END IF;

  IF NEW.investor_id IS NULL THEN
    v_rate := trim_scale(v_pol.new_contract_rate);  -- never borrow the agent's own rate
    v_basis := 'new_no_investor';
  END IF;

  NEW.entitled_rate := v_rate;
  NEW.rate_basis    := v_basis;
  IF NEW.roi_percentage IS NULL OR NEW.roi_percentage = v_rate THEN
    NEW.roi_percentage := v_rate;
    RETURN NEW;
  END IF;

  INSERT INTO public.portfolio_rate_approvals
    (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
  VALUES (NEW.id, NEW.roi_percentage, v_rate, v_rate, 'new_portfolio', auth.uid());
  NEW.roi_percentage := v_rate;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.enforce_partner_return_rate_policy() FROM PUBLIC, anon, authenticated;


-- ===========================================================================
-- 6. Alerts (Mailgun via the transactional email queue; never SMTP)
-- ===========================================================================
-- Recipients: enabled CEO and CFO accounts, plus partner_return_policy.alert_emails.
-- Best effort: an email failure never blocks the change that triggered it.
CREATE OR REPLACE FUNCTION public._partner_return_alert(p_subject text, p_text text, p_key text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_to   text;
  v_n    integer := 0;
  v_esc  text := replace(replace(replace(COALESCE(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
  v_html text;
BEGIN
  v_html := '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">'
         || '<h2 style="margin:0 0 12px">' || replace(replace(COALESCE(p_subject, ''), '&', '&amp;'), '<', '&lt;') || '</h2>'
         || '<p style="white-space:pre-wrap">' || v_esc || '</p>'
         || '<p style="color:#64748b;font-size:12px">When: '
         || to_char(now() AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI') || ' (Kampala)</p></div>';
  FOR v_to IN
    SELECT DISTINCT lower(btrim(e.addr))
      FROM (SELECT u.email::text AS addr
              FROM public.user_roles ur JOIN auth.users u ON u.id = ur.user_id
             WHERE ur.enabled AND ur.role::text IN ('ceo', 'cfo')
            UNION ALL
            SELECT unnest(p.alert_emails) FROM public.partner_return_policy p WHERE p.id) e
     WHERE e.addr ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  LOOP
    BEGIN
      PERFORM public.enqueue_email('transactional_emails', jsonb_build_object(
        'message_id', gen_random_uuid()::text, 'to', v_to, 'from', 'Welile <noreply@welile.com>',
        'sender_domain', 'notify.welile.com', 'subject', p_subject, 'html', v_html, 'text', p_text,
        'purpose', 'transactional', 'label', 'partner-returns-alert',
        'idempotency_key', 'partner-returns:' || COALESCE(p_key, gen_random_uuid()::text) || ':' || v_to,
        'queued_at', now()));
      v_n := v_n + 1;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'Partner Returns alert to % not queued: %', v_to, SQLERRM;
    END;
  END LOOP;
  RETURN v_n;
EXCEPTION WHEN others THEN
  RAISE WARNING 'Partner Returns alert not sent: %', SQLERRM;
  RETURN v_n;
END $function$;
REVOKE ALL ON FUNCTION public._partner_return_alert(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._partner_return_alert(text, text, text) TO service_role;


-- ===========================================================================
-- 7. Staff API: read the policy, flip the switch (CEO), list and decide requests (CFO)
-- ===========================================================================
CREATE OR REPLACE FUNCTION public._partner_return_policy_caller_ok(p_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Staff with one of p_roles (and, when staff MFA applies to them, a verified second factor:
  -- staff_mfa_ok() is true for everyone until staff_mfa_config.mode is 'admin' or 'all'), or a
  -- backend context (service role / database owner session). A password-only staff session gets
  -- the non-staff answer.
  SELECT CASE
    WHEN auth.uid() IS NOT NULL THEN COALESCE(public._has_enabled_role(auth.uid(), p_roles) AND public.staff_mfa_ok(), false)
    ELSE COALESCE(auth.role(), '') = 'service_role' OR session_user = 'postgres'
  END;
$function$;
REVOKE ALL ON FUNCTION public._partner_return_policy_caller_ok(text[]) FROM PUBLIC, anon, authenticated;

-- Public reference data (no partner data): the switch, the rates and the cut-off.
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
    'updated_at', p.updated_at)
  FROM public.partner_return_policy p WHERE p.id;
$function$;
REVOKE ALL ON FUNCTION public.get_partner_return_policy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_partner_return_policy() TO anon, authenticated, service_role;

-- Only the CEO turns the switch on or off (owner decision 2026-11-06). A direct database-owner
-- session (postgres) is also accepted, for tests and for an emergency switch-off on the CEO's
-- instruction; the service role is NOT accepted, so no edge function can flip it.
-- The first switch-on sets the cut-off and freezes the existing-partner list (see the guard).
CREATE OR REPLACE FUNCTION public.set_partner_return_policy(
  p_enabled boolean,
  p_new_contract_rate numeric DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_old    public.partner_return_policy%ROWTYPE;
  v_new    public.partner_return_policy%ROWTYPE;
  v_cohort integer;
  v_text   text;
BEGIN
  IF v_uid IS NOT NULL THEN
    IF NOT public._has_enabled_role(v_uid, ARRAY['ceo']) THEN
      RAISE EXCEPTION 'Only the CEO can turn Partner Returns on or off' USING ERRCODE = '42501';
    END IF;
    PERFORM public.require_staff_aal2();
  ELSIF session_user <> 'postgres' OR COALESCE(auth.role(), '') = 'service_role' THEN
    RAISE EXCEPTION 'Only the CEO can turn Partner Returns on or off' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'p_enabled is required';
  END IF;
  IF p_new_contract_rate IS NOT NULL AND (p_new_contract_rate <= 0 OR p_new_contract_rate > 100) THEN
    RAISE EXCEPTION 'The rate must be above 0 and at most 100';
  END IF;

  SELECT * INTO v_old FROM public.partner_return_policy WHERE id FOR UPDATE;
  IF v_old.enabled = p_enabled AND (p_new_contract_rate IS NULL OR p_new_contract_rate = v_old.new_contract_rate) THEN
    RETURN public.get_partner_return_policy() || jsonb_build_object('changed', false);
  END IF;

  UPDATE public.partner_return_policy
     SET enabled = p_enabled,
         new_contract_rate = COALESCE(p_new_contract_rate, new_contract_rate),
         updated_by = v_uid,
         updated_at = now(),
         note = COALESCE(NULLIF(btrim(p_note), ''), note)
   WHERE id
  RETURNING * INTO v_new;

  SELECT count(*)::int INTO v_cohort FROM public.partner_return_cohort;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, old_values, new_values, reason)
  VALUES (v_uid, 'set_partner_return_policy', 'partner_return_policy', 'singleton',
          to_jsonb(v_old), to_jsonb(v_new), p_note);

  BEGIN
    INSERT INTO public.system_events (event_type, user_id, metadata)
    VALUES ('partner_return_policy_switched', v_uid,
            jsonb_build_object('enabled', v_new.enabled, 'cutoff_at', v_new.cutoff_at,
                               'new_contract_rate', v_new.new_contract_rate, 'existing_partners', v_cohort));
  EXCEPTION WHEN others THEN
    RAISE WARNING 'system_events not written: %', SQLERRM;
  END;

  v_text := 'Partner Returns was turned ' || CASE WHEN v_new.enabled THEN 'ON' ELSE 'OFF' END
         || CASE WHEN v_uid IS NULL THEN ' from a database-owner session.' ELSE '.' END
         || E'\nCut-off: ' || COALESCE(to_char(v_new.cutoff_at AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY HH24:MI:SS'), 'not set')
         || E'\nExisting partners frozen at the cut-off: ' || v_cohort
         || E'\nNew partners earn: ' || v_new.new_contract_rate || '%'
         || CASE WHEN p_note IS NOT NULL THEN E'\nNote: ' || p_note ELSE '' END;
  PERFORM public._partner_return_alert(
    'Partner Returns switched ' || CASE WHEN v_new.enabled THEN 'ON' ELSE 'OFF' END,
    v_text, 'switch:' || txid_current()::text);

  RETURN public.get_partner_return_policy()
         || jsonb_build_object('changed', true, 'existing_partners', v_cohort);
END $function$;
REVOKE ALL ON FUNCTION public.set_partner_return_policy(boolean, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_partner_return_policy(boolean, numeric, text) TO authenticated;

-- One query for the CFO queue (no per-row lookups).
CREATE OR REPLACE FUNCTION public.list_portfolio_rate_requests(
  p_status text DEFAULT 'pending',
  p_limit integer DEFAULT 200
) RETURNS TABLE (
  request_id uuid, portfolio_id uuid, portfolio_code text, partner_id uuid, partner_name text,
  investment_amount numeric, portfolio_status text, source text,
  requested_rate numeric, rate_in_force numeric, standard_rate numeric, status text,
  requested_by uuid, requested_by_name text, requested_at timestamptz,
  decided_by uuid, decided_at timestamptz, decision_note text,
  applied_at timestamptz, current_rate numeric, stage text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public._partner_return_policy_caller_ok(ARRAY['cfo', 'ceo', 'coo', 'super_admin', 'partner_ops']) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT a.id, a.portfolio_id, ip.portfolio_code, ip.investor_id, inv.full_name,
         ip.investment_amount, ip.status, a.source,
         a.requested_rate, a.rate_in_force, a.standard_rate, a.status,
         a.requested_by, req.full_name, a.requested_at,
         a.decided_by, a.decided_at, a.decision_note,
         a.applied_at, ip.roi_percentage,
         CASE WHEN a.status = 'approved' AND a.applied_at IS NULL THEN 'approved_next_cycle'
              WHEN a.status = 'approved' THEN 'applied'
              ELSE a.status END
    FROM public.portfolio_rate_approvals a
    JOIN public.investor_portfolios ip ON ip.id = a.portfolio_id
    LEFT JOIN public.profiles inv ON inv.id = ip.investor_id
    LEFT JOIN public.profiles req ON req.id = a.requested_by
   WHERE p_status IS NULL OR a.status = p_status
   ORDER BY a.requested_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
END $function$;
REVOKE ALL ON FUNCTION public.list_portfolio_rate_requests(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_portfolio_rate_requests(text, integer) TO authenticated, service_role;

-- Set-based, idempotent batch decision. Only the CFO decides. An approval does NOT touch the
-- portfolio: the rate is applied from the next cycle by apply_due_portfolio_rate_changes().
CREATE OR REPLACE FUNCTION public.cfo_decide_portfolio_rate_requests(
  p_request_ids uuid[],
  p_decision text,
  p_note text DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids      uuid[];
  v_status   text;
  v_decided  jsonb;
  v_n        integer;
BEGIN
  -- The CFO (or a database-owner session); never the service role, so no edge function can
  -- approve a rate.
  IF auth.uid() IS NOT NULL THEN
    IF NOT public._has_enabled_role(auth.uid(), ARRAY['cfo']) THEN
      RAISE EXCEPTION 'Only the CFO can decide partner Returns rates' USING ERRCODE = '42501';
    END IF;
    PERFORM public.require_staff_aal2();
  ELSIF session_user <> 'postgres' OR COALESCE(auth.role(), '') = 'service_role' THEN
    RAISE EXCEPTION 'Only the CFO can decide partner Returns rates' USING ERRCODE = '42501';
  END IF;
  v_status := CASE lower(btrim(COALESCE(p_decision, '')))
                WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' END;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'p_decision must be approve or reject';
  END IF;
  IF v_status = 'rejected' AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reject';
  END IF;

  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_ids
    FROM unnest(COALESCE(p_request_ids, '{}'::uuid[])) x WHERE x IS NOT NULL;
  IF COALESCE(cardinality(v_ids), 0) = 0 THEN
    RETURN jsonb_build_object('decided', 0, 'skipped', 0);
  END IF;
  IF cardinality(v_ids) > 500 THEN
    RAISE EXCEPTION 'At most 500 requests per batch';
  END IF;

  PERFORM 1 FROM public.portfolio_rate_approvals a
   WHERE a.id = ANY (v_ids) ORDER BY a.id FOR UPDATE;

  WITH d AS (
    UPDATE public.portfolio_rate_approvals a
       SET status = v_status, decided_by = auth.uid(), decided_at = now(),
           decided_xact = txid_current(), decision_note = NULLIF(btrim(COALESCE(p_note, '')), '')
     WHERE a.id = ANY (v_ids) AND a.status = 'pending'
     RETURNING a.id, a.portfolio_id, a.requested_rate, a.rate_in_force, a.source)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'request_id', d.id, 'portfolio_id', d.portfolio_id,
           'requested_rate', d.requested_rate, 'rate_in_force', d.rate_in_force, 'source', d.source)), '[]'::jsonb)
    INTO v_decided FROM d;

  v_n := jsonb_array_length(v_decided);
  IF v_n > 0 THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, new_values, reason)
    SELECT auth.uid(), 'cfo_' || v_status || '_portfolio_rate', 'investor_portfolios', r ->> 'portfolio_id', r, p_note
      FROM jsonb_array_elements(v_decided) r;
  END IF;

  RETURN jsonb_build_object('decision', v_status, 'decided', v_n,
                            'skipped', cardinality(v_ids) - v_n,
                            'applies', CASE WHEN v_status = 'approved' THEN 'next_cycle' END,
                            'requests', v_decided);
END $function$;
REVOKE ALL ON FUNCTION public.cfo_decide_portfolio_rate_requests(uuid[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_decide_portfolio_rate_requests(uuid[], text, text) TO authenticated, service_role;

-- Applies approved rates from the next cycle, by the same rule that releases a parked top-up
-- (merge_paidout_topups): the approval must come before the portfolio's latest Returns event
-- (payout approved + 10 days' grace, the latest compounding, or - for self-managed money - the
-- latest paid self-support cycle + 10 days). Until then the current cycle keeps its rate.
-- The self-managed commitment, its funding lines and supported houses move in the same
-- transaction, because self-managed Returns are paid from those rows' monthly_rate.
-- Set-based; skips (and retries next run) any portfolio locked by in-flight work.
CREATE OR REPLACE FUNCTION public.apply_due_portfolio_rate_changes(p_limit integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_grace CONSTANT interval := interval '10 days';
  v_due     uuid[];
  v_locked  uuid[];
  v_applied jsonb;
  v_n       integer;
BEGIN
  IF NOT public._partner_return_policy_caller_ok(ARRAY['cfo', 'super_admin']) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  -- 1. Portfolios with an approved rate whose current cycle has had its Returns event.
  SELECT array_agg(s.portfolio_id ORDER BY s.portfolio_id) INTO v_due
    FROM (
      SELECT a.portfolio_id
        FROM public.portfolio_rate_approvals a
        JOIN public.investor_portfolios ip ON ip.id = a.portfolio_id
        LEFT JOIN LATERAL (
          SELECT max(po.reviewed_at) AS at
            FROM public.pending_wallet_operations po
           WHERE po.source_table = 'investor_portfolios'
             AND po.source_id = ip.id
             AND po.category IN ('roi_payout', 'supporter_platform_rewards')
             AND po.status IN ('approved', 'completed')) lp ON true
        LEFT JOIN LATERAL (
          SELECT max(al.created_at) AS at
            FROM public.audit_logs al
           WHERE ip.roi_mode IN ('monthly_compounding', 'compound')
             AND al.table_name = 'investor_portfolios'
             AND al.record_id = ip.id::text
             AND al.action_type = 'roi_compounded') lc ON true
        LEFT JOIN LATERAL (
          SELECT max(pc.paid_at) AS at
            FROM public.partner_self_payout_cycles pc
           WHERE pc.paid_at IS NOT NULL
             AND pc.commitment_id IN (
                   SELECT fpp.commitment_id FROM public.funder_pending_portfolios fpp
                    WHERE fpp.portfolio_id = ip.id AND fpp.commitment_id IS NOT NULL
                   UNION
                   SELECT psh.commitment_id FROM public.partner_supported_houses psh
                    WHERE psh.portfolio_id = ip.id AND psh.commitment_id IS NOT NULL)) ls ON true
       WHERE a.status = 'approved' AND a.applied_at IS NULL
         AND ip.status = 'active'
         AND NOT public.is_portfolio_on_hold(ip.id)
         AND ((lp.at IS NOT NULL AND a.decided_at < lp.at + c_grace)
           OR (lc.at IS NOT NULL AND a.decided_at < lc.at)
           OR (ls.at IS NOT NULL AND a.decided_at < ls.at + c_grace)
           -- Phase 4 (§2.7 #2, owner decision D10): an approved rate on a NEW portfolio applies before
           -- its first Returns event (nothing paid at the gate's rate yet).
           OR (a.source = 'new_portfolio' AND lp.at IS NULL AND lc.at IS NULL AND ls.at IS NULL))
       ORDER BY a.portfolio_id
       LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000)) s;
  IF v_due IS NULL THEN
    RETURN jsonb_build_object('applied', 0, 'skipped_locked', 0);
  END IF;

  -- 2. Lock what is free (portfolio rows first, id order); anything busy waits for next run.
  SELECT array_agg(l.id ORDER BY l.id) INTO v_locked
    FROM (SELECT ip.id FROM public.investor_portfolios ip
           WHERE ip.id = ANY (v_due) ORDER BY ip.id FOR UPDATE SKIP LOCKED) l;
  -- A hold placed after the due check: skip it now (it would roll the whole batch back).
  SELECT array_agg(x ORDER BY x) INTO v_locked
    FROM unnest(v_locked) x WHERE NOT public.is_portfolio_on_hold(x);
  IF v_locked IS NULL THEN
    RETURN jsonb_build_object('applied', 0, 'skipped_locked', cardinality(v_due));
  END IF;
  PERFORM 1 FROM public.portfolio_rate_approvals a
   WHERE a.portfolio_id = ANY (v_locked) AND a.status = 'approved' AND a.applied_at IS NULL
   ORDER BY a.id FOR UPDATE;

  -- 3. Mark applied (re-checked under the lock), then move the rate in one statement per table.
  WITH m AS (
    UPDATE public.portfolio_rate_approvals a
       SET applied_at = now(), applied_xact = txid_current()
     WHERE a.portfolio_id = ANY (v_locked) AND a.status = 'approved' AND a.applied_at IS NULL
     RETURNING a.id, a.portfolio_id, a.requested_rate)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('request_id', m.id, 'portfolio_id', m.portfolio_id,
                                               'rate', m.requested_rate)), '[]'::jsonb)
    INTO v_applied FROM m;

  v_n := jsonb_array_length(v_applied);
  IF v_n > 0 THEN
    UPDATE public.investor_portfolios ip
       SET roi_percentage = (r ->> 'rate')::numeric
      FROM jsonb_array_elements(v_applied) r
     WHERE ip.id = (r ->> 'portfolio_id')::uuid;

    -- Self-managed money is paid from these rows: keep them on the portfolio's rate.
    UPDATE public.partner_supported_houses h
       SET monthly_rate = (r ->> 'rate')::numeric
      FROM jsonb_array_elements(v_applied) r
     WHERE h.portfolio_id = (r ->> 'portfolio_id')::uuid
       AND h.cancelled_at IS NULL
       AND h.monthly_rate IS DISTINCT FROM (r ->> 'rate')::numeric;

    UPDATE public.partner_self_commitments c
       SET monthly_rate = x.rate
      FROM (SELECT DISTINCT ON (k.cid) k.cid, k.rate FROM (
              SELECT fpp.commitment_id AS cid, (r ->> 'rate')::numeric AS rate
                FROM jsonb_array_elements(v_applied) r
                JOIN public.funder_pending_portfolios fpp ON fpp.portfolio_id = (r ->> 'portfolio_id')::uuid
               WHERE fpp.commitment_id IS NOT NULL
              UNION ALL
              SELECT psh.commitment_id, (r ->> 'rate')::numeric
                FROM jsonb_array_elements(v_applied) r
                JOIN public.partner_supported_houses psh ON psh.portfolio_id = (r ->> 'portfolio_id')::uuid
               WHERE psh.commitment_id IS NOT NULL) k ORDER BY k.cid) x
     WHERE c.id = x.cid
       AND c.monthly_rate IS DISTINCT FROM x.rate;

    UPDATE public.partner_self_funding_lines l
       SET monthly_rate = c.monthly_rate
      FROM public.partner_self_commitments c
     WHERE l.commitment_id = c.id
       AND l.completed_at IS NULL
       AND l.status <> 'cancelled'
       AND l.monthly_rate IS DISTINCT FROM c.monthly_rate
       AND c.id IN (SELECT fpp.commitment_id FROM public.funder_pending_portfolios fpp
                     WHERE fpp.portfolio_id = ANY (v_locked) AND fpp.commitment_id IS NOT NULL
                    UNION
                    SELECT psh.commitment_id FROM public.partner_supported_houses psh
                     WHERE psh.portfolio_id = ANY (v_locked) AND psh.commitment_id IS NOT NULL);

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, new_values, reason)
    SELECT auth.uid(), 'portfolio_rate_applied_next_cycle', 'investor_portfolios', r ->> 'portfolio_id', r,
           'CFO-approved Returns rate applied from the next cycle'
      FROM jsonb_array_elements(v_applied) r;
  END IF;

  RETURN jsonb_build_object('applied', v_n, 'skipped_locked', cardinality(v_due) - cardinality(v_locked),
                            'portfolios', v_applied);
END $function$;
REVOKE ALL ON FUNCTION public.apply_due_portfolio_rate_changes(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_due_portfolio_rate_changes(integer) TO service_role;

-- Staff renewal dialog sets a renewal rate through this, not by writing roi_percentage from the
-- browser. A renewal keeps its rate; asking for a different one is a rate change, so with the
-- switch on it waits for the CFO and the current rate stays. With the switch off it is set
-- directly, as before.
CREATE OR REPLACE FUNCTION public.set_portfolio_renewal_rate(p_portfolio_id uuid, p_requested_rate numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old numeric;
  v_now numeric;
BEGIN
  IF NOT public._partner_return_policy_caller_ok(
       ARRAY['manager', 'coo', 'cfo', 'ceo', 'super_admin', 'financial_ops', 'partner_ops']) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NOT NULL THEN
    PERFORM public.require_staff_aal2();
    -- While the switch is off a rate change applies at once, so keep it to the roles that can
    -- change a Returns rate today; with the switch on every change waits for the CFO.
    IF NOT COALESCE((SELECT p.enabled FROM public.partner_return_policy p WHERE p.id), false)
       AND NOT public._has_enabled_role(auth.uid(), ARRAY['coo', 'manager']) THEN
      RAISE EXCEPTION 'Only the COO or a manager can change a Returns rate at the moment' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_requested_rate IS NULL OR p_requested_rate <= 0 OR p_requested_rate > 100 THEN
    RAISE EXCEPTION 'The Returns rate must be above 0 and at most 100';
  END IF;

  SELECT ip.roi_percentage INTO v_old
    FROM public.investor_portfolios ip WHERE ip.id = p_portfolio_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'portfolio_not_found';
  END IF;

  IF p_requested_rate IS DISTINCT FROM v_old THEN
    UPDATE public.investor_portfolios SET roi_percentage = p_requested_rate WHERE id = p_portfolio_id;
  END IF;

  SELECT ip.roi_percentage INTO v_now FROM public.investor_portfolios ip WHERE ip.id = p_portfolio_id;
  RETURN jsonb_build_object(
    'previous_rate', v_old,
    'rate_in_force', v_now,
    'requested_rate', p_requested_rate,
    'awaits_cfo', EXISTS (SELECT 1 FROM public.portfolio_rate_approvals a
                           WHERE a.portfolio_id = p_portfolio_id AND a.status = 'pending'
                             AND a.requested_rate = p_requested_rate));
END $function$;
REVOKE ALL ON FUNCTION public.set_portfolio_renewal_rate(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_portfolio_renewal_rate(uuid, numeric) TO authenticated, service_role;


-- ===========================================================================
-- 8. Conformance, drift check and alerting
-- ===========================================================================

-- Portfolios decided after the cut-off whose rate does not match what they were entitled to
-- (with no CFO request explaining it), plus self-managed rows that drifted from their
-- portfolio's rate. Empty = healthy. One set-based query; no decider calls per row.
CREATE OR REPLACE FUNCTION public.partner_rate_conformance(p_since timestamptz DEFAULT NULL)
 RETURNS TABLE (portfolio_id uuid, investor_id uuid, stored_rate numeric, entitled_rate numeric,
                rate_basis text, rate_decided_at timestamptz, issue text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH pol AS (SELECT p.cutoff_at FROM public.partner_return_policy p WHERE p.id),
  scope AS (
    SELECT ip.* FROM public.investor_portfolios ip, pol
     WHERE pol.cutoff_at IS NOT NULL
       AND ip.rate_decided_at >= GREATEST(pol.cutoff_at, COALESCE(p_since, pol.cutoff_at))
  )
  SELECT s.id, s.investor_id, s.roi_percentage, s.entitled_rate, s.rate_basis, s.rate_decided_at,
         'rate_differs_without_cfo_request'
    FROM scope s
   WHERE s.roi_percentage IS DISTINCT FROM s.entitled_rate
     AND NOT EXISTS (SELECT 1 FROM public.portfolio_rate_approvals a
                      WHERE a.portfolio_id = s.id AND a.status IN ('pending', 'approved'))
  UNION ALL
  -- Written without passing the gate (trigger disabled, restore, replica mode): no decision stamp
  -- and not one of the portfolios that already existed at the cut-off.
  SELECT ip.id, ip.investor_id, ip.roi_percentage, ip.entitled_rate, ip.rate_basis, ip.rate_decided_at,
         'missing_decision_stamp'
    FROM public.investor_portfolios ip, pol
   WHERE pol.cutoff_at IS NOT NULL
     AND ip.rate_decided_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.partner_return_legacy_portfolios lp WHERE lp.portfolio_id = ip.id)
  UNION ALL
  -- Decided for a person after the cut-off (switch on, or off again: the gate stamps both) but without
  -- recording whether they were an existing partner then (written around the gate), or recorded as not
  -- existing although the existing-partner or signed-agreement rate won: partner_rates_for would
  -- misjudge who is still existing.
  SELECT s.id, s.investor_id, s.roi_percentage, s.entitled_rate, s.rate_basis, s.rate_decided_at,
         'existing_stamp_missing'
    FROM scope s
   WHERE s.investor_id IS NOT NULL
     AND ((s.rate_basis IN ('new', 'existing_partner', 'signed_agreement', 'promissory_note', 'employee',
                            'salary_reinvestment', 'switch_off', 'typed_switch_off')
           AND s.rate_existing_at_decision IS NULL)
          OR (s.rate_basis IN ('existing_partner', 'signed_agreement') AND s.rate_existing_at_decision IS NOT TRUE))
  UNION ALL
  -- An invite claimed by a person but never decided for them: it still carries the new-partner rate it
  -- was opened at (the gate re-decides a claim, switch on or off), with no CFO request explaining it.
  SELECT s.id, s.investor_id, s.roi_percentage, s.entitled_rate, s.rate_basis, s.rate_decided_at,
         'claimed_invite_not_decided'
    FROM scope s
   WHERE s.investor_id IS NOT NULL
     AND s.rate_basis = 'new_no_investor'
     AND NOT EXISTS (SELECT 1 FROM public.portfolio_rate_approvals a
                      WHERE a.portfolio_id = s.id AND a.status IN ('pending', 'approved'))
  UNION ALL
  -- Self-managed Returns are paid from the commitment and its open funding lines.
  SELECT ip.id, ip.investor_id, ip.roi_percentage, c.monthly_rate, 'self_commitment', ip.rate_decided_at,
         'self_commitment_rate_differs'
    FROM public.investor_portfolios ip
    JOIN public.funder_pending_portfolios fpp ON fpp.portfolio_id = ip.id AND fpp.commitment_id IS NOT NULL
    JOIN public.partner_self_commitments c ON c.id = fpp.commitment_id
   WHERE c.monthly_rate IS DISTINCT FROM ip.roi_percentage
     AND (ip.id IN (SELECT s.id FROM scope s)
          OR EXISTS (SELECT 1 FROM public.portfolio_rate_approvals a
                      WHERE a.portfolio_id = ip.id AND a.applied_at IS NOT NULL))
  UNION ALL
  SELECT ip.id, ip.investor_id, ip.roi_percentage, l.monthly_rate, 'self_funding_line', ip.rate_decided_at,
         'self_funding_line_rate_differs'
    FROM public.investor_portfolios ip
    JOIN public.funder_pending_portfolios fpp ON fpp.portfolio_id = ip.id AND fpp.commitment_id IS NOT NULL
    JOIN public.partner_self_funding_lines l ON l.commitment_id = fpp.commitment_id
                                            AND l.completed_at IS NULL AND l.status <> 'cancelled'
   WHERE l.monthly_rate IS DISTINCT FROM ip.roi_percentage
     AND (ip.id IN (SELECT s.id FROM scope s)
          OR EXISTS (SELECT 1 FROM public.portfolio_rate_approvals a
                      WHERE a.portfolio_id = ip.id AND a.applied_at IS NOT NULL))
  UNION ALL
  SELECT ip.id, ip.investor_id, ip.roi_percentage, h.monthly_rate, 'supported_house', ip.rate_decided_at,
         'supported_house_rate_differs'
    FROM public.investor_portfolios ip
    JOIN public.partner_supported_houses h ON h.portfolio_id = ip.id AND h.cancelled_at IS NULL
   WHERE h.monthly_rate IS DISTINCT FROM ip.roi_percentage
     AND (ip.id IN (SELECT s.id FROM scope s)
          OR EXISTS (SELECT 1 FROM public.portfolio_rate_approvals a
                      WHERE a.portfolio_id = ip.id AND a.applied_at IS NOT NULL));
$function$;
REVOKE ALL ON FUNCTION public.partner_rate_conformance(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_rate_conformance(timestamptz) TO service_role;

-- Structural and data checks. Fails closed: a missing function or trigger is a failed check.
CREATE OR REPLACE FUNCTION public.assert_partner_return_policy_intact()
 RETURNS TABLE(check_name text, ok boolean, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pol   public.partner_return_policy%ROWTYPE;
  v_src   text;
  v_bad   integer;
BEGIN
  SELECT * INTO v_pol FROM public.partner_return_policy WHERE id;
  RETURN QUERY SELECT 'policy_row_exists', v_pol.id IS NOT NULL, 'partner_return_policy must hold exactly one row';

  RETURN QUERY SELECT 'gate_trigger_enabled',
    EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.investor_portfolios'::regclass
             AND t.tgname = 'trg_partner_return_rate_policy' AND t.tgenabled <> 'D')
    AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.investor_portfolios'::regclass
             AND t.tgname = 'trg_partner_return_carry_guard' AND t.tgenabled <> 'D'),
    'every new portfolio must pass the Partner Returns gate';

  RETURN QUERY SELECT 'rate_has_no_default',
    EXISTS (SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = 'investor_portfolios'
               AND c.column_name = 'roi_percentage' AND c.column_default IS NULL AND c.is_nullable = 'NO'),
    'the portfolio Returns rate must be required and have no default (the gate fills it)';

  RETURN QUERY SELECT 'decision_stamp_columns',
    (SELECT count(*) = 4 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'investor_portfolios'
        AND c.column_name IN ('entitled_rate', 'rate_basis', 'rate_decided_at', 'rate_existing_at_decision')),
    'each portfolio must record the rate it was entitled to and why';

  RETURN QUERY SELECT 'note_rate_column',
    EXISTS (SELECT 1 FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = 'promissory_notes'
               AND c.column_name = 'return_rate' AND c.is_nullable = 'NO'),
    'each promissory note must record its Returns rate';

  RETURN QUERY SELECT 'note_triggers_enabled',
    (SELECT count(*) = 2 FROM pg_trigger t WHERE t.tgrelid = 'public.promissory_notes'::regclass
       AND t.tgname IN ('trg_zz_stamp_note_return_rate', 'trg_zz_guard_note_return_rate') AND t.tgenabled <> 'D'),
    'promissory notes must be stamped at insert and guarded on update';

  RETURN QUERY SELECT 'cutoff_guards_enabled',
    (SELECT count(*) = 4 FROM pg_trigger t
      WHERE t.tgname IN ('trg_partner_return_policy_guard', 'trg_partner_return_cohort_guard',
                         'trg_partner_return_note_windows_guard', 'trg_partner_return_legacy_guard') AND t.tgenabled <> 'D'),
    'the cut-off, the existing-partner list, the note windows and the legacy list must be protected';

  RETURN QUERY SELECT 'cutoff_set_when_enabled',
    (NOT COALESCE(v_pol.enabled, false))
      OR (v_pol.cutoff_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.partner_return_cohort)),
    'with the switch on, the cut-off must be set and the existing-partner list filled';

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'set_partner_return_policy' LIMIT 1;
  RETURN QUERY SELECT 'switch_ceo_only',
    v_src IS NOT NULL AND position('ARRAY[''ceo'']' in v_src) > 0
      AND v_src !~ 'ARRAY\[[^]]*''cfo''',
    'only the CEO may turn the switch on or off';

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'apply_portfolio_renewal' LIMIT 1;
  RETURN QUERY SELECT 'renewal_keeps_rate',
    v_src IS NOT NULL
      AND v_src !~* 'update\s+(public\.)?investor_portfolios(\s+(as\s+)?\w+)?\s+set\s+([^;]*?,\s*)?(\w+\.)?roi_percentage\s*=',
    'a renewal must keep the portfolio''s stored rate';

  SELECT count(*) INTO v_bad FROM public.partner_rate_conformance(NULL);
  RETURN QUERY SELECT 'rates_conform', v_bad = 0,
    v_bad || ' portfolio(s) since the cut-off have a Returns rate that does not match what they were entitled to (see partner_rate_conformance())';

  RETURN QUERY SELECT 'cron_jobs_scheduled',
    CASE WHEN to_regclass('cron.job') IS NULL THEN false
         ELSE (SELECT count(*) = 2 FROM cron.job j
                WHERE j.jobname IN ('apply-portfolio-rate-changes-705pm', 'partner-rate-drift-check') AND j.active) END,
    'the next-cycle job and the drift check must be scheduled';
END $function$;
REVOKE ALL ON FUNCTION public.assert_partner_return_policy_intact() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_partner_return_policy_intact() TO service_role;

-- Every 10 minutes: record failing checks in money_path_drift_events (prefixed partner_rate.),
-- email only when a problem starts or ends, and record the recorder's own failure as an event.
CREATE OR REPLACE FUNCTION public.record_partner_return_policy_drift()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_checks   jsonb;
  v_opened   jsonb;
  v_resolved jsonb;
BEGIN
  BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('name', 'partner_rate.' || c.check_name,
                                                 'ok', c.ok, 'detail', c.detail)), '[]'::jsonb)
      INTO v_checks FROM public.assert_partner_return_policy_intact() c;
  EXCEPTION WHEN others THEN
    v_checks := jsonb_build_array(jsonb_build_object('name', 'partner_rate.recorder_failed',
                                                     'ok', false, 'detail', SQLERRM));
  END;
  -- The recorder itself is healthy whenever the checks above ran.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_checks) x WHERE x ->> 'name' = 'partner_rate.recorder_failed') THEN
    v_checks := v_checks || jsonb_build_array(jsonb_build_object('name', 'partner_rate.recorder_failed', 'ok', true, 'detail', NULL));
  END IF;

  WITH ins AS (
    INSERT INTO public.money_path_drift_events (check_name, detail)
    SELECT x ->> 'name', x ->> 'detail' FROM jsonb_array_elements(v_checks) x
     WHERE NOT (x ->> 'ok')::boolean
       AND NOT EXISTS (SELECT 1 FROM public.money_path_drift_events e
                        WHERE e.check_name = x ->> 'name' AND e.resolved_at IS NULL)
    RETURNING check_name, detail)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', check_name, 'detail', detail)), '[]'::jsonb)
    INTO v_opened FROM ins;

  WITH res AS (
    UPDATE public.money_path_drift_events e SET resolved_at = now()
     WHERE e.resolved_at IS NULL
       AND e.check_name LIKE 'partner\_rate.%'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_checks) x
                    WHERE x ->> 'name' = e.check_name AND (x ->> 'ok')::boolean)
    RETURNING e.check_name)
  SELECT COALESCE(jsonb_agg(check_name), '[]'::jsonb) INTO v_resolved FROM res;

  IF jsonb_array_length(v_opened) > 0 THEN
    BEGIN
      INSERT INTO public.system_events (event_type, metadata)
      VALUES ('partner_rate_drift_detected', jsonb_build_object('checks', v_opened, 'detected_at', now()));
    EXCEPTION WHEN others THEN NULL;
    END;
    PERFORM public._partner_return_alert(
      'Partner Returns check FAILED',
      'These Partner Returns checks started failing:' || E'\n'
        || (SELECT string_agg('- ' || (x ->> 'name') || ': ' || COALESCE(x ->> 'detail', ''), E'\n')
              FROM jsonb_array_elements(v_opened) x)
        || E'\n\nList the affected portfolios with partner_rate_conformance(); a wrong rate is corrected through the CFO queue. Turning Partner Returns off returns NEW portfolios to the legacy 15% for everyone and does not change portfolios already created.',
      'drift-open:' || txid_current()::text);
  END IF;

  IF jsonb_array_length(v_resolved) > 0 THEN
    PERFORM public._partner_return_alert(
      'Partner Returns check recovered',
      'These Partner Returns checks are passing again:' || E'\n'
        || (SELECT string_agg('- ' || x, E'\n') FROM jsonb_array_elements_text(v_resolved) x),
      'drift-resolved:' || txid_current()::text);
  END IF;

  RETURN jsonb_array_length(v_opened);
END $function$;
REVOKE ALL ON FUNCTION public.record_partner_return_policy_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_partner_return_policy_drift() TO service_role;

-- Schedules (UTC). The next-cycle job runs at 16:15, after the 15:00-16:10 payout window closes and
-- after merge-paidout-topups-7pm (16:00), so an approved rate joins on the same evening as a parked
-- top-up without holding portfolio rows during the payout run (the job name keeps '705pm': the
-- checks find it by name). The drift check runs at minute 1, 11, 21, ... (the staggered-minute
-- convention of 20261107152000_cron_stagger_minute_offsets; nothing else of ours runs then).
DO $cron$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron not installed: jobs not scheduled';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'apply-portfolio-rate-changes-705pm') THEN
    PERFORM cron.unschedule('apply-portfolio-rate-changes-705pm');
  END IF;
  PERFORM cron.schedule('apply-portfolio-rate-changes-705pm', '15 16 * * *',
                        $job$ SELECT public.apply_due_portfolio_rate_changes(); $job$);
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'partner-rate-drift-check') THEN
    PERFORM cron.unschedule('partner-rate-drift-check');
  END IF;
  PERFORM cron.schedule('partner-rate-drift-check', '1-59/10 * * * *',
                        $job$ SELECT public.record_partner_return_policy_drift(); $job$);
END $cron$;


-- ===========================================================================
-- 9. The gate triggers and the rate default (strong locks were taken at the top)
-- ===========================================================================
CREATE OR REPLACE TRIGGER trg_partner_return_carry_guard
  BEFORE INSERT OR UPDATE OF locked_from_portfolio_id, investor_id, status ON public.investor_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.guard_partner_return_carry();

CREATE OR REPLACE TRIGGER trg_partner_return_rate_policy
  BEFORE INSERT OR UPDATE OF roi_percentage, entitled_rate, rate_basis, rate_decided_at, rate_existing_at_decision,
                             investor_id
  ON public.investor_portfolios
  FOR EACH ROW EXECUTE FUNCTION public.enforce_partner_return_rate_policy();

-- No default: the gate fills the rate. If the gate were ever missing, an insert without a rate
-- fails loudly (NOT NULL) instead of silently taking a stale number.
ALTER TABLE public.investor_portfolios ALTER COLUMN roi_percentage DROP DEFAULT;
