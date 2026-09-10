-- Schedule the arrears sweeper to run just after the nightly pin.
--
-- WHY THIS EXISTS
-- A settlement can only point at a day that has actually been billed (the
-- composite FK to `agent_expected_day_plans`). So when a tenant overpays, the
-- surplus cannot attach to tomorrow — tomorrow is not pinned yet. It waits as
-- unapplied money on the collection.
--
-- `rent_sweep_unapplied_collections()` is what picks that money up once the day
-- exists. Without it, held-ahead money only lands on the plan's NEXT collection,
-- so a tenant who paid ahead would still show the new day as unpaid.
--
-- Measured on a real plan before scheduling this:
--   overpay 50,000 on a plan with 2 pinned days -> 9,534 settled, 40,466 held
--   pin the next day, run the sweeper           -> 4,767 lands, 35,699 held
--   run the sweeper again                       -> 0 plans, 0 applied (idempotent)
--
-- WHY A SEPARATE JOB RATHER THAN APPENDING TO THE PIN
-- pg_cron sends a multi-statement command over the simple query protocol, which
-- Postgres executes as ONE implicit transaction. If the sweeper raised, it would
-- roll back the pin with it — and a day with no pinned bill does not self-heal,
-- because `pin_agent_expected_day` only runs once a day. Every agent's target
-- for that day would read 0.
--
-- The pin is critical and unrepeatable; the sweeper is idempotent and
-- self-healing (a missed run costs nothing, the plan's next collection applies
-- the money anyway). So they are isolated, five minutes apart. This is the same
-- reasoning that makes the allocator call non-fatal inside
-- `agent_allocate_tenant_payment`: attribution must never be able to break the
-- money-critical path.
--
-- TIMING
--   00:05 EAT (21:05 UTC) — job 18933 `pin-agent-expected-day-eat-midnight`
--   00:10 EAT (21:10 UTC) — this job
--
-- SAFETY NOTE FOR WHOEVER READS THIS NEXT
-- The sweeper is GLOBAL across all Rent Plans, and its blast radius is set by
-- `rent_arrears_go_live()`. With the real floor it starts at zero and grows one
-- day at a time. With the floor moved backwards by a single day, a measured dry
-- run attributed 2,986,077 across 120 plans in one pass. Do not move the floor
-- backwards while this job is scheduled unless that mass attribution is intended.
--
-- `cron.schedule` upserts by job name, so re-applying this migration is safe.

SELECT cron.schedule(
  'sweep-unapplied-rent-collections-eat-midnight',
  '10 21 * * *',
  $cmd$SELECT public.rent_sweep_unapplied_collections();$cmd$
);
