---
name: Tenant Calling Center
description: Tenant Ops → Classic → Calling Center; CRM voice dialing (manual + attended sequential) on top of the unmodified cc_* calling spine, sibling to the Calling Hub
type: feature
---
Location: `?tab=tenant-ops&mode=classic&view=calling-center` (shell case in `TenantOpsClassicShell`, nav leaf `calling-center` in `tenantOpsNav.ts`). The existing `calling-hub` view is untouched and stays the workflow reference.

Files: `src/components/executive/tenant-ops/calling-center/` — `TenantCallingCenter.tsx` (tabs: Overview / Work Queue / Live Call / History / Settings), `useTenantCallCenterDialer.ts` (sequence owner), `LiveCallPanel.tsx`, `TenantCallCenterHistory.tsx`.

Rules:
- Workflow data is the SAME spine: `useCcCallingHub('tenant', …)` unmodified, `cc_*` RPCs, shared `RecordOutcomeDialog` / `OpenAttemptQueue` / `FollowupsDuePanel` / `CallingFilterBar`. No new call or tenant tables.
- The phone leg is `useCrmVoiceCall` (CRM Africa's Talking browser WebRTC) unmodified; `crm_start_webrtc_call` resolves the number server-side, so the browser never handles raw numbers or provider keys.
- Auto calling is ATTENDED sequential only: officer starts, cap 5/10/25/50, pause/resume/stop. Unanswered legs auto-record the mapped cc outcome (`no_answer` / `refused` / `phone_off`); answered legs stop the run until the officer records the outcome. The run advances only once the Hub's open-attempt list shows the attempt closed — never on dialog dismiss.
- Reveal goes through `hub.reveal`, so the database WIP guard remains authoritative.
