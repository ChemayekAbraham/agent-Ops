# Tasks
- [ ] Re-sync to `51069f32ea` (teeburg merge: data-fix migration `20261023090000_nsubuga_smartphone_term_3_months.sql`, already applied to the live database by hand) — blocked: `git merge` is refused by the sandbox and the workspace HEAD `3875cf97f4` is 2 commits behind `origin/lovable`; the migration must not be run. Read-only check confirms the live plan is already 3 months.

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
