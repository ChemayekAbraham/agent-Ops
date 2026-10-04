-- WELILE-CC-ORPHAN19 — unlock the calling hub.
--
-- Problem
--   cc_attempt_before_insert counts EVERY unrecorded attempt for a caller,
--   regardless of which cycle it sits on, and refuses the insert at 3. But
--   cc_my_open_attempts resolved the subject name through v_cc_call_queue and
--   an attempt stranded on an abandoned cycle had no clearing action offered
--   for it, so an operator carrying a stranded attempt could neither see it
--   nor clear it. Their WIP counter stayed pinned at the limit and every
--   reveal was refused. The hub was locked with no way out from the UI.
--
-- Fix
--   1. cc_my_open_attempts returns every unrecorded attempt for the caller
--      whatever the cycle state, resolves the name per subject_type straight
--      from the source views, and flags closed-cycle attempts as `stale`.
--   2. cc_call_attempts.void_reason records why an attempt was written off.
--   3. cc_void_attempt() gives every attempt an unconditional escape hatch, so
--      the WIP guard can never deadlock again.
--   4. cc_abandon_cycle voids the unrecorded attempts it leaves behind, so no
--      new orphans can be created.
--   5. A one-off repair voids the two attempts already orphaned on cycle #1.
--
-- Live open-cycle attempts are deliberately untouched: they are work an
-- operator still owes.

-- ---------------------------------------------------------------- 2. column
ALTER TABLE public.cc_call_attempts
  ADD COLUMN IF NOT EXISTS void_reason text;

COMMENT ON COLUMN public.cc_call_attempts.void_reason IS
  'Set by cc_void_attempt when an attempt is written off rather than worked. '
  'Non-null means the outcome is bookkeeping, not a real call result.';

-- cc_call_attempts_channel_ck was `(recorded_at IS NULL) = (channel IS NULL)`:
-- every recorded attempt had to name a channel. A void records an attempt
-- without a call having been placed, so it has no channel to name, and the old
-- constraint would have forced us to invent one. Carve out exactly the voided
-- case and leave the invariant intact for real outcomes.
ALTER TABLE public.cc_call_attempts
  DROP CONSTRAINT IF EXISTS cc_call_attempts_channel_ck;

ALTER TABLE public.cc_call_attempts
  ADD CONSTRAINT cc_call_attempts_channel_ck CHECK (
    CASE
      WHEN recorded_at IS NULL     THEN channel IS NULL
      WHEN void_reason IS NOT NULL THEN channel IS NULL
      ELSE channel IS NOT NULL
    END
  );

-- ------------------------------------------- state machine: no resurrection
-- Recording an outcome moves the roster row on (unreachable + retry date, or
-- parked at the cap). That is right for a live cycle and wrong for a closed
-- one: voiding a stranded attempt would flip its already-closed row back to
-- 'unreachable', give it a retry date, and resurrect it in the queue of a
-- cycle nobody is working. A closed cycle has nothing left to schedule, so the
-- row transition is skipped there. The attempt itself is still recorded.
CREATE OR REPLACE FUNCTION public.cc_attempt_after_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_retry integer;
  v_cap integer;
  v_attempts integer;
  v_cycle_closed timestamptz;
BEGIN
  IF OLD.recorded_at IS NOT NULL OR NEW.recorded_at IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.retry_after_days, c.attempt_cap, r.attempts_made, c.closed_at
    INTO v_retry, v_cap, v_attempts, v_cycle_closed
  FROM public.cc_cycle_rows r
  JOIN public.cc_call_cycles c ON c.id = r.cycle_id
  WHERE r.id = NEW.cycle_row_id;

  -- Closed cycle: record the attempt, but never re-open its roster row.
  IF v_cycle_closed IS NOT NULL THEN
    RETURN NULL;
  END IF;

  IF NEW.outcome = 'engaged' THEN
    UPDATE public.cc_cycle_rows SET state = 'engaged' WHERE id = NEW.cycle_row_id;
  ELSIF NEW.outcome = 'callback_booked' THEN
    UPDATE public.cc_cycle_rows SET state = 'callback' WHERE id = NEW.cycle_row_id;
  ELSE
    UPDATE public.cc_cycle_rows
       SET state = 'unreachable',
           next_retry_at = now() + (v_retry || ' days')::interval
     WHERE id = NEW.cycle_row_id;

    IF v_attempts >= v_cap THEN
      UPDATE public.cc_cycle_rows
         SET state = 'parked',
             parked_at = now(),
             park_reason = NEW.outcome::text
       WHERE id = NEW.cycle_row_id;
    END IF;
  END IF;

  RETURN NULL;
END;
$function$;

-- ------------------------------------------------------- 1. open attempts
-- The old body resolved the name through v_cc_call_queue, whose per-subject
-- joins and lateral feedback lookups exist to build the roster grid and are
-- far more than a name lookup needs. Identity is now read per subject_type
-- straight from the source view, as a correlated scalar so only the handful of
-- open attempts is ever resolved. A subject that no longer resolves degrades
-- to 'Unnamed' — it never drops the row, because a row you cannot see is a row
-- you cannot clear.
DROP FUNCTION IF EXISTS public.cc_my_open_attempts();

CREATE FUNCTION public.cc_my_open_attempts()
RETURNS TABLE(
  attempt_id   uuid,
  cycle_row_id uuid,
  attempt_no   integer,
  revealed_at  timestamptz,
  subject_type cc_subject_type,
  name         text,
  stale        boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT a.id AS attempt_id,
         a.cycle_row_id,
         a.attempt_no,
         a.revealed_at,
         r.subject_type,
         COALESCE(
           CASE r.subject_type
             WHEN 'tenant' THEN (
               SELECT b.tenant_name
                 FROM public.v_tenant_ops_tenant_base b
                WHERE b.tenant_id = r.subject_id
                ORDER BY b.funded_at DESC NULLS LAST
                LIMIT 1
             )
             WHEN 'landlord' THEN (
               SELECT l.name
                 FROM public.v_landlord_calling_base l
                WHERE l.landlord_id = r.subject_id
                LIMIT 1
             )
             WHEN 'agent' THEN (
               SELECT ag.full_name
                 FROM public.vw_agent_ops_directory ag
                WHERE ag.agent_id = r.subject_id
                LIMIT 1
             )
           END,
           'Unnamed'
         ) AS name,
         (c.closed_at IS NOT NULL) AS stale
    FROM public.cc_call_attempts a
    JOIN public.cc_cycle_rows r  ON r.id = a.cycle_row_id
    JOIN public.cc_call_cycles c ON c.id = r.cycle_id
   WHERE a.caller_id = auth.uid()
     AND a.recorded_at IS NULL
   ORDER BY a.revealed_at ASC NULLS LAST, a.created_at ASC
$function$;

COMMENT ON FUNCTION public.cc_my_open_attempts() IS
  'Every unrecorded attempt for the calling user, whatever the state of its '
  'cycle. stale = the cycle is closed, so the attempt is bookkeeping debt '
  'rather than a call still worth making. Must never omit a row: the WIP '
  'guard counts what this returns.';

REVOKE ALL ON FUNCTION public.cc_my_open_attempts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cc_my_open_attempts() FROM anon;
GRANT EXECUTE ON FUNCTION public.cc_my_open_attempts() TO authenticated;

-- ------------------------------------------------------- 3. cc_void_attempt
-- The escape hatch. An attempt must ALWAYS be clearable, otherwise the WIP
-- guard in cc_attempt_before_insert can strand an operator permanently. A void
-- is recorded as 'refused' with no channel, because no call was placed.
CREATE OR REPLACE FUNCTION public.cc_void_attempt(p_attempt_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  att    public.cc_call_attempts;
  v_note text;
BEGIN
  -- Same permission rule as every other attempt RPC: the caller who opened it,
  -- or operations / hr / super_admin.
  att := public.cc_attempt_guard(p_attempt_id);

  IF att.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Call attempt % is already recorded and cannot be voided.', p_attempt_id;
  END IF;

  -- A blank reason is accepted rather than refused. Clearability is the whole
  -- point of this function; it must not be the thing that blocks an operator.
  v_note := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_note IS NULL THEN
    v_note := 'Voided without a stated reason';
  END IF;

  UPDATE public.cc_call_attempts
     SET recorded_at = now(),
         outcome     = 'refused'::cc_attempt_outcome,
         channel     = NULL,
         void_reason = v_note
   WHERE id = p_attempt_id;
END;
$function$;

COMMENT ON FUNCTION public.cc_void_attempt(uuid, text) IS
  'Clears an unrecorded call attempt without claiming a call was made. Exists '
  'so the open-attempt WIP guard can never deadlock an operator.';

REVOKE ALL ON FUNCTION public.cc_void_attempt(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cc_void_attempt(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cc_void_attempt(uuid, text) TO authenticated;

-- ------------------------------------------------------ 4. cc_abandon_cycle
-- Abandoning a cycle used to close the roster rows and walk away, leaving any
-- unrecorded attempt on them counting against its caller's WIP limit forever.
-- It now voids every unrecorded attempt in the cycle. The voids run AFTER the
-- cycle is marked closed so cc_attempt_after_record sees a closed cycle and
-- leaves the roster rows alone.
CREATE OR REPLACE FUNCTION public.cc_abandon_cycle(p_cycle_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_closed timestamptz;
  v_reason text;
BEGIN
  IF NOT (
    has_role(auth.uid(), 'operations'::app_role)
    OR has_role(auth.uid(), 'hr'::app_role)
    OR has_role(auth.uid(), 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'not authorized to abandon a call cycle';
  END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a reason is required to abandon a cycle';
  END IF;
  v_reason := btrim(p_reason);

  SELECT closed_at INTO v_closed FROM cc_call_cycles WHERE id = p_cycle_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cycle % not found', p_cycle_id;
  END IF;
  IF v_closed IS NOT NULL THEN
    RAISE EXCEPTION 'cycle % is already closed', p_cycle_id;
  END IF;

  UPDATE cc_cycle_rows
     SET state = 'closed'::cc_row_state,
         closed_at = now()
   WHERE cycle_id = p_cycle_id
     AND state IN ('to_call'::cc_row_state,'unreachable'::cc_row_state,'callback'::cc_row_state);

  UPDATE cc_call_cycles
     SET closed_at = now(),
         abandoned_reason = v_reason
   WHERE id = p_cycle_id;

  -- Every row in the cycle, not only the ones the UPDATE above transitioned:
  -- an 'engaged' or 'parked' row can carry an unrecorded attempt too, and the
  -- invariant we need is that a closed cycle holds no unrecorded attempts.
  UPDATE cc_call_attempts a
     SET recorded_at = now(),
         outcome     = 'refused'::cc_attempt_outcome,
         channel     = NULL,
         void_reason = 'Cycle abandoned: ' || v_reason
   WHERE a.recorded_at IS NULL
     AND a.cycle_row_id IN (SELECT r.id FROM cc_cycle_rows r WHERE r.cycle_id = p_cycle_id);
END;
$function$;

-- ------------------------------------------------------------- 5. repair
-- The attempts already stranded by an abandon that predates the cleanup above.
-- Scoped to closed cycles only, so the live open-cycle attempts an operator
-- still owes are left exactly as they are. Re-runnable: the recorded_at IS
-- NULL predicate makes a second pass a no-op.
UPDATE public.cc_call_attempts a
   SET recorded_at = now(),
       outcome     = 'refused'::cc_attempt_outcome,
       channel     = NULL,
       void_reason = 'Orphaned by cycle abandon before cleanup existed'
 WHERE a.recorded_at IS NULL
   AND EXISTS (
     SELECT 1
       FROM public.cc_cycle_rows r
       JOIN public.cc_call_cycles c ON c.id = r.cycle_id
      WHERE r.id = a.cycle_row_id
        AND c.closed_at IS NOT NULL
   );
