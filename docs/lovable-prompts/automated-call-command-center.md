# Lovable prompt: Automated Calls Command Center (CRM, CTO, super admin)

Build the **Automated Calls Command Center**, the screen that runs our robot phone calls (Africa's Talking IVR). The backend, the data hook and the helpers are already built. **Build the UI only.** Don't change `src/hooks/useVoiceAutocall.ts`, `src/lib/voiceAutocall.ts`, the database or the edge functions.

## Who can see it
Only **crm, cto and super_admin**. Nobody else sees it: not manager, ceo, coo, admin, or any ops role.
- Sidebar: in `src/components/layout/executiveSidebarConfig.ts`, add a CRM section titled **"Automated Calls"** with `access: { roles: ['crm', 'cto', 'super_admin'] }` on every item (same pattern as "SMS Campaigns"). Items and tab ids:
  - Overview (`autocall-overview`)
  - Campaigns (`autocall-campaigns`)
  - Scripts (`autocall-scripts`)
  - Call Log (`autocall-calls`)
  - Paused People (`autocall-pauses`)
- Render each tab in the CRM dashboard the same way existing CRM tabs are rendered.
- Wrap the whole view: if `useCanUseAutocall()` is false, show "Automated calls are limited to CRM, CTO and super admin." and nothing else. The server also refuses everyone else, so this check only controls what's shown.
- Put the components in `src/components/crm/autocall/`.

## Data (already built; use as-is)
Everything is in `src/hooks/useVoiceAutocall.ts`. Labels and helpers are in `src/lib/voiceAutocall.ts`:
- `AUTOCALL_CATEGORIES` and `AUTOCALL_CATEGORY_LABELS`: Tenants, Partners, Agents, Employees, General.
- `AUTOCALL_STATUS_LABELS`, `outcomeLabel()`, `AUTOCALL_AUDIENCE_LABELS`, `AUTOCALL_AUDIENCES_BY_CATEGORY`.
- Helpers: `describeSchedule()`, `estimateRunMinutes()`, `windowMinutes()`, `checkScript()`, `orderedSteps()`, `fillScriptText()`, `SCRIPT_VARIABLES`.

All mutations invalidate the queries for you. Show the server's error message in a toast on failure, and disable a button while its mutation is pending.

---

## 1. Overview tab
Source: `useAutocallOverview()`, which refreshes every 15 s.

**Engine status bar** (from `data.system`):
- If `configured` is false, show a red banner: "Automated calling is not connected. The automated-calls phone number is not set up yet." Include `last_error` in small text.
- Otherwise show:
  - "Engine last ran {relative last_tick_at}". Turn this amber if it was more than 3 minutes ago, except outside 07:00–22:00 Kampala, when the engine is meant to sleep.
  - "Lines: {channels}"
  - "Airtime: {balance_currency} {balance_amount}". If `low_balance` is true, show a red chip: "Airtime low, calling stopped. Top up Africa's Talking."

**Master switch:** a big **Pause all automated calls** / **Resume all** button. It's paused when every category is paused.
- Pausing asks for a reason in a dialog, then calls `useSetCategoryPaused().mutateAsync({ category: null, paused: true, reason })`.
- Resuming calls it with `paused: false`.

**One card per category** (Tenants, Partners, Agents, Employees, General), from `data.categories`:
- **Header:** the label, plus a **Pause / Resume** toggle for that category (`category: 'tenant'`, etc.). Pausing requires a reason.
  - While paused, show a red "Paused" badge with "by {paused_by_name}, {relative paused_at}: {pause_reason}".
- **Today:** `total` calls, `completed` answered, `no_answer`, `failed`, `live` (on the call now, with a pulsing dot), `queued` waiting, `opted_out`.
  - Talk time: `talk_seconds`, shown as h m.
  - Cost: `cost`.
- **Footer:** "{active_campaigns} campaigns running · {people_paused} people paused".
- Partners, Agents, Employees and General have no campaigns yet. Their cards still show and can still be paused.

## 2. Campaigns tab
Source: `useAutocallCampaigns(category)`. Put a category filter on top, defaulting to Tenants.

A card per campaign:
- **Header:** name, status badge (draft / active = "Running" / paused / completed), category, and the audience text from `AUTOCALL_AUDIENCE_LABELS[audience_kind]`.
- **Schedule:** `describeSchedule(c)`, plus "Up to {max_attempts} tries, {retry_minutes} minutes apart" and "Recording on/off".
- **Script:** "{script_name} (v{script_version})", linking to the Scripts tab.
- **Last run** (`last_run`), if present:
  - "{run_date}: {audience} people ({skipped_paused} skipped because paused or opted out)"
  - A progress bar of completed / no_answer / failed / expired / queued / live.
- **Run-length warning:** compute `estimateRunMinutes(last_run?.audience ?? 0, overview.system.channels ?? 5)`. If it's more than `windowMinutes(window_start, window_end)`, show an amber note: "At {channels} lines, calling everyone once takes about {h m}, longer than the {window} window. Ask Africa's Talking for more lines or widen the window."
- **Buttons:**
  - **Start** (draft/paused → `useSetCampaignStatus` with `status: 'active'`). Confirm first: "Calls will start automatically every {days} at {window_start}. Continue?"
  - **Pause** (active → `'paused'`). Use a dialog with a checkbox: "Also cancel people still waiting today" (`cancelQueued`).
  - **Edit**, **Archive** (with a confirm), and **View calls** (opens the Call Log filtered to this campaign).
- **"New campaign"** button: a form backed by `useSaveCampaign()`.
  - Fields: category; name; description; script (a select from `useAutocallScripts(category, false)`); audience (options from `AUTOCALL_AUDIENCES_BY_CATEGORY[category]`); schedule (every week on chosen days, or once at a date/time).
  - Window start and end: time pickers between **08:00 and 19:00 only**.
  - Days: Mon–Sat checkboxes. **There is no Sunday option.**
  - Tries 1–5, minutes between tries (15–1440), and a record-calls switch.
  - New campaigns save as draft; the user presses Start separately.
- **Manual campaigns** (`audience_kind = 'manual'`) also get an **Add people** button: search for people, then `useAddPeopleToCampaign()`.

## 3. Scripts tab
Source: `useAutocallScripts(category)`. Put a category filter on top. Scripts are what the robot says, and **staff must be able to read and edit them.**

**List:** name, occasion (e.g. rent_due, missed_payment, holiday), version, active switch (`useSetScriptActive`), "used by" campaign chips, and last edited by and when.

**Script view (read mode):** show the call as a readable flow using `orderedSteps(script.steps)`, one card per step in the order a listener hears it.
- Step type icon: say 🔈, menu 🔢, record 🎙, transfer 📞, hangup ⏹.
- The words, shown with sample values via `fillScriptText(step.say)`, with a toggle to show the raw `{placeholders}` instead.
- For menus, list each key: "Press 1 → {next step name}" with the outcome label.
- "If no key pressed → …".
- Highlight the opt-out key (action `opt_out`) in red: "Stops all automated calls to this person".

**Edit mode** (on the same page):
- Edit the name, occasion and description.
- Per step: a textarea for the words, a type select, next-step selects, and menu key rows (key, outcome, next).
- Add and remove steps.
- Show the `SCRIPT_VARIABLES` chips above the textarea; clicking one inserts `{first_name}` etc.
- Run `checkScript()` live and show each issue on its step. This includes the banned-word check: "loan" → Rent Plan, "lender" → Supporter, "interest"/"ROI" → Returns. Disable Save while issues exist.
- Save calls `useSaveScript()`.
  - If the script is in use, warn first: "This changes the words for future calls in {campaigns}. Calls already in progress keep the old wording."
- **New script** button: start from a copy of an existing script (pick one) or from a blank start/menu/hangup skeleton. Also allow **Duplicate for another occasion**, which copies a script into a new one (for example a holiday version).

**Version history:** a drawer using `useAutocallScriptVersions(scriptId)`. List versions with who saved them and when, and a side-by-side view of any version's words. A **Restore** button saves that version's steps as a new version through `useSaveScript`.

**Test call:** a **Call my phone** button, `useTestCall().mutateAsync({ scriptId })`. Toast: "Your phone will ring within a minute with this script."

## 4. Call Log tab
Source: `useAutocallCalls(filters)` (paged, 50 per page).

**Filters:** category, campaign, status, outcome, a date range (Kampala dates), and search by name or number.

**Table columns:**
- When: `last_attempt_at` or `created_at`
- Person: name, plus a masked phone
- Category
- Campaign / script
- Status: a badge from `AUTOCALL_STATUS_LABELS`. Show "Test" if `is_test`.
- Outcome: `outcomeLabel()`
- Tries: "{attempts}/{max_attempts}"; while queued, add "next at {time}"
- Talk time
- Cost
- Recording: a 🎧 icon if `has_recording`

Click a row to open a **Call detail** drawer, using `useAutocallCallDetail(id)`:
- Summary at the top, plus the variables that were read out (amount, date…).
- **Playback:** if `call.recording_path` exists, an `<audio controls>` player using `useAutocallRecordingUrl(path)`. Show each voice message from `responses[].recording_path` with its own player, labelled "Voice message (step {step})".
- **What they pressed:** a timeline from `responses`: "Attempt {n} · {step}: pressed {digits} → {outcomeLabel}". Show "no key" when `digits` is null.
- **Technical log:** a collapsible list of `events` (kind, step, time). Don't show payload values by default; add a "Show raw" toggle for CTO debugging.
- **Buttons:**
  - **Cancel call** while status is queued: `useCancelCall()`.
  - **Pause this person**: opens the pause dialog below, prefilled.

## 5. Paused People tab
Source: `useAutocallPauses(category, includeLifted, search)`.
- **List:** name, masked phone, scope ("All automated calls" when `category` is null, otherwise the category label), reason, source ("Pressed 9 on a call" for `ivr_opt_out`, or "Staff: {created_by_name}"), until, and created.
- **Lift pause** button (`useLiftPause`). Confirm first; for `ivr_opt_out` rows, warn: "This person asked to stop these calls. Only lift this if they asked to receive them again."
- **Pause someone** button: search for a person, then choose scope (all automated calls, or one category), a reason (required) and an optional "until" date. Calls `usePausePerson()`.
- A "Show lifted" toggle.

## Style
- Follow the existing CRM dashboard look (shadcn Card, Table, Badge, Dialog, Drawer, Tabs, Switch) and make it responsive. At phone width, tables become stacked cards and the category cards stack.
- All times are Africa/Kampala.

## Copy rules
- Use "Rent Plan" (never loan), "Supporter" (never lender), and "Returns" (never ROI or interest).
- Use plain English. Don't show "RPC", "job", "IVR", "DTMF" or "RLS" in the UI. Say "call", "key pressed", "script", "step".
