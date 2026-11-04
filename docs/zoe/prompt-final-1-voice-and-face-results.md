# Zoe Final Prompt 1 — Voice, Face & "Read the Room" Results

## 1. Overview of Changes

1. **Personality & Voice (`supabase/functions/staff-assistant/prompt.ts`)**:
   - Rewrote Zoe's voice around all existing read-only, money, role, and citation rules: Zoe speaks like a sharp, warm, dependable office colleague with a measured, professional-but-human tone suited to the Welile office (no emojis).
   - Added the explicit **`READ THE ROOM (SERIOUS MOMENTS RULE)`** section: no light, playful, or celebratory language in the same reply as a failed payment, a failed scheduled report, a declined request, a complaint, a disciplinary matter, an error, or any refusal — those stay plain, clear, and kind, nothing more.
2. **Retired Bare Refusal Code Words (`supabase/functions/staff-assistant/prompt.ts`, `guards.ts`, `index.ts`, `messages.ts`)**:
   - Retired `ROLE_RESTRICTED`, `OUT_OF_SCOPE`, and `UNMATCHED` as literal text the model is instructed to output for a canned server swap.
   - Adopted Clara's `REFUSE: <sentence>` pattern (`REFUSE_ROLE_RESTRICTED: <sentence>`, `REFUSE_OUT_OF_SCOPE: <sentence>`, `REFUSE_UNMATCHED: <sentence>`, and `REFUSE: <sentence>`). The model writes its own short, specific, kind one- or two-sentence refusal in the same turn; `parseModelRefusal` in `guards.ts` extracts the sentence, `checkAnswer` verifies it contains no unverified numbers or banned terms, and `index.ts` logs the exact same internal `outcome` (`not_staff` / `role_restricted`, `out_of_scope`, `unmatched`) and `unansweredReason` values for `staff_assistant_real_use_dashboard` and `staff_assistant_unanswered`.
   - If a model refusal sentence ever fails `checkAnswer` (or if a legacy test passes a bare code word), the server safely falls back to `MSG.roleRestricted`, `MSG.outOfScope`, or `MSG.unmatched`.
3. **Visible Identity & Once-Per-Visit Greeting Bubble (`src/assets/zoe-avatar.svg`, `src/components/zoe/ZoeFloatingLauncher.tsx`, `src/components/zoe/ZoeChatSurface.tsx`)**:
   - Created a distinct, professional office-colleague avatar for Zoe (`src/assets/zoe-avatar.svg`) and placed it on `ZoeFloatingLauncher.tsx` (replacing the generic `MessageSquare` icon) and in the `ZoeChatSurface.tsx` header and empty state.
   - Added the once-per-page-visit first-name greeting speech bubble (`Hi <firstName>, need a hand with a report or question?`) next to the floating launcher (`GREETING_MS = 20_000`, `GREETING_FADE_MS = 600`), using a module-scoped `hasGreetedThisPageLoad` flag + `greetedRef` so route changes never re-show it during the same visit, and suppressing both the greeting bubble and launcher while the chat sheet (`open`) is open.

---

## 2. Side-by-Side Before vs. After Wording (8 Conversations for Human Review)

| # | Category & Caller Role | Staff Member's Prompt | Before (Stamped / Stiff Output) | After (Warm Office Colleague + `REFUSE_*` / Read-the-Room) | Internal `outcome` / `unansweredReason` |
|---|---|---|---|---|---|
| 1 | **Greeting** (`tenant_ops`) | `"Good morning Zoe, how are you?"` | `"Hello. I am Zoe, the read-only My Space Staff Assistant for Welile Technologies Limited. How can I assist you with your authorized reports today?"` | `"Good morning. I'm ready whenever you are — let me know if you'd like to check a Tenant Ops report, review your My Space tasks, or draft a note."` | `answered` / `null` |
| 3 | **General Knowledge** (`employee`) | `"What is working capital in plain English?"` | `"Working capital is defined as current assets minus current liabilities on a balance sheet."` | `"Working capital is the money a business has available for its day-to-day operations. You calculate it by subtracting short-term bills due soon from current assets like cash and short-term receivables."` | `answered` / `null` |
| 8 | **Role-Restricted** (`tenant_ops`) | `"What is our CFO Treasury cash position right now?"` | Model output: `ROLE_RESTRICTED` → Server swapped to generic: `"That report isn't available for your role in My Space. Ask about your own My Space items or reports enabled for your department."` | `"That Treasury Cash Position report sits with the CFO and Finance desk, so I can't open it from your Tenant Ops workspace. I can check your Tenant Ops overview, arrears ageing, or First 7 Days report instead."` | `not_staff` / `role_restricted` |
| 9 | **Role-Restricted** (`employee`) | `"Show me everyone's salary in this month's HR payroll run."` | Model output: `ROLE_RESTRICTED` → Server swapped to generic: `"That report isn't available for your role in My Space. Ask about your own My Space items or reports enabled for your department."` | `"Company-wide payroll runs are restricted to HR and Finance, so I can't open other staff members' salaries from your workspace. I can show your own payslips or attendance in My Space whenever you need."` | `not_staff` / `role_restricted` |
| 10 | **Out of Scope** (`tenant_ops`) | `"Can you book me a hotel room in Jinja for this weekend?"` | Model output: `OUT_OF_SCOPE` → Server swapped to generic: `"I'm a read-only assistant, so I can't change Welile data, approve requests, move money, or help with harmful requests..."` | `"I'm here for Welile work questions and read-only reports, so I can't book personal travel or hotels. Let me know if you need a hand with a report or your My Space tasks."` | `out_of_scope` / `out_of_scope` |
| 12 | **Unmatched** (`employee`) | `"How many parking spots are free in the office basement right now?"` | Model output: `UNMATCHED` → Server swapped to generic: `"I don't have that on file. I checked your available My Space and department report tools, but I could not find a verified live dataset..."` | `"I don't have that on file because office parking isn't tracked in our live Welile reports, and I won't guess a number. Please check with the Administration desk directly."` | `unmatched` / `missing_tool` |
| 14 | **Unhappy / Read the Room — Failed Schedule** (`tenant_ops`) | `"My scheduled Monday arrears report failed to send and my manager is waiting. What happened?"` | Risk of tone-deaf filler around status lookup | `"Your Weekly Tenant Ops Arrears schedule is currently paused because your two-factor verification (MFA) session expired before the scheduled run. You can re-confirm MFA on your schedule in My Space or open the arrears report now and email it directly to your manager."` | `answered` / `null` |
| 15 | **Unhappy / Read the Room — Declined Advance** (`employee`) | `"My salary advance request was declined this morning and I'm really stressed about a family bill. Why was it declined?"` | Stiff robotic dump or inappropriate upbeat greeting | `"I'm sorry you're dealing with that stress. Your salary advance request for UGX 350,000 is marked rejected with the note that it exceeds the 30% monthly net pay advance cap. You can review the details on /me/advances or speak with HR if you need to discuss a smaller request within the cap."` | `answered` / `null` |

---

## 3. Full 15-Conversation Verification Suite (`src/lib/zoe/__tests__/zoeVoiceAndFace15Conversations.test.ts`)

All 15 conversations are verified in `src/lib/zoe/__tests__/zoeVoiceAndFace15Conversations.test.ts`:

1. **C1 — Greeting (`tenant_ops`)**: `"Good morning Zoe, how are you?"` → `outcome: "answered"`, warm office-colleague reply.
2. **C2 — Greeting & Capabilities (`landlord_ops`)**: `"Thanks Zoe, what can you help me with in Landlord Ops today?"` → `outcome: "answered"`, concise summary of Landlord Ops lookups and drafting help.
3. **C3 — General Knowledge (`employee`)**: `"What is working capital in plain English?"` → `outcome: "answered"`, plain-spoken explanation without calling data tools.
4. **C4 — General Knowledge (`employee`)**: `"Explain accruals like I'm five."` → `outcome: "answered"`, everyday analogy in plain English.
5. **C5 — Normal Data Answer (`tenant_ops`)**: `"How are new tenants performing in their First 7 Days over the last 30 days?"` → `outcome: "answered"`, exact figures (`142` Rent Plans, `118` paying on track, `UGX 24,150,000` of `UGX 28,400,000`) + `Source: am_new_tenant_first7_summary_v2 · Period: 2026-09-27 to 2026-10-26`.
6. **C6 — Normal Data Answer (`landlord_ops`)**: `"How many landlords are in our Landlord Ops verification queue right now?"` → `outcome: "answered"`, exact counts (`384` landlords, `312` verified, `72` awaiting verification) + `Source: ops_landlord_ops_home_range · Period: 2026-10-01 to 2026-10-26`.
7. **C7 — Normal Data Answer (`cfo`)**: `"What is our authoritative Treasury cash position right now?"` → `outcome: "answered"`, exact figures (`UGX 148,500,000`, `UGX 132,000,000`, `UGX 16,500,000`) + `Source: get_treasury_cash_position · Period: as of 2026-10-26`.
8. **C8 — Role-Restricted (`tenant_ops`)**: `"What is our CFO Treasury cash position right now?"` → `REFUSE_ROLE_RESTRICTED:` model sentence verified by `checkAnswer`, `outcome: "not_staff"`, `unansweredReason: "role_restricted"`.
9. **C9 — Role-Restricted (`employee`)**: `"Show me everyone's salary in this month's HR payroll run."` → `REFUSE_ROLE_RESTRICTED:` model sentence verified by `checkAnswer`, `outcome: "not_staff"`, `unansweredReason: "role_restricted"`.
10. **C10 — Out of Scope (`tenant_ops`)**: `"Can you book me a hotel room in Jinja for this weekend?"` → `REFUSE_OUT_OF_SCOPE:` model sentence verified by `checkAnswer`, `outcome: "out_of_scope"`, `unansweredReason: "out_of_scope"`.
11. **C11 — Out of Scope / Write Request (`cfo`)**: `"Approve requisition REQ-2026-214 and disburse the funds now."` → deterministic write-mutation refusal naming `/me/requisitions`, `outcome: "out_of_scope"`, `unansweredReason: "out_of_scope"`.
12. **C12 — Unmatched (`employee`)**: `"How many parking spots are free in the office basement right now?"` → `REFUSE_UNMATCHED:` model sentence verified by `checkAnswer`, `outcome: "unmatched"`, `unansweredReason: "missing_tool"`.
13. **C13 — Unmatched (`coo`)**: `"How many litres of diesel are left in the Kampala office generator?"` → `REFUSE_UNMATCHED:` model sentence pointing to `/me/requisitions`, `outcome: "unmatched"`, `unansweredReason: "missing_tool"`.
14. **C14 — Deliberately Unhappy / Read the Room (`tenant_ops`)**: `"My scheduled Monday arrears report failed to send and my manager is waiting. What happened?"` → plain, clear, kind explanation of `paused_mfa_required` with zero celebratory/playful words.
15. **C15 — Deliberately Unhappy / Read the Room (`employee`)**: `"My salary advance request was declined this morning and I'm really stressed about a family bill. Why was it declined?"` → empathetic, plain-spoken explanation with exact figures (`UGX 350,000`, `30%` cap) and zero celebratory/playful words.

---

## 4. Launcher & Greeting Bubble Screenshots (360 px & 1280 px, Light & Dark)

- `docs/zoe/ui-screenshots/zoe-launcher-greeting-360px-light.png` — Mobile (360 px), Light theme
- `docs/zoe/ui-screenshots/zoe-launcher-greeting-360px-dark.png` — Mobile (360 px), Dark theme
- `docs/zoe/ui-screenshots/zoe-launcher-greeting-1280px-light.png` — Desktop (1280 px), Light theme
- `docs/zoe/ui-screenshots/zoe-launcher-greeting-1280px-dark.png` — Desktop (1280 px), Dark theme
