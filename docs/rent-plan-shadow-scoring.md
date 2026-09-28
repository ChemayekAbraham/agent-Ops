# Rent Plan scoring — SHADOW MODE (v0)

Migration: `supabase/migrations/20260928100000_rent_plan_shadow_scoring.sql`

- Scores each Rent Plan request once (`rent_plan_shadow_scores`), from four inputs:
  the tenant's repayment history, the tenant's arrears band on other plans, the agent's
  track record (share of their billed plans 7+ days behind), and the rent amount.
- Logs the human decision beside the score once it exists (approve / reject / withdrawn).
- **No writes to `rent_requests` or any approval state. No auto-approval.** The only writer is
  `rent_plan_shadow_score_run()`, which inserts/updates its own log table.
- Switch: `system_config.rent_plan_shadow_scoring_enabled` (seeded `false`; missing row = OFF).
- Schedule: pg_cron `rent-plan-shadow-score-15min` (`*/15 * * * *`), pure SQL, a no-op while OFF.
- v0 weights are heuristics, not calibrated. The shadow period exists to measure them.

## Weekly agreement report

```sql
-- View (staff RLS applies): score band vs human decision, pending-at-score rows only
select * from public.rent_plan_shadow_agreement_weekly
 order by week_start_eat desc, band;

-- Same thing as a plain query, with an overall agreement line per week
with d as (
  select date_trunc('week', scored_at at time zone 'Africa/Kampala')::date as week_start_eat,
         band, human_decision
    from public.rent_plan_shadow_scores
   where pending_at_score and model_version = 'v0'
)
select week_start_eat,
       band,
       count(*)                                              as scored,
       count(*) filter (where human_decision = 'approve')    as human_approved,
       count(*) filter (where human_decision = 'reject')     as human_rejected,
       count(*) filter (where human_decision is null)        as undecided
  from d group by 1, 2
union all
select week_start_eat, 'ALL (A/B=approve, D=reject)',
       count(*) filter (where band in ('A','B','D') and human_decision in ('approve','reject')),
       count(*) filter (where (band in ('A','B') and human_decision = 'approve')
                           or (band = 'D' and human_decision = 'reject')),   -- agreements
       count(*) filter (where (band in ('A','B') and human_decision = 'reject')
                           or (band = 'D' and human_decision = 'approve')),  -- disagreements
       null
  from d group by 1
 order by 1 desc, 2;
```

For the `ALL` row the columns mean: decided A/B/D requests, agreements, disagreements.

## Turn on / off

```sql
update public.system_config set value = 'true'::jsonb,  updated_at = now() where key = 'rent_plan_shadow_scoring_enabled';
update public.system_config set value = 'false'::jsonb, updated_at = now() where key = 'rent_plan_shadow_scoring_enabled';
```
