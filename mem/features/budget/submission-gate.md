---
name: Budget submission gate (mandatory prompt with temporary skip)
description: Backend RPC + useBudgetSubmissionGate hook are ready and INERT; the full-screen overlay is the remaining UI work. Gate blocks the app for designated heads with an outstanding budget submission, with a session-scoped Skip for Now
type: feature
---
**Status.** Backend and hook are committed and verified. **No UI is mounted, so the
gate is inert — nothing calls the RPC yet.** The full-screen overlay is the remaining
work and must not be activated until explicitly approved (see Activation risk below).

**Authoritative state — `budget_my_outstanding_obligations()`.**
SECURITY DEFINER, STABLE, **no arguments**; reads `auth.uid()` only, so it cannot be
used to probe another user. Returns zero or more rows:
`call_id, cycle_title, deadline, department_id, department_name, department_key,
draft_submission_id, is_overdue`, ordered by deadline.

Designation is derived, never hard-coded (the migration asserts the body contains no
uuid):
`open cycle -> department the cycle targets (target_department_ids, NULL = all) ->
caller is an ACTIVE head in budget_department_heads`
This reuses the same mapping that drives cycle-open notifications and first-level
approval routing, so adding or moving a head is a row change with no code change.

**Obligation satisfied** once a submission for that cycle+department moves past draft:
`pending_coo, coo_under_review, submitted, under_review, approved, rejected`.
Deliberate: `draft` does NOT release it (saving is not submitting);
`revision_requested` re-blocks (both return paths create a fresh draft, so a
resubmission is genuinely owed); `rejected` DOES release, because re-blocking on a
final rejection would leave the user with no action that could ever clear the gate.

**Hook — `src/hooks/useBudgetSubmissionGate.ts`.**
Returns `{ obligation, obligations, shouldPrompt, hasOutstanding, isSkipped,
isLoading, isError, skip, refresh }`.

Three states, mapped to two separate flags:

| State | shouldPrompt | App access | hasOutstanding (bell) |
|---|---|---|---|
| Outstanding, not skipped | true | overlay instead of children | true |
| Skipped this session | false | normal | true |
| Submitted | false | normal | false |

`shouldPrompt` drives the overlay. `hasOutstanding` drives the bell's required-action
state. **They must never be conflated** — that separation is what lets a skip hide the
prompt without clearing the bell.

**Skip is presentation-only and per-session.** It suppresses the prompt and nothing
else: the obligation stays outstanding, no submission is created, no status changes,
and `obligation` keeps being returned so the bell and deep-links still offer the path
to complete it. Held in `sessionStorage` (key `welile.budgetGate.skipped`), **never
`localStorage`** — a skip must survive route changes within the session but must not
survive into a new one, which would be a permanent "don't remind me again" bypass that
is explicitly out of scope. The skip key is `user:call_id:department_id`, so skipping
one obligation never hides another and a newly opened cycle still prompts. A
module-level in-memory mirror backs the set because `sessionStorage` throws in private
browsing and some webviews; without it a failed write would make the prompt reappear
on the next render with no way past it.

**Fails OPEN by design.** While `isLoading` or on `isError`, `shouldPrompt` is false
and the app must render normally. This is an application-wide gate: if it over-blocks,
the user has no route left to fix it. Under-blocking briefly is recoverable; locking
someone out of every page on a transient network error is not.

**Remaining UI work (Gemini).**
- Follow the established `AccountFrozenGate` pattern (mounted `App.tsx:913`, alongside
  `TwoFactorGate` and `ForceResetPasswordGate`). Do not invent a navigation
  architecture.
- Wrap children; when `shouldPrompt`, render the overlay **instead of** children. That
  alone satisfies no-dismiss, no-click-outside, no-Escape and no-sidebar-interaction
  with no key handlers or focus traps.
- Copy: "New Budget Cycle - Action Required", then `cycle_title`, `department_name`,
  `deadline`, plus a clear overdue state when `is_overdue`.
- Exactly two actions: **Complete Budget Submission** (open the budget form; resume
  `draft_submission_id` when present) and **Skip for Now** (call `skip()`).
- No X/close button. No "don't remind me again".
- Render children when `isLoading || isError`.
- Call `refresh()` after a successful submission; never add a frontend `completed` flag.
- **No emojis** in any of the copy — see [[no-emojis]].

**Activation risk.** With the current open cycle `LAST TESTING,2026` (targets 8
departments, 6 with designated heads), mounting the gate immediately blocks six senior
staff — the COO, the CTO and the four subordinate Operations heads — over a test cycle.
Open a real cycle or close that one before activating. Recovery levers are data-only
and take effect on the user's next request:
`UPDATE budget_department_heads SET active=false WHERE user_id=...` or
`UPDATE budget_calls SET status='closed' WHERE id=...`.
