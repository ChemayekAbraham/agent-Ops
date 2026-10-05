-- A superseded recall stops reading as a live one.
--
-- `landlord_float_idle_alerts.outcome` was never reset when an agent
-- resubmitted a recalled plan. So a plan that was recalled, resubmitted,
-- re-approved, re-funded and is now happily repaying still read
-- `auto_recalled` — for ever.
--
-- That is not cosmetic. `outcome = 'auto_recalled'` is the key any report uses
-- to mean "the float on this plan was taken back", and on 2026-10-05 it
-- returned 20 plans of which only 6 were actually recalled. It cost an
-- investigation several minutes and would have mis-stated every recall figure
-- anyone built on it.
--
-- WHY `superseded_by_resubmission` AND NOT NULL
--
-- Nulling the column would hide that a recall ever happened, and this is an
-- audit table. The new value answers both questions at once — a recall
-- occurred, and it no longer describes the plan's state. `resolved_at` is
-- preserved so the timestamp of the original recall survives, and the queue
-- filters in 20260925170000 key on `resolved_at IS NULL`, so none of them move.
--
-- There is no CHECK constraint on `outcome`; it already carries four free-text
-- values (`auto_recalled`, `escalated_payout_attempted`, `landlord_paid`,
-- `pre_go_live_manual_review`).

-- 1. Resubmission supersedes the recall -------------------------------------
DO $patch$
DECLARE v_src text; v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'agent_resubmit_rent_request';
  IF v_src IS NULL THEN RAISE EXCEPTION 'agent_resubmit_rent_request not found'; END IF;
  IF v_src LIKE '%superseded_by_resubmission%' THEN
    RAISE NOTICE 'Already applied - resubmission already supersedes the recall.';
    RETURN;
  END IF;

  v_new := replace(v_src,
'         resubmitted_note = trim(p_agent_note), updated_at = now()
   WHERE id = p_request_id;',
'         resubmitted_note = trim(p_agent_note), updated_at = now()
   WHERE id = p_request_id;

  -- A recall that has been superseded must stop reading as a live recall.
  -- `outcome = ''auto_recalled''` is what reports key on, and leaving it in
  -- place made a resubmitted, re-funded, happily repaying plan look recalled
  -- for ever. resolved_at is kept so the history of the recall survives.
  UPDATE public.landlord_float_idle_alerts
     SET outcome     = ''superseded_by_resubmission'',
         resolved_at = COALESCE(resolved_at, now()),
         updated_at  = now()
   WHERE rent_request_id = p_request_id
     AND COALESCE(outcome, '''') = ''auto_recalled'';');
  IF v_new = v_src THEN RAISE EXCEPTION 'resubmit UPDATE anchor not found'; END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.agent_resubmit_rent_request(
       p_request_id uuid, p_patch jsonb, p_agent_note text)
     RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public''
     AS %L', v_new);
END
$patch$;

-- 2. Backfill the 14 already in that state ----------------------------------
--
-- Scoped to plans that were resubmitted (`resubmission_count > 0`) and are no
-- longer cancelled. A recalled plan still sitting at `cancelled` keeps
-- `auto_recalled`, because for that one the label is still true.
UPDATE public.landlord_float_idle_alerts al
   SET outcome = 'superseded_by_resubmission', updated_at = now()
  FROM public.rent_requests rr
 WHERE rr.id = al.rent_request_id
   AND al.outcome = 'auto_recalled'
   AND rr.status <> 'cancelled'
   AND COALESCE(rr.resubmission_count, 0) > 0;

-- Verified after applying:
--
--   auto_recalled               7   all with plan status 'cancelled'
--   superseded_by_resubmission  14  6 agent_ops_approved, 3 pending, 5 repaying
--
-- and on a rolled-back transaction, resubmitting a recalled plan gives
--   plan=pending  alert_outcome=superseded_by_resubmission  resolved_at kept
