# Welile Assistant upgrade
- [x] Update exact heading and three starter pills with shared role-tailored guides; 173 Assistant tests and 6 report export tests pass, all guards pass, preview build OK. Verified all three live public replies, sign-in target and header cycling at 1280/390/320px. Full Vitest reported 63 failures (one updated inquiry test now passes), with existing unrelated failures remaining. Fixed four existing report compatibility errors blocking preview checks; no migrations or deployments.
- [x] Simplify assistant empty state to one rotating pill, hidden header description and centered short composer; 151 assistant tests and all guards pass, preview build OK. Verified /ai at desktop, 390px and 320px, starter cycling and live financial-guide submission. Full Vitest: 2865 passed, 62 unrelated failures across 20 files with 16 errors; no unrelated code changed. Welcome/auth launcher did not open in browser checks; direct /ai verified.
- [x] Add shared public financial-access guide, starter, safe local fallback and backend out-of-scope guidance: 151 tests, all guards, Deno checks and preview compilation pass; deployed public endpoint returns guide and signup, desktop/mobile starter and sign-in links verified. Unsupported bonus/zero-fee guarantees omitted; terminal service errors and refusals remain visible. No migrations or financial changes.
- [x] Unify global launcher and public header entry points without duplicate dashboard assistants.
- [x] Refresh both chat surfaces with AI Elements, public/signup calculators and six personal starters.
- [x] Route authorized personal questions securely and public questions through existing Nexa guidance, with isolated public history and account-transition resets.
- [x] Run 115 focused tests, all guards and desktop/mobile interaction checks; public wallet/account guidance and live company answer verified, preview build OK.
- [ ] Verify live signed-in personal answers — blocked: external unmanaged Supabase does not provide a restorable authenticated browser session; isolated routing/privacy tests pass.

# Tasks
- [x] Update agent own-ID summaries and Agent Ops previous/new comparison using existing hooks only; 34 tests and all guards pass, preview build OK; sample 360/375px and desktop summaries, comparison and enlargement verified without overflow. Live signed-in checks unavailable with external unmanaged authentication; protected files unchanged. Corrected one existing CFO undefined callback blocking compilation.
- [ ] Implement and verify bike-first daily recovery waterfall across automatic advance paths, with separate contracts/accounts and truthful operations recovery-order display.
- [x] Redesign agent verification as a seven-step KYC flow; 37 focused tests, all safety guards and automatic compilation pass. Isolated 360/375px and desktop layouts show no horizontal overflow; parent selection, missing-step navigation and verified-edit warning checked. Existing hooks, backend, enforcement and other verification screens unchanged; no deployment.
- [ ] Verify the KYC flow with a live signed-in agent and real phone/email/camera/submission — blocked: externally managed authentication provides no restorable browser session; isolated checks do not establish live verification success.
- [x] Diagnosed Mukama Michael mismatch (registered 0749889347 vs approved 0793805335; left unchanged). Applied persistent rejected-number server guards and read-only agent correction fields with stripped number payloads; eight tests and all guards pass.
- [ ] Verify rejected-number editing end to end with authorized agent and Landlord Ops sessions — blocked: external Supabase has no restorable signed-in session; no real phone corrections or payouts attempted.
- [x] Match Cash Position to the supplied compact board screenshot; existing figures, sources, filters and drill-downs preserved. 15 CFO tests and all guards pass, preview build OK; isolated desktop/phone layout and account-detail opening verified. Live signed-in verification unavailable with externally managed authentication. Existing additional reports remain below the compact board.
- [x] Add consent-based Nexa inquiry signup prompts and signup bar using existing signup: 89 tests, all guards, Deno checks and preview compilation pass; desktop/phone prefill and public inquiry invitation verified. No predictable passwords, account-existence lookup, role writes or account creation from chat; unsupported bonuses excluded. Live WhatsApp delivery and completed live signup remain unverified; no accounts or SMS created during checks.
- [x] Add Nexa auth-gated actions, deterministic private account guidance, wallet teaching, promissory reminders and canonical company facts. 75 guidance tests and all guards pass; public account guidance and sign-in return destination verified, preview build OK. No database or financial changes; live WhatsApp delivery remains blocked by existing credentials/activation.
- [x] Extend Nexa with shared public catalog and pre-response confidentiality checks, Uganda completeness ranks, campaign exports/SMS action, server-read tenant progress, four sales tabs and explicit Meta templates; 71 focused tests and all guards pass, preview build OK. Public projection and confidential-query refusal verified on desktop/phone. SQL stays an unapplied secure proposal; live desk, learning, authenticated tenant progress and WhatsApp delivery remain unverified pending migration approval, credentials and authorized session.
- [x] RentFlow Insights frontend and server code: completeness-first authorized loaded feeds, access-limit campaign, four-tab Nexa projections, private desk controls and Meta sender/signed webhook. Focused tests and guards pass; public desktop/mobile estimates and offline escalation verified.
- [ ] RentFlow Insights activation and signed-in verification — blocked: SQL proposal stays unapplied in docs/pending-migrations (migration files require approved tooling); Meta credentials/template missing; Benjamin desk authority not confirmed. No production data modified. Full-market pagination ordering and persistent webhook delivery/retry circuit breakers need separately activated server support; end-to-end delivery/learning remains unverified.
- [x] Removed the product tabs and product detail section from CFO Payables → Partner Products and Services, leaving only the Paid & Outstanding report; other categories keep their tabs and drill-down. 16 tests, typecheck and preview build pass; live signed-in check unavailable with external authentication.

- [x] Match Partner Products and Services payout presentation to the supplied screenshot; preserved figures, labels, reconciliation and record actions. Seven tests and location guard pass, preview build OK; isolated desktop/mobile layout and record drill-down verified. Live signed-in verification unavailable with external authentication.
- [x] Add six-step Welile Schools Bot registration, shared Classic Form, editable review and locked-gate greeting; location guard and 11 school tests pass, preview build OK; isolated phone/desktop chat editing and form draft checks pass without horizontal overflow.
- [ ] Verify school registration save with a live signed-in agent — blocked: externally managed authentication cannot be restored by browser tools; existing save handler unchanged and draft submission verified in isolated tests.
- [x] Prepare standing-order production approval package — proposal fingerprinted unchanged; 27 SQL assertions, 20 control/integration/schedule tests and 9 concurrency/MFA groups pass; all guards pass. Documented staged approvals, hosted MFA blocker and non-destructive rollback in docs/standing-order-amount-production-approval.md. Documentation only; no activation.
- [x] Final standing-order isolated safety review — 27 SQL assertions, 18 controls/integration/schedule tests and 9 review groups (45 MFA/authorization cases plus concurrent payer/editor checks) pass; all guards pass; evidence and production requirements in development report. No production changes.
- [ ] Standing-order hosted Auth/MFA verification — blocked: no isolated hosted test stack with real signed sessions/MFA available; live MFA is shadow mode. Production activation requires separate approval and MFA decision.
- [x] Standing order amount edits developed locally: 27 PostgreSQL assertions, 5 control tests, 2 local UI/database readback tests and 11 schedule regressions pass; guards and preview compilation pass; payment pathways unchanged. Report: docs/standing-order-amount-development-report.md.
- [ ] Standing order amount edit production activation — blocked pending explicit user approval and isolated hosted authorization/MFA evidence; SQL unapplied, production-connected controls review-only and saving disabled.
- [x] CFO Home / Cash Position / Payables: independent loading, shared authoritative totals, scoped retries and preserved reconciliation/detail links; 30 tests and all guards pass, preview build OK. No database changes or deployment. Authenticated production timing verification unavailable with externally managed authentication.
- [ ] Re-sync to `51069f32ea` (teeburg merge: data-fix migration `20261023090000_nsubuga_smartphone_term_3_months.sql`, already applied to the live database by hand) — blocked: `git merge` is refused by the sandbox and the workspace HEAD `3875cf97f4` is 2 commits behind `origin/lovable`; the migration must not be run. Read-only check confirms the live plan is already 3 months.
- [x] Welile Homes build break fixed — `AgentWelileHomesSheet.tsx` now reads `rent_requests`/`landlords`/`agent_landlord_float_allocations` (the landlord deletion guard actually fires again) and both float desks select `rejection_reason`; build OK, all guards pass, new `welileHomesDataSources.test.ts` (5 tests) pins the data sources.
- [ ] Remaining queries against tables that do not exist (all `as any`-masked, so the typecheck cannot see them): `financial_anomalies` and `batch_processing_runs` (Financial Ops ScaleDashboard), `ln` (AgentVouchHistoryFeed collection detail), `rent_request_tenant_readiness` (useTenantPaymentReadiness), `repayment_schedules` (src/lib/scheduleUtils.ts insert, called from RentRequestForm) — blocked: each needs a decision on whether the table should be created (approved migration) or the call repointed to an existing relation; no database changes made.

- [ ] Financial Ops UI consistency: audit every reachable tool, inbox/fullscreen and portal dialogs; apply overview-matched scoped styling only; verify desktop/mobile/light/dark and existing regression tests. No financial, database or deployment changes.
- [ ] Enable Tenant, Employee and Supporter test calls for 0701355245 — blocked: migration service returned 42P10; live readback confirms both demo functions absent and Employee/Supporter scripts missing. Overview controls remain disabled until the server configuration succeeds; no calls placed.
- [x] Retry the split-withdrawal UUID correction as requested and check the live definition: retry returned 42P10, old text ID remains, UUID correction unapplied; no withdrawals submitted.
- [x] Correct proxy split-withdrawal request ID type mismatch — fixed upstream in commit 83850e4ea0 (migration 20261022090000, applied directly to the live database). Verified read-only: `submit_proxy_split_withdrawal` no longer contains `md5(gen_random_uuid` and writes `gen_random_uuid()`; `withdrawal_requests.client_request_id` is `uuid`. No migration re-run, no payouts submitted.
- [x] Add agent search by name, phone or district to the Agent Directory: the By Region search box now asks the register for matching agents with clickable profile rows, and the List search placeholder names district; 18 directory tests, typecheck and guards pass. Live signed-in verification unavailable with external authentication.
- [x] Make every Agent Directory name visibly clickable in List and By Region; 13 tests, safety guards and sample phone/desktop profile-opening checks pass. Existing profiles/actions unchanged; live signed-in verification unavailable with external authentication.
- [x] Optimize Agent Directory for smartphones: large touch controls, readable contact/activity details and fitting area filters; ten directory tests and isolated 320/390/430px plus desktop navigation checks pass, preview build OK. Live signed-in verification remains unavailable with external authentication; data and actions unchanged.
- [x] Build Automated Calls Overview, Campaigns, Scripts, Call Log and Paused People using existing hooks; thirteen safeguard tests and guards pass, isolated desktop/phone/light/dark interaction and audio playback checks pass; protected backend/hooks unchanged, no calls placed.
- [ ] Verify Automated Calls with a live signed-in CRM/CTO/super-admin account — blocked: externally managed authentication cannot be restored by browser tools; live campaign changes and real test calls were not attempted.
- [x] Stop automatic replay of Payables forecast timeout/permission failures; four tests, safety guards and preview compilation pass; no financial writes.
- [ ] Apply and verify read-only Payables forecast optimization — blocked: migration service returned 42P10; live definition confirmed unchanged. Signed-in end-to-end verification unavailable for external Supabase.
- [x] Add recorded agent performance to product application details using the existing Agent Ops report; four tests and guards pass, preview build OK; approval rules unchanged.
- [ ] Verify application performance with a live signed-in agent — blocked: external Supabase authentication cannot be restored by available browser tools.
- [x] Add /portfolio-invite-test using the existing completion form; signed-out form/signature/submission verified, safety test and guards pass, build OK; no emails or live financial writes.
- [x] Add Not verified and Rejected filters inside Paid & Repaying, preserving its paid/repaying scope across all pages; 28 tests, guards and preview compilation pass. Live authenticated check unavailable for externally managed authentication.
- [x] Add Landlord Ops paid-but-unverified filter presentation, count contract, export support and four passing hook tests; guards and preview compilation pass, payments/verification unchanged.
- [ ] Enable paid-but-unverified matching — blocked: migration service repeatedly fails with 42P10 and live functions remain absent; filter safely disabled, SQL parity test cannot run; authenticated browser check unavailable for external Supabase.
- [x] Update AgentDailyCapacityStrip to best-day tenant coverage, both-day context and tenant shortfalls; money/arrears and all hooks/backend preserved. Four calculation tests and isolated desktop/mobile light/dark checks pass; build OK.
- [ ] Verify tenant strip on live agent accounts — blocked: externally managed authentication is unavailable to browser testing; supplied NSUBUGA figures and a six-tenant shortfall were checked in isolation.
- [x] Add CTO Git Pushes view; 3 filter/refresh tests pass, isolated desktop/mobile checks cover expanded details and both themes; Commits and protected push hook/backend preserved.
- [ ] Verify CTO Pushes with live signed-in history — blocked: externally managed authentication is unavailable to browser testing.
- [x] Patch dashboard auth-lock delays: bounded identity reads, duplicate startup role lookup removed, single-flight watchdog and header identity reuse; 28 tests and safety guards pass, public sign-in renders without runtime errors.
- [ ] Verify patched dashboard with a real signed-in account — blocked: externally managed authentication cannot be restored by the available testing tools.
- [x] Build CFO landlord float budget setter first, miscellaneous approvals and period history.
- [x] Add COO budget gating/miscellaneous UI and CFO Return to COO/excess warnings without changing existing handlers.
- [x] Run budget UI tests, project guards and desktop/phone checks; no live budget amounts saved.
- [ ] Set today's and this week's landlord float budgets — waiting for the designated CFO to enter the approved amounts.
- [x] Make CRM Broadcast visible; tests and guards pass.
- [ ] Verify Broadcast publishing and acknowledgement end to end — blocked: the signed-in preview account lacks CRM publishing permission.
- [x] Add protected CRM communications publishing, scheduling, versioning and audience checks; live RLS and revoked direct-write/TRUNCATE privileges verified.
- [x] Add CRM editor/preview and shared recipient dialogs with cross-device acknowledgement; 25 tests, phone/desktop preview, mandatory-dialog queue and guards pass.
- [ ] Verify CRM publish → recipient acknowledgement → cross-device readback with authorised accounts — blocked: injected account has neither CRM nor super-admin; own-account session mint failed. No messages published or money moved.
- [x] Make the R&D weekly report editable using shared recorded updates; signed-in add/edit/reload and PDF download verified, ten R&D tests and all guards pass.
- [x] Diagnose and fix Service Centre tenant-request Claim failures; four tests pass and signed-in location/server errors verified without claiming real requests or moving money.
- [x] Update Landlord Ops principal recovery with disbursed-float comparison, three KPIs, fee breakdown dialog and table; verified signed-in live figures, Today/All time, dialog, phone-width graph, guards and three accounting tests; no money moved.
- [x] Add and verify repayment progress and today's expected-versus-collected rent in the selected Agent Ops product profile; checked Joel's live figures and charts without moving money.
- [x] Simplify lending to four entry choices and add a five-user directory with photos, IDs, locations, phone and available vouched amounts; guards and pagination test passed.
- [ ] Verify lending navigation in the signed-in preview — blocked by inconsistent dashboard loading and stacked notices; no money-moving actions tested.
- [x] Align Agent Ops Shopping Advance counts, lists and dossiers with rolling 24-hour received transfers; verified signed-in count, list and real-user dossier without moving money.
- [x] Add selected-note Approve & Pay with live proxy-agent payout preview and explicit confirmation.
- [x] Run logic guards and confirm error-free compilation.
- [ ] Verify signed-in preview and cancellation without sending real payouts — blocked because the requester has no matching sign-in account; preview sign-in required.
- [x] Match Tenant Products & Services to the supplied reference without changing financial logic.
- [x] Verify tenant product tabs, live figures and layout in the signed-in preview.
- [x] Match Payables to the Receivables workspace layout without changing financial logic.
- [x] Verify Payables navigation, live totals and detail views in the signed-in preview.
- [x] Replace the lending sidebar section with Receivables Forecast matching Payables periods and layout.
- [x] Verify Receivables Forecast periods, projections and navigation in the signed-in preview.
- [x] Base Receivables behavior projections on completed past weeks and months and verify live figures.- [x] Merchandise categories: company issued (handover) vs out-sourced (CFO to wallet).
- [x] Widen tenant transfer agent search to all enabled agents.

## Open (8 Oct 2026)
- [ ] Flagged agent wallets: lift only after ID + fraud checks — waiting for which agents, and who approved
- [ ] Agent dashboard: move direct table writes to secure server procedures — waiting for the user to choose where to start
- [x] Remove the duplicate "Schedules" card from the agent menu People section; verified signed-in that it is gone and the other People cards remain.
- [x] Agent dashboard preview: header profile circle now shows the signed-in user's photo, with initials fallback when no photo or the saved photo link is dead; verified signed-in.
- [x] Agent dashboard preview: "Collections due today" card now lists the real tenants still owing today (name, days behind, amount due) from the same server read the Collect dialog uses; empty state only when genuinely nothing is due. Verified signed-in: SSEMANDO MATHIAS, UGX 4,767, 8 days behind — matches the Tenants figures.
- [x] Agent dashboard preview: removed the "Today's Capacity" card and its now-unused figures/styles; the purple "Today's rent" card, shortcuts, "Collections due today" and calendar remain. Verified signed-in, no overflow, build OK.

- [x] Replace the selected supporter agreement with the approved partner contract; isolated browser review and PDF download target verified, guards and build clean; signed-in dashboard check unavailable because requester has no matching auth account. No acceptance or money movement.

- [x] CFO Approved Rent Requests: Approved tab lists every CFO approval all time; Paid only after Financial Operations payout.
- [x] Usage report amount matching: popup + CFO review + server rules live; matching rule tests pass. Not yet clicked through signed-in.
- [x] CFO Approved Rent Requests: date filters (Today etc.) use the CFO approval time; Approved column shows CFO approval time.
- [x] Make CFO sidebar "Payroll Approvals" open as a CFO dashboard section instead of jumping to the HR shell; CFO click, breadcrumb and HR /approvals page verified in preview.

- [x] Apply the approved agent dashboard nudge figures migration exactly as written; stored functions verified identical to the file, signed-in call returns figures, signed-out call refused.

## CMO Inbox
- [x] Add Neexa conversation list, live thread, reply composer and template dialog using only existing mirror tables and edge function; protected backend/generated types unchanged.
- [x] Hide the staff reply box and Send button behind REPLY_COMPOSER_ENABLED=false in NeexaInbox.tsx; code and tests retained, template sending still available.
- [x] Run 11 Inbox rule/interaction tests and isolated desktop/mobile light/dark checks; preview compilation and guards pass.
- [ ] Verify live signed-in Neexa sync and customer send/readback — blocked: external Supabase authentication cannot be restored by available browser tools; no customer messages sent.
- [x] Update Neexa Inbox KPI cards for agreement-based figures: Referred by Neexa card, contract-amount sub-lines and pending_agreements; 17 inbox tests pass, typecheck and build OK; no migrations or RPCs touched.

## Verified email screens
- [x] Polish email collection and self-editor presentation, preserving eligibility, verification and agent editing.
- [x] Run 10 focused tests and isolated desktop/mobile checks; guards and preview compilation pass; deployed email backend, hooks and migrations untouched.
- [ ] Verify email delivery and confirmation on a live signed-in account — blocked: external Supabase authentication is unavailable to browser tools; isolated flow checks passed without sending email.
- [x] Open agent profiles from the Agent Directory By Region view: district rows expand to that district's agents via the existing guarded register RPC (exact district+region match, capped paging), each row opens the existing profile panel; six tests, guards and preview build pass; no database changes.
- [ ] Verify the regional agent drill-down with a live signed-in Agent Ops account — blocked: externally managed authentication cannot be restored by browser tools; real district lists and profile panels were not opened live.
- [x] Add region filter chips with agent counts, a district dropdown scoped to the chosen region and a filtered count line to the By Region directory; ten directory tests pass, typecheck clean, no database changes.
- [x] Add region and district dropdowns (counts included, district scoped to the region) to the List view's compact mobile filter panel, with an area-named count line and a clear control; 23 directory tests pass, typecheck clean, guards pass, preview build OK.
- [ ] Move the List view's area filter onto a server-side `p_region`/`p_district` parameter on `get_agent_directory_v2` — blocked: the migration tool rejects every submission with `ERROR: 42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification` (Lovable platform incident, https://status.lovable.dev); the live function is verified unchanged (5 parameters), so the panel currently narrows areas by paging the existing search and matching returned region/district fields exactly.

## Hide in-app call buttons while human calling is paused
- [x] Hide in-app call buttons in CRM Call Centre (Overview/People/History recall+call buttons, summary-sheet Call button) and Tenant Ops Calling Center (details-dialog Call button, sequential-run start) while `useHumanCallingPaused()` reports the pause, with the shared "Calling from the app is paused…" notice incl. relative paused time; handset (tel:) and WhatsApp links, lists, history, outcome recording and preview mode unchanged; 5 new tests + guards pass.
- [ ] Verify the pause behaviour live and confirm the build — blocked: the sandbox workspace never received commit `afe2367d7d` (the re-sync trigger was missed), so `useHumanCallingPaused` is not in this checkout yet and the touched screens do not compile here until the sync lands; code is written exactly against that hook, no workaround added.

## Weekly all-calls report function
- [ ] Apply `supabase/migrations/20261022160000_cc_weekly_all_calls_report.sql` (read-only `cc_weekly_all_calls_report(timestamptz,timestamptz)`) — blocked: the migration tool rejected the exact file contents with `ERROR: 42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification` (same platform incident as earlier submissions; the SQL has no ON CONFLICT). Live readback confirms the function does NOT exist, so nothing applied and no data changed. Workspace is synced past `6d2bdd3c2e` (HEAD `3e0d2aed52`); the four report files were not edited.

## One-figure receivables header (Agent / Tenant / Landlord Ops)
- [x] Show only a large "Total receivable" UGX figure (from the existing `get_receivables_total` RPC, same number as the CFO dashboard) plus open item count and an "as at" time in EAT, with a Refresh button, on Agent Ops, Tenant Ops and Landlord Ops (`/executive-hub?tab=agent-ops|tenant-ops|landlord-ops` and the `/landlord-ops` home page). Rest of each dashboard behind a "Show all dashboard" button, collapsed by default; on load failure (roles that cannot call the RPC) show "Unavailable", never 0, and open the full dashboard automatically; links carrying query parameters beyond `tab` open the full dashboard. Display only — no database, migration or permission changes.
- [ ] Verify the header on a live signed-in Agent Ops / Tenant Ops / Landlord Ops account — blocked: externally managed Supabase authentication cannot be restored by browser tools, so the sandbox only reaches the sign-in page. 4 gate tests, typecheck and all guards pass; preview build OK.
- [x] Put the Money Received section back on Cash Position as the full-width ninth figure tile below the eight tiles; isolated desktop/phone fixture check shows nine tiles, no console errors and no horizontal overflow; all guards and typecheck pass. No financial, database or deployment changes.

## Finance budget head change (27 Oct 2026)
- [x] Replaced Finance department budget head (MERCY BAYO account) with Nankambo Sharimah; verified live row now points to her (updated 2026-10-27 08:43 UTC).

## Welile Homes read-only audit + Excel export (27 Oct 2026, chemayek abraham)
- [x] Read-only Welile Homes audit exported to /mnt/documents/welile_homes_audit_2026-10-27.xlsx — 8 tabs, 23 subscriptions, 240 dues, 4 float requests, 129 ledger legs, 29 people; sums verified against DB aggregates. No writes.

## AgentTenantsSheet stale-chunk guard (27 Oct 2026)
- [x] Checked: both lazy imports (AgentDashboard, AgentDashboardBk) already use lazyNamed, which reloads once for a missing export and then shows "This section needs a refresh"; renders sit inside LazyModal/Suspense. No code change needed.
