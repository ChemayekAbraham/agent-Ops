# Findings: Shakirah Nakimbugwe sees 3 of 4 submitted requests

Investigation only. Nothing was changed. The proposed next steps are at the end.

## Key finding: the label in her recording doesn't match the current data

- In the current code, `STAGE_LABEL` maps **"Agent Ops review" only to `pending`**. `agent_ops_approved` maps to "Tenant Ops review" (`src/components/agent/AgentRequestPipelineView.tsx:94-105`).
- In the live database, all four requests are `agent_ops_approved` now. They changed today (1 Oct) between 06:31:45 and 06:33:09 UTC:
  - Shadrack: 06:31:45
  - Zainabu: 06:31:57
  - Daniella: 06:32:38
  - Criber: 06:33:09, the last one
- So cards labelled "Agent Ops review" mean either:
  - the rows were `pending` when the screen loaded, so the recording or her cached data is from before about 06:31 UTC today; or
  - her phone was running a different build with different labels.
- Today's data can't explain why Criber was missing at that earlier time. The other three show a status still inside `SUBMITTED_STATUSES`, which means Criber's status back then was probably outside the list (lines 81-90). I could not confirm this. There is no status history:
  - `system_events` has no rows for these four ids.
  - `audit_logs` has only one inline edit on Shadrack (06:31:30, duration/fees).

## Q1: Production bundle and caches

- **Current code:** `usePipelineRequests` (lines 182-262) is a plain `useQuery`. It filters by `agent_id`, `.in('status', …)`, orders newest first and uses `range(0,9)`, which is 10 per page. Her 9 total rows fit easily on one page.
- **No persisted React Query cache:** the repo has no `persistQueryClient` or storage persister.
- **No service worker for app pages:** `src/main.tsx:104` unregisters service workers. `/sw.js` is registered only for push notifications (`src/lib/webPush.ts:217`, `PushNotificationButton.tsx:72`). I did not confirm whether that push worker caches pages.
- **Snapshot / offline layer:** not traced in this pass. `useUserSnapshot` / OfflineContext may serve cached dashboard data on a slow connection, which would match her yellow "Slow connection" banner. Whether it feeds this list is unconfirmed.
- **Could not determine:** whether the deployed bundle matches the repo file exactly. Today's publish started and finished, but I can't read the live JS from here, and I can't tell which build her phone had loaded.

## Q2: Other code paths that could hide Criber

- In the Submitted tab, rows pass only search, status and date filters on the client (lines 521-561). Defaults are `'all'` and an empty search.
- An active date filter "This week" or "Today" would hide Criber, because he was created on 19 Sep. The other three were created 21-27 Sep, and `isThisWeek` is local-week based. This fits the symptom if she had a date filter on. Can't confirm from the recording description.
- There is no dedupe, slice, landlord grouping or dismiss list on submitted rows. `landlord_id` is used only for name lookup (lines 225, 254-255).
- Other files that use the pipeline: `AgentTenantsSheet.tsx`, `AgentDashboard.tsx`, `useAgentPipelineCounts.ts`. I have not checked them for separate rendering.

## Q3: Logs

Not yet queried: API and edge logs for `rent_requests` / `profiles` requests by this user.

## Proposed next steps (read-only)

1. Query the API logs for her requests to `rent_requests` and `profiles` around the recording time. Look for 4xx/5xx errors, the status filter in each request URL, and the response row count.
2. Ask for the recording's timestamp and whether a filter badge was visible. Before about 06:31 UTC today, her cards would have shown `pending`.
3. Trace `useUserSnapshot` / OfflineContext and `AgentTenantsSheet.tsx` for any second rendering or caching path.
4. Check the latest production build ID against the repo commit.
5. Ask her to clear the date and search filters, pull to refresh on a good connection, and confirm she now sees four "Tenant Ops review" cards.
