-- Partner Returns per person, Phase 7 release: mark the release complete (release_ready = true).
-- The switch stays OFF. Only the CEO can turn it on (set_partner_return_policy); this file never does.
--
-- Owner decision 2026-11-08 ("proceed with all but don't turn the switch on"; release_ready "Set it now"):
-- release_ready is set although the partner agreements (Phase 3, parked) still state 15%. Release scan
-- §8.5 #2 stays red for that reason only, by the owner's choice.
--
-- APPLIED to production 2026-11-08 18:51 UTC (after 4b and the published screens). It refuses to run unless
--   * the switch is off,
--   * every assert_partner_return_policy_intact() row is ok (rates_conform and release_ready aside), and
--   * every Phase 4 release check is ok (_partner_return_phase4_checks(true): the 4b masks, the note
--     security migration, ...), so the drift alert cannot start failing the moment release_ready is stored.
-- Setting release_ready is audited and alerted by partner_return_policy_guard.
-- Rollback: supabase/rollbacks/20261108170000_partner_return_policy_release.rollback.sql
SET LOCAL lock_timeout = '1s';

DO $release$
DECLARE
  v_pol    public.partner_return_policy%ROWTYPE;
  v_broken text;
BEGIN
  SELECT * INTO v_pol FROM public.partner_return_policy WHERE id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Release refused: the Partner Returns policy row is missing' USING ERRCODE = '55000';
  END IF;
  IF v_pol.enabled THEN
    RAISE EXCEPTION 'Release refused: the switch is on; this file only marks the release with the switch off'
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(c.check_name, ', ' ORDER BY c.check_name) INTO v_broken
    FROM public.assert_partner_return_policy_intact() c
   WHERE NOT c.ok AND c.check_name NOT IN ('rates_conform', 'release_ready');
  IF v_broken IS NOT NULL THEN
    RAISE EXCEPTION 'Release refused: these checks fail: %', v_broken USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(c.check_name, ', ' ORDER BY c.check_name) INTO v_broken
    FROM public._partner_return_phase4_checks(true) c
   WHERE NOT c.ok;
  IF v_broken IS NOT NULL THEN
    RAISE EXCEPTION 'Release refused: these release checks fail: %', v_broken USING ERRCODE = '55000';
  END IF;

  IF NOT v_pol.release_ready THEN
    UPDATE public.partner_return_policy
       SET release_ready = true,
           note = 'Phase 7 release 2026-11-08 (owner-approved; switch off; agreements still state 15%, owner decision)'
     WHERE id;
  END IF;
END $release$;
