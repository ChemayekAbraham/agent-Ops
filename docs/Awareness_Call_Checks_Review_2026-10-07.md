# Rent Pipeline "Awareness Call Check" — Review of What Was Built, in Plain Language

**Reviewed:** 7 Oct 2026 · **Compared against:** `Rent_Pipeline_Awareness_Call_Checks (2).md` (the plan and its five prompts)
**Method:** read the plan, then checked the code and the live database. Nothing was changed while reviewing.
**Ground rule kept:** no existing pipeline step, status, approval or rejection is to be changed. Everything below is add-on or reporting only.

---

## 1. The short answer

The five prompts were carried out and the main goal is in place: staff can phone the tenant or landlord from the review screens, record what they heard, see what earlier stages recorded, and a monitoring page reports on it. **Approve and Reject were not touched** (the change to the existing review screen is a handful of added lines, and tests confirm Verify, Decline and the comment rule behave as before).

But five things are **wrong or missing** and are worth fixing before the team relies on it:

1. **The two awareness questions are not worded the way you asked.** (Most important.)
2. **Agent calls cannot be recorded at all**, although the plan says Agent Ops usually calls "Tenant / agent" and the monitoring page has an "Agent" filter.
3. **If the call history fails to load for any reason, the whole call box disappears** (buttons included).
4. **Staff are only nudged inside the open request.** The quick approve and bulk approve buttons on the list screens never show whether a call was made, and callers cannot see their own call history.
5. **Nothing was ever checked in a real browser.** The sign-in kept expiring, so the phone and desktop look of all three screens is untested.

Smaller points are in section 4.

**Today's live state:** 0 calls recorded, 0 system events. The tables and nine database functions are in place and tested; the system is simply waiting for its first real call. The Service Centre queue holds **3,802** requests (all assigned to one of 53 managers), which is where most calls will happen.

---

## 2. What the plan asked for, and what exists

| Plan item | Built? | Notes |
|---|---|---|
| One record per saved call, never edited or deleted, system event on every save | **Yes** | Table is append-only (the database refuses edits and deletes), and each save writes a system event. |
| Same 30M answer choices as the Calling Centre report | **Yes, with one spelling difference** | Plan wrote "heard_unsure"; the live 30M record already stores "heard" (shown as "Heard but unsure"). The built system uses "heard" so both sets of numbers can be added together. This was a deliberate choice. |
| "Call tenant" / "Call landlord" buttons that remember the time | **Yes** | Opens the phone dialler, remembers the time, survives leaving the app (kept 24 hours). |
| Short feedback form when the person returns | **Yes** | Result, two awareness answers, explained, note. Merchant codes shown beside the question. |
| "Earlier stages said…" list | **Yes** | Grouped by team, read-only, shows who, when, stage and answers. |
| Approve / Reject unchanged; "recorded, not forced" | **Yes** | Soft reminder only. |
| Same box on the Service Centre queue | **Yes** | Tenant is suggested first; calls are recorded under "Service centre" automatically. |
| Landlord Ops starts with "Call landlord"; Tenant and Agent Ops with "Call tenant" | **Yes** | Confirmed and tested. |
| Server-side reports (summary, by team, by caller, gaps, log) on Kampala days | **Yes** | All checked against independent counts. Fast (under 150 ms on live data). |
| Monitoring page with five tabs and all filters, CSV/Excel export | **Yes** | Filters for result, answer, district and request status needed a small extension of the reports (added, old behaviour unchanged). |
| Who can see the page: Tenant Ops, COO, CEO, super admin | **Yes** | Others see "Not available". |
| **Exact wording of the two questions** | **No** | See 3.1. |
| **"Tenant / agent" calls for Agent Ops** | **No** | See 3.2. |
| **Callers see their own records** | **Partly** | Only inside each request; no "my calls" view. See 3.4. |
| **Trend by day / week** | **Partly** | Daily only. |
| **Checked on phone and desktop in a real browser** | **No** | See 3.5. |

---

## 3. What is missing or should be corrected

### 3.1 The two questions do not say what you asked (correct this first)

Your plan asks:
1. *Does the person know a tenant who pays well can grow their access **up to UGX 30,000,000**?*
2. *Does the person know they can **pay by themselves** using Welile merchant codes (**self-payment**)?*

The call box currently asks:
1. "Before you explained, did they know about **the 30M Rent Plan**?"
2. "Did they know **the Welile merchant codes used to pay**?"

Question 1 never mentions growing access or UGX 30,000,000, and the product's own message elsewhere in the app is "grow your rent access up to UGX 30,000,000". Question 2 never mentions paying by themselves. Staff could ask different things and the numbers would not mean what the report says they mean. Only the wording needs changing; the stored answers stay the same, so nothing already recorded is affected. The monitoring page and the exports use the same loose names ("Knew about 30M") and should be renamed to match.

### 3.2 Agent calls cannot be recorded
The database, the reports and the "Person type" filter all support "Agent", and the plan says Agent Ops usually calls "Tenant / agent". But the call box only has "Call tenant" and "Call landlord", and the agent's phone is already on the sheet. Result: the Agent filter will always be empty. Fix: add a "Call agent" button (smaller, after the two main ones).

### 3.3 One failed load hides the whole box
If the list of earlier calls fails to load (weak connection, a hiccup), the call box removes itself, including the Call buttons and the form, even though saving a call does not need that list. Only people who are not allowed to use it should lose the box. Everyone else should see a "Could not load earlier calls — try again" line and still be able to call and record.

### 3.4 Nudges and visibility are thin
- The reminder ("No awareness call has been saved yet") only appears **after** opening a request. **Quick approve and bulk approve on the list screens show nothing** about calls. You said not to change approvals, so the fix is a small read-only label on each list row ("No call yet at this stage" / "Called 2×"), not a block.
- The plan says callers see **their own records**. Today a caller can only see calls inside a request they open. There is no "my calls" count (for example "your calls this week: 14, 71% answered").
- At the **COO and CFO** stages the plan says nobody is expected to phone, yet the box shows Call buttons and the "no call saved" reminder. Those stages should see the earlier answers read-only, without buttons or reminder. (Partner Ops has its own screen with no box at all, and Partner Ops users cannot record or read these calls. Decide whether they should at least see the earlier answers.)
- On the Landlord Ops screen there is already a landlord "call and confirm" checklist. The new box sits separately, so staff may think one call covers both. A short label should say they are different things.

### 3.5 Never checked in a real browser
Because the preview sign-in expired each time, the new box, the Service Centre card version and the monitoring page were tested only by automated tests and database checks, **not on a real phone-sized and desktop screen**. Things that need a human-style check: the box is far down the long review sheet on a phone, how the five tabs and eight filters sit at 390 px, and whether the install-app pop-up covers anything. One more real limit: on a desktop computer a `tel:` link may open nothing, in which case staff use "Record feedback" and the call time recorded is when the form was opened.

---

## 4. Smaller points

- **Old rejections:** about 25 of 631 old rejected requests have no stage timestamp and would never show as "without a call". The last 30 days are fine (all 51 captured). A rejection-stage fallback would close this.
- **Old status name:** the Tenant Ops list also shows requests with the old status "agent_verified". A call made then is stored under that name and will not match the Tenant Ops stage in the gaps report. (None are waiting today.)
- **Merchant codes are typed into the app** (MTN 090777, Airtel 4380664). They match the live codes today, but should come from the same place the Communications tab reads them, so they cannot drift.
- **Trend chart** is daily only; a weekly option helps for long date ranges.
- **Menu entry:** "Awareness Calls" shows for everyone in Tenant Ops Classic, but only four roles can open it; others see "Not available". Better to hide the entry.
- **Each pending card in the Service Centre queue** loads its own call history. Fine for a handful of requests; a manager with dozens pending would trigger dozens of small requests (the list-label fix in Prompt B removes this).
- **A safety note on the database:** the new table points at the rent request table. This does not change any approval, but it means a rent request that has awareness calls can never be hard-deleted (the system already only marks requests deleted, never removes them).

---

## 5. Honest limits (unchanged from the plan)
- We still cannot prove a phone call happened; saving feedback is what counts.
- Past requests have no answers; reports begin on the first recorded call.
- "Grow up to UGX 30,000,000" is the message being tested, not a promise to that tenant.
- Because calls can never be edited, **do not make test calls on live requests**. A wrong test row stays forever. Use a real call, or test with simulated data only.

---

## 6. Three prompts to finish the job (paste one at a time)

### Prompt A — Fix the call box: wording, agent calls, errors, stage behaviour
```
READ CLAUDE.md first. Work only on the shared awareness call panel
(src/components/pipeline/AwarenessCallPanel.tsx), its labels (src/lib/awarenessCallLabels.ts,
src/lib/awarenessMonitoringLabels.ts) and the labels in the monitoring page and CSV/Excel export.
HARD RULE: do not change any approve, reject, verify, decline, return-for-correction handler, status,
trigger or pipeline function, and do not change the stored answer values (knew|heard|did_not_know,
yes|partly|no) or the database table.
1. Reword the questions exactly:
   Q1 "Does this person know that a tenant who pays well can grow their access up to UGX 30,000,000?"
   Q2 "Does this person know they can pay by themselves using the Welile merchant codes (self-payment)?"
   Q3 "Did you explain it to them on this call?"
   Rename the matching labels everywhere they appear (cards, charts, tables, filters, CSV/Excel headers):
   "Knew about 30M access" and "Knew about merchant-code self-payment". Use formatUGX style "UGX 30,000,000".
2. Add a "Call agent" button (subject_type 'agent', phone = the agent phone already on the sheet / queue card).
   Order the call buttons by stage: Landlord Ops = landlord, tenant, agent; all others = tenant, landlord, agent
   (agent last, smaller). Pass subject_user_id only for tenant and agent where the id exists on the request.
3. Do not hide the whole panel when the earlier-calls list fails to load. Hide it only when the error is
   "not authorized". For any other error keep the Call buttons and the form working and show
   "Could not load earlier calls" with a Retry button.
4. Add a prop to show the panel read-only (no Call buttons, no reminder, only "Earlier stages said…") and use it
   for the COO and CFO stages in RentPipelineQueue (stages partner_ops_approved and coo_approved). Keep the
   current behaviour for Agent Ops, Tenant Ops, Landlord Ops and the Service Centre queue.
5. On the Landlord Ops stage, add one line under the heading: "This is separate from the landlord verification
   call checklist below." Do not touch that checklist.
6. Replace the hard-coded merchant codes with the live codes the Communications tab already reads
   (payment_channels via the existing hook), falling back to the current two codes if the read fails.
7. Move the panel up the Review Rent Request sheet so it sits right after the tenant/landlord/agent phone block
   (still add-only; no handler changes), and keep it at the same place in the Service Centre card.
8. Update the tests. Run npm run guard:all. Then, in the signed-in preview as a tenant_ops user, check the
   Review Rent Request sheet and the Service Centre card at 390 px wide and at desktop width and send screenshots.
   Do NOT save any real call on a live request (the log cannot be edited or deleted); stop at the form.
Plain wording only: "Rent Plan", "Supporter", "Returns".
```

### Prompt B — Show who still needs a call, and let callers see their own work
```
READ CLAUDE.md first. Add-only and read-only. HARD RULE: do not change any approve, reject, quick approve,
bulk approve, verify or decline behaviour, or any pipeline status or function; do not block or confirm anything.
Backend (new migration, new functions only, same role check as record_awareness_call, SECURITY DEFINER,
search_path=public, no anon grant, rollback file, test as a rolled-back block):
1. awareness_call_status_for_requests(p_request_ids uuid[]) -> one row per request: calls_total, calls_at_current_stage,
   answered_at_current_stage, last_call_at, and which person types (tenant|landlord|agent) have an answered call.
   Limit to 200 ids per call.
2. my_awareness_calls_summary(p_from, p_to) and my_awareness_calls_log(p_from, p_to, p_limit, p_offset): only the
   signed-in caller's own calls (auth.uid()), Kampala day buckets, same answer counts as the monitoring page.
Frontend:
3. In RentPipelineQueue lists (cards and rows) and ServiceCenterRentVettingQueue cards add a small read-only badge:
   "No call yet at this stage" or "Called N times", plus an optional list filter chip "No call yet". Fetch the badges
   with one batched call per page of results (not one per card), and stop the per-card history reads in the
   Service Centre queue if the badge now covers it.
4. Add a small "Your awareness calls" card (this week: calls, answered %, people reached, and a short recent list)
   to the Service Centre queue header and to the Agent Ops, Tenant Ops and Landlord Ops pipeline screens, using
   the new my_awareness_calls_* functions. Mobile-first, existing design tokens.
5. Tests for the badge states, the batching and the card. Run npm run guard:all.
6. Preview as a tenant_ops user and as a service centre manager (if the preview allows) at 390 px and desktop;
   report what the badge and the card show. Do not save any real call.
```

### Prompt C — Tighten the reports and prove the page in a real browser
```
READ CLAUDE.md first. Reporting and page only. HARD RULE: no change to any pipeline status, approval or
rejection, and no writes to rent_requests or the awareness table.
Backend (new migration; replace the awareness_* report functions with extended versions, keep every existing
parameter and result field, add a rollback file and a rolled-back test comparing to independent counts):
1. awareness_coverage_gaps: also treat a request as having moved past a stage when it was REJECTED at that stage
   (rent_requests.rejected_at / rejected_at_stage, including the legacy names 'agent_verified' -> Tenant Ops stage,
   'coo' -> COO stage, and a null stage -> Service Centre when service_center_reviewed_at is set), even if the
   stage's *_reviewed_at is empty. Add an "outcome" field per row (approved | rejected) and a filter p_outcome.
2. Treat a call stored with pipeline_stage 'agent_verified' as the Tenant Ops stage in the gaps and by-stage counts.
3. awareness_calls_summary: add p_bucket ('day'|'week') for the trend; default 'day'.
Page (src/components/executive/tenant-ops/awareness/*):
4. Day/Week toggle on the Overview trend; "Outcome" filter on Requests without a call; show the outcome on each row.
5. Hide the "Awareness Calls" menu entry for people who cannot open it (Tenant Ops, COO, CEO, super admin only);
   keep the "Not available" message if someone opens the link directly.
6. Update tests and the build log. Run npm run guard:all.
Verification (do this carefully):
7. Sign in to the preview as a tenant_ops user. Open Awareness Calls at 390 px and at desktop width. For all five
   tabs report what each card, table and chart shows and compare the numbers with the same reports run in SQL.
   Take screenshots; report any sideways scroll, overlap or hidden control.
8. Do NOT save any real call on a live request. If a real call is needed to see the full flow, stop and ask me,
   because rows cannot be edited or deleted.
```
