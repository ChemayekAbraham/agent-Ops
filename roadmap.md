# Direct landlord payment screens
- [x] Build partner claim, held-plan/proof/status screens using only the direct-pay data layer.
- [x] Build Landlord Ops infinite review queue and agent receipt recording; preserve server-only decisions.
- [x] Test mocked flows and unavailable service states; all guards and automatic build pass; all Supabase files and production activation untouched.
- [ ] Verify production claim and approval after owner activation; blocked on unapplied migrations and external unmanaged sign-in.

# Signage shop-owner cross-check
- [ ] Add staff-only phone/account/Rent Plan matching and the Agent Ops Shop owners tab.
- [ ] Test matching, paging, access and existing signage behavior.

# Already-issued Special Advances
- [x] Add separate CFO recording for outside-Welile advances with original date, proof, duplicate safeguards and platform-only accounting; never calls the fresh payout action.
- [x] Eighty form/table/accounting tests pass, all guards pass and automatic build OK; embedded Postgres confirms original-date schedules, platform-only accounting and replay/payout refusal. Signed-in CFO end-to-end verification is unavailable with external unmanaged authentication.

# Agent Ops signage location filters
- [x] Add a region filter and search across region, district, county, sub-county, parish, village and landmarks using authorized loaded signage rows and the shared official district-region reference.
- [x] Twelve filter/photo/approval checks pass; automatic build OK. Authorized live Agent Ops browser verification remains unavailable with external unmanaged authentication.

# Invitation profile picture
- [x] Diagnose signing-placeholder errors incorrectly poisoning the shared avatar failure cache; cache only failed image attempts, keeping real failure suppression unchanged.
- [x] All 45 avatar/co-support checks pass and build OK; Benjamin's real invitation photo loads and remains visible after the one-minute refresh. Storage access unchanged.

# Agent Ops signage evidence photos
- [x] Fit complete photos inside their frames and open any clicked photo in a full-screen, closable preview; other signage desks and financial actions unchanged.
- [x] Six photo/approval tests pass and automatic build OK; isolated desktop/phone checks confirm contained portrait/landscape images, full-screen sizing and Escape returns to review. Live authorized inspection remains unavailable with external unmanaged authentication.

# Co-support invitation follow-ups
- [x] Confirm pushed commit 447b8bdd02 and the supplied float-watch regression test; keep the hook and safety boundary unchanged.
- [x] Use the supplied waiting-sheet and joined-card labels and suppress the global install prompt on invitation links only; storage untouched.
- [x] Co-support library, both page tests, upstream float-watch tests and install-route tests pass (49 checks); automatic build OK. Phone invitation route remains uncovered by the install prompt; live payment verification still requires an authorized session and valid invitation.

# Signage GPS-only locations
- [x] Populate read-only location fields from captured GPS for new and returned applications; block failed/unresolved lookups without guessing missing optional levels.
- [x] Test capture, recapture, lookup failures, locked fields and existing signage safeguards; 24 tests and all guards passed, build OK.
- [ ] Verify signed-in registration; external unmanaged authentication prevents a real authorized browser check.

# Co-support invitation redesign
- [x] Confirm commit 604a836d18, eight owner boards and required hooks/deposit callback.
- [x] Match invitation and joined views and connect existing DepositFlow to float-watch sheets; no financial writer changes.
- [x] Run co-support tests and check mobile/desktop invitation rendering and build output.
- [x] Float-watch initialization crash fixed upstream in 447b8bdd02; retain the safety boundary and re-run the supplied hook and page regressions.
- [x] Resolve merchandise storage finding: user selected uploaders and staff; applied owner/staff read restrictions, verified live policies, private bucket unchanged and finding cleared.

# Production log fixes (12 November)
- [x] Add fresh operational-float-only funding checks for Rent Plans and empty houses and clarify the review balance labels.
- [ ] Verify support through a real signed-in Funder; external unmanaged authentication prevents an authenticated browser check.
- [x] Normalize timestamp filters and regression-test the three reported tables plus sibling raw cursors.
- [x] Isolate service-role float readers and replace the browser helper with the ownership-checked capacity wrapper.
- [x] Gate weekly posting eligibility on a usable session; 25 focused tests and all guards passed; build OK.
- [ ] Verify authenticated production flows; external unmanaged authentication prevents signed-in checks here.

# Tenant Repayment Tracker exception investigation
- [x] Reproduce the displayed 243 exceptions across 208 tenants and compare plan-specific receipts, repayments, edits and Tenant Operations activity sources.
- [x] Prepare the case register and evidence-backed reporting proposal without financial or production data changes.
- [x] Apply the approved reporting-only migration, full-register pagination and exact-plan investigation/activity links; financial records unchanged.
- [x] Run reporting, pagination, permissions and preservation tests plus all project safeguards; revalidate the five live source-evidence matches.
- [ ] Verify the five corrected warnings and complete register through an authorized CFO screen; external unmanaged authentication prevents signed-in checks.
- [ ] Resolve remaining evidence gaps; requires case-specific payment/adjustment evidence and approved scope, never money movement or ledger edits.

# R&D monthly project planning
- [x] Confirm requested d572009ed0 is already included; do not reapply its migration or publish.
- [x] Add account-scoped device-saved monthly budgets and targets for each R&D project, separate from cash position and approved finance budgets.
- [x] Test save/reopen, month/project separation, zero budgets and storage failures; 27 tests and all guards passed.
- [ ] Verify recording through the signed-in /rd screen; external unmanaged authentication prevents an authenticated browser check.

# Boardroom display and reminder deployment
- [x] Confirm pushed commit 24ae17b868 is included and reminder sources match it unchanged.
- [x] Deploy partner/proxy promissory reminders from unchanged pushed sources; 7 helper tests passed. Deployment tool reports source hashes, not numeric versions.
- [x] Add an isolated public totals-only boardroom display with polling and TV controls.
- [x] Test display privacy, refresh/retry behavior and TV/mobile rendering; 8 display tests passed, no extra account requests or horizontal overflow.
- [ ] Verify real board totals with an enabled display link; no valid display token was supplied. Real invalid-link message verified.

# Signages CFO disbursement
- [x] Capture registered owner phone; enforce no owner payout before submission + 30 days and separate CFO activation from payments.
- [x] Test owner payout timing, approval-only activation and unchanged agent rewards; 28 tests and all guards pass, build OK.
- [x] Preserve authorized, duplicate-safe agent and monthly owner payments; no payout triggered during this work.
- [ ] Verify real CFO activation and payout through a signed-in screen; external unmanaged authentication prevents authenticated browser checks.

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
- [x] Allow agreement-rate editing before portfolio creation, wait for required CFO approval, and consume the approved rate atomically on countersign; matching PDF terms are rechecked before funding. UI/database regression tests and financial guards passed; real signed-in verification remains unavailable with external unmanaged authentication.

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
- [x] Special Advances table: overflow menu with Record Repayment, Top up, Reverse
- [x] Alpha Ssema only: pay assigned landlords himself from Landlord Float (code + location kept), record TID/receipt, no merchant queue, wallet untouched
- [x] Funder Saved Items: Co-support/Bookmarked/Booked pills + float-hold line on Support screen (UI only, sync 89c304d876)

## Error-watch fixes (frontend only)
- [ ] wallet_transactions.user_id: not in this app code (blocked: caller unknown); profiles referred_by fixed
- [x] resolve_short_link already .maybeSingle()
- [ ] escape search regex input (blocked: source not found in logs)
- [x] nexa_learned_knowledge browser call removed; houses not queried by app
- [x] avatar fallback + failure cache already in place
- [ ] investor_portfolios 400 (blocked: no failing request in logs)
