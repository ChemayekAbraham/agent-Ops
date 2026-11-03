# Agent vetting: UI contract (hand-off to Gemini)

Data and logic are done, applied to production and tested:

- Migrations `20261027160000_agent_vetting.sql` and `20261027180000_agent_vetting_parent_id_link.sql`. Both are **applied**. Don't run them again.
- `src/lib/agentVetting.ts`, which holds the checklist, the parsers and the error reader. It's covered by `agentVetting.test.ts`.
- `src/hooks/useAgentVetting.ts`, for the agent.
- `src/hooks/useAgentVettingQueue.ts`, for Agent Ops.

No shared JSX was changed. Everything below is built from values the hooks already return. **Don't calculate anything in the browser.** In particular, don't re-check GPS distance, the 20-per-ID cap, or whether the agent is verified. The server checks all of these again on submit.

**What this is.** Agent Ops verifies every agent before that agent can add tenants or post Rent Plan requests. The block is in the database and is **switched off for now** (`agent_vetting_settings.enforce = false`). The screens below are what agents need before it is switched on.

**Only agents see the agent screen.** The RPCs refuse anyone without the `agent` role.

---

## 1. Agent screen: "Agent verification"

**Route:** `/dashboard/agent/verification`. Link to it from the agent dashboard banner (section 3).

**Data:** `const v = useAgentVetting();`. The record is `v.vetting`, an `AgentVetting` from `src/lib/agentVetting.ts`.

### 1.1 Header

- **Status chip:** `VETTING_STATUS_LABEL[vetting.status]`. The four values are:
  - `unverified`: "Not verified"
  - `submitted`: "With Agent Ops for review"
  - `verified`: "Verified"
  - `rejected`: "Sent back by Agent Ops"
- **Rejected:** when `status === 'rejected'`, show `vetting.review_note` in a callout titled "What to fix". The note is Agent Ops' own words.
- **Progress:** `vettingProgress(vettingChecklist(vetting))` gives `{ done, total }`. Show it as "4 of 7 done".
- **Deadline:** if `vetting.enforced` is false but `vetting.enforce_from` is set, show one line: "From {date}, you need to be verified to add tenants."
- **Read-only while in review:** when `canEditVetting(status)` is false (`submitted`), the whole screen is read-only. Show "Agent Ops is reviewing your details. We'll let you know." and hide every action button.
- **Editing a verified record:** when the agent edits a section while `verified`, show a confirm dialog first: "Changing this sends your verification back to Agent Ops for review. You can't add tenants until they approve it again." The server reopens it automatically; this dialog is just the warning.

### 1.2 Steps

Render `vettingChecklist(vetting)` in the order it returns. Each step is a card with:

- the label
- a done/not-done state
- `step.hint` when not done, shown as plain help text, not as an error

The cards stay in a fixed order, each can be opened on its own, and there's no wizard lock.

| `key` | Shows | Actions (hook) |
|---|---|---|
| `phone` | `vetting.phone.value` as text, read-only | "Send code" → `sendPhoneCode()`. A 6-digit input → `confirmPhoneCode(code)`. Number wrong? A link "Change my number" goes to the existing phone-change screen in Settings. Vetting never edits the number. |
| `email` | `vetting.email.value` if set, otherwise an empty email input. Synthetic `@welile.agent` addresses come back as `null` on purpose, so the agent has to type a real one. | "Send code" → `sendEmailCode(address)`, which returns `{ challengeId }`. Keep it in state. Code input → `confirmEmailCode(challengeId, code)`. Show `emailAttemptsLeft` when it's not null. |
| `residence` | Pre-filled fields from `vetting.residence`: region, district, sub-county, parish, village, town, city. District and village are required. | "Save" → `saveResidence({...})`. Reuse the district → village pickers from `src/components/agent/AgentContactLocationGate.tsx`. Don't build new ones. |
| `location` | **No typing.** One button, "Capture my location". Once captured, show read-only lat, lng (5 decimals), "Accurate to {accuracy_m} m" and the capture time, plus a small static map pin. | `captureLocation()`. If the reading is older than `gps_rules.max_age_minutes`, the step shows its "too old" hint. The button then reads "Capture again". |
| `national_id` | See 1.3 | See 1.3 |
| `passport_photo` | A thumbnail once saved, from the signed URL of `vetting.passport_photo.path` via `identityPhotoUrl` | "Take passport photo" (front camera, `capture="user"`) → `savePassportPhoto(file)`. It grades the photo first and throws with advice if there's no face or the grade is a fail. Show the thrown message under the photo. |
| `next_of_kin` | If `vetting.next_of_kin.source === 'parent_agent'`: "{name}, {phone}, Parent agent" with a "Change" link. Otherwise: name, phone and relationship inputs. | `saveNextOfKin({ useParent: true })`, or `saveNextOfKin({ name, phone, relationship })`. Offer "Use my parent agent" only when `vetting.parent_agent` is set. Agents without a parent must enter someone. |

`v.busy` names the action in flight: `'phone_confirm'`, `'location'`, `'submit'` and so on. Use it to disable that step's button and show a spinner on it only.

### 1.3 National ID step

The agent chooses between two options. The second is shown only when `vetting.national_id.can_use_parent` is true.

**A. "My own National ID"** (`chooseIdSource('own')`)
- **NIN on file:** show **only** `vetting.national_id.nin_masked`, e.g. `CM0*******QTOE`, plus front/back ticks from `has_front` / `has_back`. Never show a full NIN anywhere.
- **Re-upload:** a "Re-upload ID photos" action that opens the existing `src/components/wallet/IdentityPhotoCapture.tsx` (the withdraw flow's component) as it is. It takes front and back, reads the card through PassGate, and writes the photos to the profile. Don't fork it. Call `v.refresh()` when it closes.
- **No ID on file:** the same component, opened straight away.
- **Linked to another account:** when `vetting.national_id.linked_to` is set, show the server's `reason` and "This ID is linked to {linked_to.first_name} ({linked_to.phone_masked})". Then offer "Use my parent agent's ID instead" if allowed.

**B. "Use my parent agent's ID"** (only when `can_use_parent`)
- **First:** "Ask {parent_agent.name}" → `requestParentIdLink()`. This texts the parent a code. The agent never types the parent's NIN and only ever sees it masked.
- **Then:** follow `v.parentIdLink?.status` (it refreshes itself every 15 s while waiting):
  - `awaiting_owner` with no `code_verified_at`: "Ask {parent} for the 6-digit code we sent them." Code input → `confirmParentIdCode(code)`.
  - `awaiting_owner` with `code_verified_at`, or `owner_approved`: "Waiting for {parent} to approve in their app."
  - `active`: done. Show `nin_masked` and "Your parent agent's ID".
  - `rejected_by_owner` / `rejected_by_staff` / `expired` / `cancelled_by_requester`: show `decision_reason` if set, otherwise "This request ended." Offer "Ask again" and "Use my own ID".
- **Cap:** if the request comes back with "already used by 20 accounts", the hook throws that message. Show it, and offer option A.

### 1.4 Submit

- **The button:** a sticky bottom "Submit for review", enabled whenever the status is editable. Don't disable it just because steps are incomplete: the server's list is the authority.
- **On press:** `const r = await v.submit()`. This takes a second location reading first, so show "Checking your location…".
  - `r.success`: a full-width success state: "Sent to Agent Ops. We'll let you know when you're verified."
  - Otherwise: a panel titled `r.message`, listing every string in `r.missing` as written, each with a link that scrolls to the matching step card. Matching on the first words is enough ("Confirm your phone…" → phone, and so on).
- **Thrown errors** (no GPS permission, network): a toast with `error.message`. The GPS helper's messages are already written for agents.

### 1.5 States

- **Loading:** skeleton cards.
- **`v.error`:** a message with Retry (`v.refresh()`). Never show "Not verified" on error.
- **Width:** 360/390 px first. Cards full width, buttons at least 44 px, inputs stacked. From md up, a two-column layout is fine (steps on the left, the sticky summary and submit on the right).
- **Styling:** semantic tokens only, no emojis. "Rejected" uses the destructive token. Unfinished steps are neutral, not red.

---

## 2. Agent Ops: "Agent verification" review

**Route:** `/agent-ops/agent-verification`. Use the same `RoleGuard` pattern as the other `/agent-ops/*` routes, with `requiredPermission="agent-ops"`, and add `'agent_ops'` to `allowedRoles`. The RPCs let in only `agent_ops`, `super_admin`, `cto` and `coo`. Anyone else who reaches the page gets the error "Only Agent Ops can review agent verification." Show that as a plain message, not a crash.

### 2.1 Queue

`useAgentVettingQueue({ status, search, inScopeOnly, page, pageSize })` returns `{ total, rows, counts }`.

- **Tabs:** with counts from `counts`: "To review" (`submitted`, the default), "Sent back" (`rejected`), "Verified" (`verified`), "Not started" (`unverified`).
- **Filters:**
  - A search box (name or phone), debounced 300 ms.
  - A toggle, "Active agents only" (`inScopeOnly`). It's on by default for "Not started", because 59.5k people hold the agent role and only about 960 are active.
- **Rows:** name, phone, district, submitted time ("2 h ago", absolute time on hover), and an ID-source tag: "Own ID" or "Parent's ID". Show the parent tag in the warning token; it's a weaker check.
- **Order:** oldest submitted first (the server already sorts this way).
- **Paging:** 50 a page, with previous/next and "{from}–{to} of {total}".
- **Mobile:** rows become cards.

### 2.2 Review panel (a sheet on mobile, a side panel on desktop)

- **Data:**
  - `useAgentVettingDetail(agentId)`: the full row plus `name`, `profile_phone`, `gps_drift_m`, `residence_pin`, `id_holder`, `collections`, `rent_requests`, `events[]`.
  - `useAgentVettingPhotos(detail)`: signed `{ id_front, id_back, passport }` URLs. They last 5 minutes; refetch when the panel reopens.
- **Sections, in this order:**
  1. **Identity:** the passport photo, large, next to the profile avatar so a person can compare faces. Show the passport grade from `passport_photo_check.verdict` ("pass" / "review" / "fail") as a tag.
  2. **National ID:** front and back photos (tap to zoom). `id_nin_masked`, and the source. For the parent's ID: "Using {id_holder.name}'s ID ({id_holder.phone})".
  3. **Contact:** phone with a "confirmed {phone_verified_at}" tick, and email with its tick.
  4. **Where they stay:** the `residence` fields as text.
  5. **Live location:** one map showing the first GPS reading (`gps1_*`), the reading at submit (`gps2_*`) and, if present, `residence_pin`. Below it: "Moved {gps_drift_m} m between readings", and each reading's accuracy and time. Link "Open in Google Maps" using the `gps2` point.
  6. **Next of kin:** name, phone, relationship, and "(parent agent)" when `nok_source === 'parent_agent'`.
  7. **Activity:** "{rent_requests} rent requests, {collections} collections".
  8. **History:** `events[]`, newest first. Use plain labels: `submitted` "Submitted", `approved` "Approved", `rejected` "Sent back", `reopened` "Changed {detail.changed} after verification", `phone_confirmed`, `email_confirmed`, `parent_id_link_requested` "Asked to use parent's ID".
- **Actions:** shown only when `status === 'submitted'`, from `useDecideAgentVetting()`:
  - **Approve:** a confirm dialog, then `mutate({ agentId, approve: true })`.
  - **Send back:** a dialog with a required textarea, "What should the agent fix?", then `mutate({ agentId, approve: false, note })`. The note is shown to the agent word for word, so the placeholder should suggest plain language.
  - **Errors:** the mutation's error message as a toast. For example, "You cannot review your own verification." and "Only submitted verifications can be reviewed." (when someone else got there first; refetch).
  - **After success:** close the panel. The queue refreshes itself.

---

## 3. Agent dashboard banner and blocked actions

- **Banner:** on `/dashboard/agent`, when `vetting.status !== 'verified'`, show one banner: "Verify your agent account", plus the progress "4 of 7 done" and a button "Continue". The banner hides when the agent is verified.
  - When `vetting.enforced` is true, it reads "You need to be verified to add tenants and post Rent Plan requests."
  - When `submitted`, it reads "Agent Ops is reviewing your verification." with no button.
- **Add Tenant / New Rent Plan request:** **don't hide or disable them** based on the client; the server decides. When a create fails, run `agentNotVettedReason(error)` (from `src/lib/agentVetting.ts`). It recognises both the database error (`AGENT_NOT_VETTED: …`) and the `register-tenant` response (`code: 'agent_not_vetted'`). If it returns a string, show that string in a dialog with a button "Go to verification" leading to `/dashboard/agent/verification`, instead of the generic error toast.

---

## 4. Words

- **Required terms:** "Rent Plan" (never "loan"), "Supporter" (never "lender"), "Returns" (never "ROI" or "interest"). "Agent Ops", "parent agent", "next of kin", "National ID", "passport photo".
- **Server messages:** every message from the hooks and RPCs is already written for the agent. Show them as they are; don't wrap them in "Error:".
- **Masking:** never show a full NIN. The only NIN values the hooks return are already masked.
