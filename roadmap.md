# Browser saved items
- [ ] Add a hamburger Saved Items dialog backed by existing browser bookmarks.
- [ ] Remove unavailable houses and Rent Plans using successful, unfiltered server reads; test persistence and cleanup.

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
