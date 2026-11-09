# Boardroom display and reminder deployment
- [x] Confirm pushed commit 24ae17b868 is included and reminder sources match it unchanged.
- [x] Deploy partner/proxy promissory reminders from unchanged pushed sources; 7 helper tests passed. Deployment tool reports source hashes, not numeric versions.
- [x] Add an isolated public totals-only boardroom display with polling and TV controls.
- [x] Test display privacy, refresh/retry behavior and TV/mobile rendering; 8 display tests passed, no extra account requests or horizontal overflow.
- [ ] Verify real board totals with an enabled display link; no valid display token was supplied. Real invalid-link message verified.

# Signages CFO disbursement
- [ ] Change verified installations to Awaiting CFO, with activation only after CFO disbursement.
- [ ] Connect Pay Agent, Pay Owner and Batch Pay Agents to authorized, duplicate-safe payments.
- [ ] Test installation/payment rules and verify available preview signals.

# Signages and dashboard loading
- [x] Fetch photo-free cached Signages queues from the restored/cached session; load evidence only for the selected application.
- [x] Lazy-load inactive Agent Ops, COO and CFO sections and defer unrelated background reads.
- [x] Run loading/approval regressions (33 tests), guards and signed-out route checks; build OK.
- [ ] Measure signed-in queue/dashboard speed and inspect real evidence; no authorized browser session is available.

# Welile Signages COO approval
- [x] Use standard sans-serif throughout Signages applications and dialogs; existing Agent Ops → Awaiting COO handoff and COO tab confirmed in source, 20 regression tests passed and build OK (signed-in verification remains blocked by external unmanaged authentication).
- [x] Require real GPS, block duplicate locations and flag repeat owner phones.
- [x] Require installed-board evidence before billing and keep active reviews read-only.
- [x] Allow agent returned-application edits/resubmit and hide cancelled declined spots.
- [x] Test Signages safeguards (20 tests passed; guards passed; build OK).
- [ ] Verify GPS capture, resubmit and installed-photo activation on a signed-in phone; external sign-in prevents testing here.
- [x] Confirm Agent Ops approvals against fresh server status and refresh the queues immediately.
- [x] Show COO-approved Signages in the CFO default queue and clarify the COO handoff.
- [x] Run approval regression tests and project safeguards for the updated handoff (16 tests passed; build OK; all guards passed).
- [x] Add Awaiting COO and enforce Agent Ops → COO → installation → existing CFO workflow.
- [x] Add the COO Signages approval tab and test the status transitions and controls.
- [x] Check build, guards and signed-out routing without runtime errors.
- [ ] Verify a real Agent Ops → COO approval through signed-in screens; external unmanaged authentication prevents authenticated testing here.

# Production frontend errors (9 November)
- [x] Audit realtime owner columns and wallet transaction reads; current frontend already uses valid columns. SMS-log duplicate writes and partner-enum failures have no frontend source.
- [x] Sanitize UUID lookup lists and handle normal missing rows.
- [x] Gate authenticated work, handle subagent/LC1 duplicates, and prevent broken avatar requests.
- [x] Run targeted regression tests, guards, and signed-out browser checks; build OK.
- [ ] Verify authenticated production flows and reduction in production log errors; external unmanaged authentication prevents signed-in testing here.

# Agreement Returns rate input
- [x] Add selected-portfolio rate editing through the existing server approval workflow and active-rate contract rendering.
- [x] Run focused tests and guards (6 tests passed; all safeguards passed).
- [ ] Verify an actual authorized rate save; external unmanaged authentication prevents signed-in browser verification.

# Funders Houses to fund switch
- [x] Fix obsolete test imports after the restored discovery change.
- [x] Restore empty-house discovery and amounts with pending-verification labels; preserve server funding enforcement and bookings.
- [x] Run focused discovery regression tests and check preview signals (8 tests passed; build OK).
- [x] Restrict desk-script reading to active assigned desk staff; live access assertions passed and security finding resolved.
- [x] Apply fail-closed empty-house visibility to discovery, pins, recommendations and counts; preserve bookings and server errors.
- [x] Run focused switch and discovery regression tests; verify available preview signals.
- [ ] Verify through a real signed-in Funder; external unmanaged authentication prevents an authenticated browser check.

# Browser saved items
- [x] Add a hamburger Saved Items dialog backed by existing browser bookmarks.
- [x] Remove unavailable houses and Rent Plans using successful, unfiltered server reads; test persistence and cleanup (31 focused tests passed).
- [ ] Verify Saved Items with a real signed-in Funder; external unmanaged authentication prevents an authenticated browser check.

# Agent KYC command center
- [x] Improve review-table design, selected-tab contrast, profile photos and recorded metadata.
- [x] Keep agent review in a bounded dossier and check desktop/mobile interactions with isolated sample records.
- [x] Add reviewer-authorized, masked identity groups and recorded event trends.
- [x] Build the command overview, review queue and linked-agent navigation.
- [x] Preserve review actions and test identity/trend contracts and existing review behavior.
- [x] Reconcile read-only totals and check desktop/mobile rendering with isolated sample records.
- [ ] Verify the full reports through a real authorized reviewer session; blocked by external unmanaged authentication and restricted SQL helper access.
# Agent Ops ID re-upload
- [x] Add "Ask agent to re-upload ID" button, dialog, history label and page test.

# Unified 360-Day Contract Engine
- [x] Pricing engine and tests (src/lib/contractEngine360.ts).
- [x] Database proposal written (docs/pending-migrations/v360_contract_engine.sql).
- [x] Database engine applied (columns, pricing, schedules, daily split, Day-30 buffer cover, mark day, Guest Tenant, plan summary).
- [x] Front-end hook useV360Plan.
- [ ] Switch new Rent Plan creation to v360, agent buttons, dashboard figures, Nexa quotes, Day-30 daily job, buffer seed, ledger posting; waiting on Benjamin (see reply).

# Josh sync 1d7a22a4e1
- [x] Confirm sync to 1d7a22a4e1; no SQL re-run.
- [x] Redeploy self-update-phone, payment-reminder, send-push-notification.
- [x] Requisition receipt columns: pending draft updated (helper grants for authenticated, MFA policy check).
- [ ] Apply receipt columns migration; waiting on Josh/Benjamin go-ahead.
- [x] Publish so browsers load the login telemetry fix.
