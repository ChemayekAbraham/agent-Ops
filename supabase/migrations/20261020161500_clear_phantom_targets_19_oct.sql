-- 21 agents were rated against a bill that never existed.
--
-- The corrected snapshot writes a row only for an agent who was actually billed
-- that day, so re-running it for 2026-10-19 rewrote 109 of the 130 rows and left
-- 21 untouched. Those 21 are agents with no pinned line on the day: the old
-- function had invented an expected_daily for them out of pending and funded
-- plans — 451,816 between them — then rated every one "Very Bad" for collecting
-- nothing against it.
--
-- They are not poor performers on that day; they had no bill. Normalised to the
-- shape the corrected function uses for a day with nothing due, rather than
-- deleted, so the day still has a record. None of them collected anything, so
-- no payment is lost by zeroing these.
UPDATE public.agent_daily_eligibility_history h
   SET expected_daily = 0,
       ratio          = 0,
       capped_paid    = 0,
       active_count   = 0,
       tenants_due    = 0,
       tenants_paid   = 0,
       coverage_pct   = 0,
       status         = 'starter',
       rating         = public._classify_daily_rating(0, 0, 0),
       updated_at     = now()
 WHERE h.day = date '2026-10-19'
   AND NOT EXISTS (
     SELECT 1 FROM public.agent_expected_day_plans e
     WHERE e.agent_id = h.agent_id AND e.day = date '2026-10-19' AND e.expected_ugx > 0
   )
   AND COALESCE(h.paid, 0) = 0;
