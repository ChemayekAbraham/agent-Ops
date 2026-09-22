-- Record the `ended_by` constraint change that 20260922120000 required.
--
-- WHY THIS EXISTS SEPARATELY
-- `crm_call_sessions.ended_by` carries a CHECK constraint that allowed only
-- 'crm_user', 'remote_party', 'network' and 'unknown'. The reaper in
-- 20260922120000 writes 'system_reaper', so that migration rolled back on its
-- first attempt. The constraint was then widened by hand in production and the
-- migration re-applied unchanged.
--
-- The widening is correct and is live. It is in no migration file, which means
-- this repository cannot reproduce production - and a schema change that exists
-- only in the database is exactly the shape that caused three separate money
-- incidents here between 10 and 16 September. So it gets written down.
--
-- I should have checked for the constraint before writing a reaper that sets a
-- new value for that column. The rollback was the system working; the gap was
-- mine.
--
-- IDEMPOTENT AND ORDER-INDEPENDENT. On production this re-states what is
-- already there and changes nothing. On a fresh database it must run BEFORE
-- 20260922120000 to keep that migration from rolling back - its filename sorts
-- after, so a clean rebuild applies the reaper first, fails, and stops. That is
-- the correct failure: a clean rebuild of this schema needs the constraint
-- hoisted, and leaving a silent trap for a future rebuild would be worse than
-- saying so here.

DO $ck$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(con.oid) INTO v_def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
   WHERE n.nspname = 'public'
     AND rel.relname = 'crm_call_sessions'
     AND con.conname = 'crm_call_sessions_ended_by_ck';

  IF v_def IS NOT NULL AND position('system_reaper' in v_def) > 0 THEN
    RAISE NOTICE 'ended_by already admits system_reaper - nothing to do';
    RETURN;
  END IF;

  IF v_def IS NOT NULL THEN
    ALTER TABLE public.crm_call_sessions DROP CONSTRAINT crm_call_sessions_ended_by_ck;
  END IF;

  ALTER TABLE public.crm_call_sessions
    ADD CONSTRAINT crm_call_sessions_ended_by_ck
    CHECK (ended_by IS NULL OR ended_by = ANY (ARRAY[
      'crm_user'::text,      -- the staff member hung up
      'remote_party'::text,  -- the other end hung up, or the carrier dropped it
      'network'::text,       -- the leg failed in transit
      'unknown'::text,       -- the provider reported an end with no attributable side
      'system_reaper'::text  -- nobody ended it; crm_reap_stale_call_sessions closed it
    ]));

  RAISE NOTICE 'ended_by widened to admit system_reaper';
END $ck$;

DO $verify$
DECLARE v_def text; v_bad int;
BEGIN
  SELECT pg_get_constraintdef(con.oid) INTO v_def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
   WHERE n.nspname = 'public'
     AND rel.relname = 'crm_call_sessions'
     AND con.conname = 'crm_call_sessions_ended_by_ck';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ended_by constraint is missing entirely - rolled back';
  END IF;

  -- All five values must survive. Dropping one would silently start rejecting
  -- writes from whichever code path uses it, and the provider callback is the
  -- one that would notice last.
  IF position('crm_user' in v_def) = 0
     OR position('remote_party' in v_def) = 0
     OR position('network' in v_def) = 0
     OR position('unknown' in v_def) = 0
     OR position('system_reaper' in v_def) = 0 THEN
    RAISE EXCEPTION 'ended_by constraint lost a value: % - rolled back', v_def;
  END IF;

  -- Nothing already written may violate what we just declared.
  SELECT count(*) INTO v_bad FROM public.crm_call_sessions
   WHERE ended_by IS NOT NULL
     AND ended_by NOT IN ('crm_user','remote_party','network','unknown','system_reaper');
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% existing rows carry an ended_by outside the constraint - rolled back', v_bad;
  END IF;

  RAISE NOTICE 'ended_by constraint recorded and consistent with existing rows';
END $verify$;