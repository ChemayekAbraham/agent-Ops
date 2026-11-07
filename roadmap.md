# Funders Houses to fund switch
- [x] Fix obsolete test imports after the restored discovery change.
- [x] Restore empty-house discovery and amounts with pending-verification labels; preserve server funding enforcement and bookings.
- [x] Run focused discovery regression tests and check preview signals (8 tests passed; build OK).
- [ ] Restrict desk-script reading; waiting on user confirmation of intended readers for the automatic security finding.
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
