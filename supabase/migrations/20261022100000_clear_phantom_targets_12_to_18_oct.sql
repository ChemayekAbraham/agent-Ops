-- 122 more agents rated against a bill that never existed (2026-10-12 .. 10-18).
--
-- Same defect as 20261020161500, one window earlier. The corrected snapshot
-- (20261020160000) writes a row only for an agent who was actually billed that
-- day, and it upserts rather than deletes — so re-running it for 14-21 Oct
-- repaired every billed agent-day but could not touch rows the OLD function had
-- invented for agents with no pinned line at all.
--
-- Measured 2026-10-22, after that re-run:
--   12 Oct  28 rows  694,794 invented   13 Oct  24 rows  754,933
--   14 Oct  20 rows  430,262            15 Oct  17 rows  527,825
--   17 Oct  15 rows  305,062            18 Oct  18 rows  368,356
-- Every one of the 122 has paid = 0 and a Bad / Very Bad rating. They are not
-- poor performers: they had nothing due.
--
-- Why it matters beyond the record: these rows are read by the weekly Rent
-- Collections Report (as "Total Expected"), by the agent ratings panel, and by
-- the posting gate's "2 good days in the last 7" exemption. An invented target
-- inflates the denominator and suppresses the rating on all three.
--
-- Normalised to the shape the corrected function uses for a day with nothing
-- due, rather than deleted, so the day keeps a record. The `paid = 0` guard
-- means no collection can be erased by this; 16 Oct needs no entry here because
-- the re-run created its 109 rows from the pin for the first time.
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
 WHERE h.day BETWEEN date '2026-10-12' AND date '2026-10-18'
   AND h.expected_daily > 0
   AND NOT EXISTS (
     SELECT 1 FROM public.agent_expected_day_plans e
     WHERE e.agent_id = h.agent_id AND e.day = h.day AND e.expected_ugx > 0
   )
   AND COALESCE(h.paid, 0) = 0;
