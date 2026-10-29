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
- [ ] Apply database changes, waterfall, Day-30 job, agent actions, dashboard bindings; blocked: the only connected database is production.
