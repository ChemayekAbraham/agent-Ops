# Rent Pipeline "Awareness Call Check" — Plan in Plain Language

**Requested by:** Timothy Christian Waniaye · **Date:** 7 Oct 2026
**Status:** Plan only. No code, data or approval rules have been changed.

---

## 1. What you asked for, in one paragraph

Before anyone in the rent pipeline approves or rejects a rent request, they should **call** the
person concerned (tenant or landlord), ask **two awareness questions**, and **record the answers**:

1. *Does the person know a tenant who pays well can grow their access up to UGX 30,000,000?*
2. *Does the person know they can pay by themselves using Welile merchant codes (self-payment)?*

Each stage must see what earlier stages recorded. Every saved answer counts as **one call**.
All of it shows up in **one monitoring page** in Tenant Ops → Classic, with tabs and filters.
**Nothing about how requests move through the pipeline changes.**

---

## 2. How the rent pipeline works today (what we found)

A rent request moves through these steps. Each step is a different team pressing "Approve" or "Reject":

| # | Who | Request status while waiting for them | Who they usually call |
|---|-----|------------------|------------------------|
| 1 | Service Centre | `service_center_review` | Tenant |
| 2 | Agent Ops | `pending` | Tenant / agent |
| 3 | Tenant Ops | `agent_ops_approved` | Tenant |
| 4 | Landlord Ops | `tenant_ops_approved` | Landlord |
| 5 | Partner Ops (attach proxy agent) | `landlord_ops_approved` | — |
| 6 | COO | `partner_ops_approved` | — |
| 7 | CFO (funds) | `coo_approved` | — |

Today's numbers: 3,795 requests sit at Service Centre review, 83 at Tenant Ops, 5 at Landlord Ops;
644 requests were created in the last 30 days.

Where the screens live:
- Service Centre: the Service Centre rent vetting queue.
- Agent Ops, Tenant Ops, Landlord Ops, COO, CFO: the shared **Review Rent Request** sheet (the one you selected).
  It already shows earlier stages' notes as read-only context — the new answers can be shown the same way.

What already exists that we can reuse:
- **Call logs**: separate tenant call reports, landlord call reports and Calling Centre call records exist,
  but they are **not tied to a pipeline stage** and do not ask the two awareness questions.
- **30M awareness**: the Calling Centre weekly PDF already has a "30M Rent Plan awareness" section
  (knew / heard but unsure / did not know). We should **use the same answer choices** so the numbers match.
- **Phone numbers**: the review sheet already shows tenant, landlord, agent and LC1 phone numbers
  and WhatsApp links. A "Call" button just needs to open the phone dialler (`tel:` link).
- **Merchant codes**: merchant code pills already exist in the app, so the caller can read them out.

---

## 3. Recommended design

### 3.1 A new "Awareness call" box on the review screens (add-on only)
On the Service Centre queue and on the Review Rent Request sheet, add one small box:

1. **Call tenant** / **Call landlord** buttons → opens the phone app and remembers the time pressed.
2. When the person returns to the screen, a short form appears:
   - Did the call go through? (Answered / No answer / Phone off / Wrong number)
   - Knew about 30M access? (Knew / Heard but unsure / Did not know)
   - Explained to them? (Yes / Partly / No)
   - Knew about merchant code self-payment? (Knew / Heard but unsure / Did not know)
   - Optional short note.
3. **Save** → counts as one call for that person, stage and request.
4. Below it, a **"Earlier stages said…"** list showing each previous answer (who, which team, when).

**Important:** Approve / Reject buttons stay exactly as they are. The check is **recorded, not forced**.
We recommend starting as "nudge only" (a reminder if no call is saved) and later deciding whether to make it required.

### 3.2 One record per saved call
A new log (one row per saved feedback) holding: the rent request, the person called (tenant/landlord/agent),
their phone, the caller, the caller's team and pipeline stage, when "Call" was pressed, when feedback was saved,
call result, the 30M answer, the merchant-code answer, whether it was explained, and the note.
Rows are never edited or deleted — a correction is a new row. This matches the project's audit rules,
and each save also writes a system event.

### 3.3 Monitoring page — Tenant Ops → Classic → "Awareness Calls"
Tabs:
1. **Overview** — total calls, people reached, % who knew about 30M, % who knew merchant codes, trend chart by day/week.
2. **By stage/team** — Service Centre vs Agent Ops vs Tenant Ops vs Landlord Ops side by side.
3. **By caller** — each staff member: calls made, answered rate, awareness found.
4. **Requests without a call** — requests approved/rejected with no awareness call recorded (coverage gaps).
5. **Call log** — every call, searchable, exportable to CSV/Excel.

Filters on every tab: date range, team/stage, caller, person type (tenant/landlord), call result,
answer choice, region/district, request status. All counts are worked out on the server, not in the browser.

### 3.4 Who can see it
Tenant Ops, COO, CEO, super admin see the full page. Callers see their own records and the
"earlier stages said" list on requests they are reviewing.

---

## 4. Honest limits
- **We cannot prove a phone call happened.** The phone app is outside Welile. We record "Call pressed"
  and "feedback saved" times; saving feedback is what counts as a call (as you asked).
- **Past requests have no answers.** Reports start from the day this goes live.
- **"Pays well → up to 30M"** is the message being tested, not a promise to that tenant; the real limit
  still comes from the existing limit rules.

---

## 5. Five prompts to build it gradually (paste into Claude one at a time)

### Prompt 1 — Data foundation (backend only)
```
READ CLAUDE.md and SYSTEM_CONTEXT.md first. Verify against the LIVE schema, not migrations.
Goal: store "awareness call" feedback for the rent pipeline WITHOUT changing any pipeline logic,
statuses, approve/reject functions or triggers.
1. Create append-only table public.rent_pipeline_awareness_calls: id, rent_request_id (FK rent_requests),
   subject_type ('tenant'|'landlord'|'agent'), subject_user_id nullable, subject_phone, caller_id,
   caller_team ('service_centre'|'agent_ops'|'tenant_ops'|'landlord_ops'|'other'),
   pipeline_stage (the rent_requests.status at time of call), dial_started_at, recorded_at default now(),
   call_result ('answered'|'no_answer'|'phone_off'|'wrong_number'),
   aware_30m and aware_merchant_codes ('knew'|'heard_unsure'|'did_not_know'|null when not answered),
   explained ('yes'|'partly'|'no'|null), note text.
   Use the SAME 30M answer choices as awareness30m in src/lib/callingCenterWeeklyForwardingPdf.ts.
   GRANTs, RLS, no UPDATE/DELETE policies. Indexes on rent_request_id, caller_id, recorded_at.
2. SECURITY DEFINER RPC record_awareness_call(...) (search_path=public): checks caller has a pipeline role,
   derives caller_team from roles and stage from current request status, inserts the row, emits a system_event.
3. SECURITY DEFINER RPC get_awareness_calls_for_request(p_rent_request_id) returning all rows with caller name/team.
Do not touch any UI. Run npm run guard:all. Report the SQL and test with one dry insert inside a rolled-back transaction.
```

### Prompt 2 — Call buttons + feedback form on the Review Rent Request sheet
```
In src/components/executive/RentPipelineQueue.tsx (Review Rent Request sheet) ADD — do not modify
approve/reject handlers — an "Awareness call" section:
- "Call tenant" and "Call landlord" buttons using tel: links with the phones already shown; on click store
  dial_started_at in component state (and sessionStorage keyed by request id so it survives leaving the app).
- On return (visibilitychange/focus) or by tapping "Record feedback", show the short form
  (call result, aware_30m, explained, aware_merchant_codes, note), show merchant codes with MerchantCodePills.
- Save via record_awareness_call RPC; refetch fresh data after save.
- "Earlier stages said…" list via get_awareness_calls_for_request, grouped by team, read-only.
- Soft reminder text if no call saved yet; Approve/Reject must still work exactly as before.
Mobile-first, existing design tokens, no hardcoded colours. Rent Plan / Supporter / Returns terminology.
```

### Prompt 3 — Same box on the Service Centre queue
```
Reuse the awareness-call component from Prompt 2 (extract to src/components/pipeline/AwarenessCallPanel.tsx
if not already shared) inside src/components/agent/service-center/ServiceCenterRentVettingQueue.tsx,
with caller_team 'service_centre'. Do not change any vetting/approval logic. Confirm the Landlord Ops stage
defaults to "Call landlord" and Tenant/Agent Ops to "Call tenant". Run guard:all.
```

### Prompt 4 — Reporting functions (backend)
```
Create role-gated SECURITY DEFINER RPCs (tenant_ops, coo, ceo, super_admin) for the monitoring page:
- awareness_calls_summary(p_from, p_to, p_team, p_caller, p_subject_type, p_region): totals, people reached,
  answered %, 30M knew/heard/did-not-know counts, merchant-code counts, explained counts, daily trend.
- awareness_calls_by_team(...) and awareness_calls_by_caller(...).
- awareness_coverage_gaps(...): rent requests that moved past a stage (use *_reviewed_at columns) in the date
  range with no awareness call recorded at that stage.
- awareness_calls_log(..., p_limit, p_offset) paginated with names, phones, request, stage.
All aggregation server-side, Kampala (EAT) day buckets via the same convention as src/lib/kampalaDays.ts.
Read-only; no writes. Run guard:all.
```

### Prompt 5 — "Awareness Calls" page in Tenant Ops → Classic
```
Add a new Classic view "Awareness Calls" to src/components/executive/tenant-ops/tenantOpsNav.ts and
TenantOpsClassicShell (follow existing view-key pattern; do not alter other views).
Tabs: Overview (cards + trend chart), By stage/team, By caller, Requests without a call, Call log.
Shared filter bar: date range (default last 7 days), team, caller, person type, call result, answer choice,
region/district, request status. Use the Prompt 4 RPCs only. CSV/Excel export of the log.
Follow existing Tenant Ops UI, design tokens, formatUGX where amounts appear. Verify in the preview as a
tenant_ops user and report what each card shows.
```
