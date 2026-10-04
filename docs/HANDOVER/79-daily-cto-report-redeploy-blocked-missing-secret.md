# 79. `daily-cto-report` redeploy wired up, but blocked — `SUPABASE_ACCESS_TOKEN` repo secret does not exist

**Josh asked to rebuild the `daily-cto-report` edge function pipeline and deploy it via the manual
GitHub Actions workflow. The rebuild (RPC fix + drift baselines) was already committed earlier the
same day (`61b2d367e4`, doc 66) but had no way to actually reach production: the deploy workflow's
choice list didn't include this function, and once added, the trigger failed immediately —
`weliletenants-sys/welilereceipts-com-98bba33b` has no `SUPABASE_ACCESS_TOKEN` repository secret at
all. This is a pre-existing gap, not something this change caused — the same workflow failed the
same way deploying `sms-otp` on 2026-09-17.**

## What was done

1. Verified the rebuild from doc 66 is fully committed: `daily-cto-report/index.ts` already reads
   `median_login_ms_today`/`p95_login_ms_today`/`login_attempts_over_60s_today` at all four call
   sites, and migration `20260918040000_rebuild_daily_cto_report_with_drift_protection.sql` (the
   RPC fix + `critical_function_baselines` rows for all four CTO RPCs) is present in the repo.
2. Confirmed live production still does **not** have the fix: `get_cto_daily_report`'s body has no
   `median_login_ms_today` column, and `critical_function_baselines` "matches live" for all four
   functions only because the baseline was captured against the *unfixed* body (documented risk in
   doc 66 §5). Attempted to apply the migration directly — blocked by the auto-mode classifier
   ("Modify Shared Resources"), same as every other direct-to-prod DDL attempt in this folder.
   **Still needs manual apply.**
3. `.github/workflows/deploy-edge-function.yml` had no `daily-cto-report` option — the workflow
   physically could not deploy this function. Added it to the `choice` list, added it to the
   `EXPECT_PUBLIC=yes` group (it's invoked by pg_cron via `net.http_post` with only an `apikey`
   header, same shape as `agent-ops-daily-report`/`redispatch-withdrawals`, not a user JWT), and
   added the matching `[functions.daily-cto-report]\nverify_jwt = false` entry to
   `supabase/config.toml` — without that, a deploy through this workflow would have defaulted to
   `verify_jwt = true` and started 401ing the `daily-cto-report-tech`/`weekly-cto-report-board` cron
   calls, breaking a pipeline that currently works. Committed as `1b9a165d12`, pushed to `origin/lovable`.
4. Triggered the workflow (`gh workflow run` with `function=daily-cto-report`, `confirm=DEPLOY`).
   **Failed in 17 seconds**, before ever calling `supabase functions deploy`:
   `##[error]SUPABASE_ACCESS_TOKEN secret is not configured`. Confirmed via
   `gh secret list --repo weliletenants-sys/welilereceipts-com-98bba33b` and the equivalent API call
   that the repo has **zero** Actions secrets configured — not a scoping/permissions issue, the
   secret was never created. The prior run of this same workflow (2026-09-17, `sms-otp`) failed
   identically in 16 seconds — this has never successfully deployed anything.

## What's still needed (needs Josh, not fixable from here)

- Create a Supabase **personal access token** (Supabase dashboard → account → access tokens) scoped
  to deploy Edge Functions on project `wirntoujqoyjobfhyelc`, and add it as a repository secret named
  `SUPABASE_ACCESS_TOKEN` on `weliletenants-sys/welilereceipts-com-98bba33b`
  (Settings → Secrets and variables → Actions). This blocks *every* function in the workflow's
  choice list, not just this one — worth fixing once for all ten.
- Once the secret exists, re-run: `gh workflow run "Deploy Edge Function (manual, one at a time)"
  --repo weliletenants-sys/welilereceipts-com-98bba33b -f function=daily-cto-report -f confirm=DEPLOY`.
- Apply migration `20260918040000_rebuild_daily_cto_report_with_drift_protection.sql` to production
  by hand (or grant the permission) — separately from the edge function deploy. Both need to land:
  the RPC fix is what actually puts real numbers behind `median_login_ms_today`, and the edge
  function deploy is what makes `daily-cto-report/index.ts` display them. Deploying only the edge
  function against the still-unfixed RPC will just show `median: null` alongside a normal `avg`.

## Verify once both land

```sql
select (get_cto_daily_report()->'auth'->>'median_login_ms_today')::numeric,
       (get_cto_daily_report()->'auth'->>'avg_login_ms_today')::numeric;
-- expect both non-null

select b.function_signature,
       b.expected_sha256 = encode(sha256(convert_to(pg_get_functiondef(b.function_signature::regprocedure), 'UTF8')), 'hex') as baseline_matches_live
from critical_function_baselines b where b.function_signature = 'get_cto_daily_report(date)';
-- expect true, and this time it should actually mean the fixed body, not the pre-fix one
```

```bash
gh run list --repo weliletenants-sys/welilereceipts-com-98bba33b \
  --workflow="Deploy Edge Function (manual, one at a time)" --limit 1
# expect status=completed, conclusion=success, not failure at "Deploy single function"
```

## What not to do

- Don't try to work around the missing secret by embedding a token in the workflow file or by
  reading one out of `.env` — `.env` is explicitly hands-off, and a token belongs in GitHub Actions
  secrets, never committed.
- Don't assume the workflow's header comment ("PREPARED, NEVER RUN") is still accurate — it has now
  been triggered twice (2026-09-17 for `sms-otp`, 2026-09-18 for `daily-cto-report`), both failing
  at the same first step. It has still never actually reached `supabase functions deploy`.
