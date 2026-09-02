# Board Memo — preview generation prompt

The prompt used to build the 2026-08-29 preview. Reusable: change the closing
date and re-run. It generates the board memo from live production data without
sending anything, and gates the output on three accuracy checks that have each
already produced a wrong board figure.

Paste everything below the line.

---

# Generate the Welile Board Technology Memo preview

Produce a preview of the weekly Board Technology Memo from live production data. **Do not send email, do not commit, do not push, do not apply migrations.** Output is a rendered preview only.

The memo is normally produced by the `daily-cto-report` edge function with `reportType: 'board'`. You are reproducing what it *would* send, and checking the figures before it does.

## 0. Parameters

- `CLOSING_DATE` — the last day of the reporting week, in Africa/Kampala. Default: today in EAT.
- `WEEK_START` = `CLOSING_DATE - 6 days`.
- All timestamps are `+03` (EAT). Day boundaries are `YYYY-MM-DD 00:00:00+03` inclusive to the next day exclusive — never use UTC midnight, it shifts every figure by three hours.

Resolve them first:

```sql
SELECT (now() AT TIME ZONE 'Africa/Kampala')::date AS closing_date,
       ((now() AT TIME ZONE 'Africa/Kampala')::date - 6) AS week_start;
```

## 1. Primary payload

One call gives sections 4 and 5 in full — the roles, SMS, OTP, sign-in and e-mail blocks are already windowed (7-day or 30-day) inside the function:

```sql
WITH r AS (SELECT public.get_cto_daily_report('<CLOSING_DATE>'::date) AS j)
SELECT jsonb_pretty(jsonb_build_object(
  'platform', j->'platform',
  'roles',    j->'roles',
  'sms',      j->'sms',
  'otp',      j->'otp',
  'signin',   j->'signin',
  'email',    j->'email',
  'security', j->'security',
  'jobs',     jsonb_build_object('total_scheduled', j->'jobs'->'total_scheduled',
                                 'runs_24h', j->'jobs'->'runs_24h',
                                 'failed_24h', j->'jobs'->'failed_24h',
                                 'failing', j->'jobs'->'failing'),
  'backups',  j->'backups',
  'errors',   jsonb_build_object('today', j->'errors'->'today',
                                 'last_7d', j->'errors'->'last_7d',
                                 'affected_users_today', j->'errors'->'affected_users_today',
                                 'top_routes', j->'errors'->'top_routes',
                                 'top_messages', j->'errors'->'top_messages'),
  'infra',    jsonb_build_object('rollbacks', j->'infra'->'rollbacks',
                                 'commits', j->'infra'->'commits',
                                 'cache_hit_pct', j->'infra'->'cache_hit_pct',
                                 'connections', j->'infra'->'connections',
                                 'max_connections', j->'infra'->'max_connections')
)) AS out FROM r;
```

Note: calling this for today writes a row to `db_stat_snapshots`. That is the function's normal behaviour, not a side effect to avoid — but see accuracy gate A.

## 2. Daily inputs for the health trend

The memo's health score is per-day and then averaged. Do **not** call the RPC seven times; it is expensive. Pull the raw inputs directly:

```sql
WITH days AS (SELECT generate_series('<WEEK_START>'::date,'<CLOSING_DATE>'::date,'1 day')::date AS d),
b AS (SELECT d, (d::text||' 00:00:00+03')::timestamptz AS s,
                ((d+1)::text||' 00:00:00+03')::timestamptz AS e FROM days)
SELECT jsonb_pretty(jsonb_agg(jsonb_build_object(
  'd', d,
  'err_users',      (SELECT count(DISTINCT user_id) FROM public.client_error_reports WHERE created_at >= s AND created_at < e),
  'errors',         (SELECT count(*) FROM public.client_error_reports WHERE created_at >= s AND created_at < e),
  'login_attempts', (SELECT count(*) FROM public.login_phase_events WHERE phase='auth.signin.attempt' AND created_at >= s AND created_at < e),
  'login_fail',     (SELECT count(*) FROM public.login_phase_events WHERE phase='auth.signin.attempt' AND status<>'success' AND created_at >= s AND created_at < e),
  'job_runs',       (SELECT count(*) FROM cron.job_run_details WHERE start_time >= s AND start_time < e),
  'job_fail',       (SELECT count(*) FROM cron.job_run_details WHERE status<>'succeeded' AND start_time >= s AND start_time < e),
  'active_users',   (SELECT count(*) FROM public.profiles WHERE last_active_at >= s AND last_active_at < e)
) ORDER BY d)) AS out FROM b;
```

`d+1` only works if `d` is cast to `date` in the CTE. `generate_series(...)` returns timestamptz by default and `timestamptz + integer` is not a valid operator.

## 3. Health arithmetic

Reproduce the weighting in `daily-cto-report/index.ts` exactly. Per day:

```
dErr   = err_users / max(1, max(active_users, err_users)) * 100
dLogin = login_fail / max(1, login_attempts) * 100
dJob   = job_fail  / max(1, job_runs) * 100
dConn  = connections / max_connections * 100
dRls   = rls_tables / public_tables * 100
dCache = cache_hit_pct

health = round((
    max(0, 100 - dErr   * 12) * 25
  + max(0, 100 - dLogin * 1.6) * 15
  + max(0, 100 - dJob   * 4)  * 15
  + min(100, dCache * 0.7 + max(0, 100 - dConn) * 0.3) * 20
  + dRls * 15
  + (backupOk ? 100 : 45) * 10
) / 100)
```

`backupOk` = at least one successful backup in the last 7 days, against a weekly cadence.

Label: ≥85 Healthy, ≥70 Watch, else At risk. Report the **closing-day** score in the header with the seven-day mean beside it — never the mean alone.

Weekly aggregates:

```
wErrRate      = sum(err_users) / platform.active_7d * 100
wAuthSuccess  = 100 - sum(login_fail) / sum(login_attempts) * 100
wJobFailRate  = sum(job_fail) / sum(job_runs) * 100
wFailedRuns   = sum(job_fail)
```

Pillar scores, for the RAG on the scorecard:

```
reliability = clamp(100 - wRollbackRate*6 - wErrRate*10, 0, 100)
controls    = max(0, 100 - guardrailJobsFailing*22 - otherJobsFailing*6)
security    = rlsCoverage
customer    = min(100, eventualSignInRate*0.6 + emailDeliveryRate30d*0.4)
continuity  = backupOk ? 100 : 45
```

RAG: ≥85 Green, ≥65 Amber, else Red. A job counts as a financial guardrail if its name matches `/advance|recover|guardrail|bonus|trust|wallet|ledger|payout|commission|deposit|solvency|drift/i`.

## 4. Accuracy gates — run all three every time

Each of these has already put a wrong number in front of the board. Check them before rendering, and caveat in the output if any trips.

### Gate A — is the rollback rate a real daily delta?

```sql
SELECT day, xact_commit, xact_rollback, captured_at,
       (now()::date - day) AS days_ago
FROM public.db_stat_snapshots ORDER BY day DESC LIMIT 5;
```

The rate is `rollbacks / (commits + rollbacks)` where both are the difference between the closing-day snapshot and the most recent earlier one. **If the previous snapshot is not from the day before, the figure is not a daily rate** — it silently spans however many days separate the two snapshots.

On 2026-08-29 the only prior snapshot was 2026-08-15, so the "daily" rate was a fourteen-day figure of 16.52%, which trips the 5% threshold and generates a false "elevated rollback rate" board item.

If it trips: suppress the figure, mark it "not trustworthy", and report that the daily report has not been running.

### Gate B — is SMS handset confirmation being recorded?

```sql
SELECT count(*) FILTER (WHERE status='delivered') AS ever_delivered,
       count(*) FILTER (WHERE provider_message_id IS NOT NULL
                        AND created_at >= now() - interval '30 days') AS with_message_id
FROM public.sms_delivery_log;
```

If `ever_delivered = 0` while `with_message_id` is large, the Yoola delivery sweep is running but never promoting rows. **Render "Not being recorded", never "0.0%"** — a zero here reads to a board as total delivery failure when the truth is that the instrument is dead.

### Gate C — which version of the reporting function is live?

```sql
SELECT (prosrc LIKE '%signin_sessions_tried_7d%') AS signin_fix_applied,
       (prosrc LIKE '%sms_delivery_log%')          AS sms_block_present
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public' AND p.proname='get_cto_daily_report';
```

If `signin_fix_applied` is false, the deployed function still keys eventual sign-in success on `user_id`, which is present on only ~10% of attempts and inflates the figure badly. Compute the correct value yourself and say the deployed function disagrees:

```sql
WITH att AS (
  SELECT session_trace_id, status FROM public.login_phase_events
  WHERE phase='auth.signin.attempt'
    AND created_at >= '<WEEK_START> 00:00:00+03'::timestamptz
    AND created_at <  '<CLOSING_DATE+1> 00:00:00+03'::timestamptz
)
SELECT count(DISTINCT session_trace_id) AS sessions_tried,
       count(DISTINCT session_trace_id) FILTER (WHERE status='success') AS sessions_succeeded
FROM att;
```

### Gate D — is the named failing automation actually failing?

Never name a job in the "Financial Controls Automation" pillar, the headline, or a board decision unless it appears in this closing day's `jobs.failing` array (Section 1's payload) or in the raw run history:

```sql
SELECT j.jobname, count(*) AS n, max(left(coalesce(d.return_message,''),140)) AS last_error
FROM cron.job_run_details d JOIN cron.job j USING (jobid)
WHERE d.start_time >= '<CLOSING_DATE> 23:59:59+03'::timestamptz - interval '24 hours'
  AND d.start_time <  '<CLOSING_DATE> 23:59:59+03'::timestamptz
  AND d.status <> 'succeeded'
GROUP BY 1 ORDER BY n DESC;
```

On 2026-09-01 this returned only `snapshot-receivables-forecast` (a `receivables_guard()` permissions error, 0 of 7 daily runs succeeded all week). A draft of that day's memo instead named four unrelated jobs (`email-auto-create-deposits-24h`, `refresh-wallet-totals-cache`, `repair-wallet-cache-drift-15m`, `wallet-projection-drift`) that had zero failures for the entire reporting period — plausible-sounding financial-guardrail names that were never checked against this query before being written into the board decision item.

Two failure modes to check for, every time:

1. **A job is named that isn't in the query result at all.** Delete it from the narrative; it did not fail.
2. **A job that IS in the query result doesn't get named**, because `daily-cto-report`'s `GUARDRAIL_RE` keyword filter (`/advance|recover|guardrail|bonus|trust|wallet|ledger|payout|commission|deposit|solvency|drift|receivable/i`) doesn't match its name. Treat the query result as authoritative over the keyword filter — a financial-control automation can have a name the regex doesn't anticipate (e.g. `receivables`, fixed 2026-09-02).

If it trips: name only the job(s) the query actually returns, with their real failure count for the period, and drop any job the query does not return from the "Financial Controls Automation" pillar, the headline sentence, and the board decision list.

## 5. Report structure

Seven sections, in this order:

1. **Headline and decisions** — five or six sentences, plain English, no metric names.
2. **Business risk scorecard** — the five pillars with RAG and a one-line business consequence each.
3. **For board decision or awareness** — only items genuinely needing a decision.
4. **Who the platform serves** — segment, figure, basis. Agents as a funnel; landlords on a separate line as counterparties, never inside a user count.
5. **Reach, messaging and admission** — SMS, OTP, e-mail, sign-in split.
6. **Platform health, controls and continuity** — daily health trend, then indicators versus target.
7. **Where the errors are** — top screens by error count with the dominant fault named.

Then, outside the memo body, an **accuracy notes** panel for anything that tripped section 4.

Every figure shows a number **and** a percentage, and every percentage names its denominator in the row label.

## 6. Writing rules

- Board language, not engineering language: "customers could not sign in", not "auth phase error rate".
- Every red item states the business consequence, not the technical cause.
- Never report a percentage over something that is not being measured — say so instead.
- Distinguish a measurement fault from a real failure, every time, in the row itself.
- Name the owner-actionable thing: "one screen is 45% of the week's errors" beats "the error rate is 7%".

## 7. Regression check

Running this for `CLOSING_DATE = 2026-08-29` should reproduce approximately:

| Figure | Expected |
|---|---:|
| Health closing / 7-day mean | 84 / 73 |
| Active customers, 7 days | 1,120 |
| Agents with real activity | 310 (285 / 77 / 59, all three 43) |
| Tenants on a funded rent plan | 941 |
| Funders holding a portfolio | 776 |
| Landlord counterparties | 16,108 of 45,963 |
| Sign-in attempts / success | 1,748 / 75.1% |
| Platform-attributable sign-in failure | 0.06% |
| Sign-in sessions eventually succeeding | 694 of 828 (83.8%) |
| SMS accepted / failed / unresolved | 56.3% / 19.3% / 24.4% |
| SMS confirmed | not being recorded |
| OTP send acceptance / verify success | 55.3% / 39.5% |
| E-mail delivered / queued | 47.9% / 47.9% |
| Errors, 7 days | 451, top screen /dashboard/agent at 202 |
| Jobs scheduled / failing | 137 / 1 (`snapshot-receivables-forecast`) |

If a figure is wildly different, suspect the query before suspecting the data — particularly the EAT day boundaries and the `date` cast in the trend CTE.
