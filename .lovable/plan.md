# Fix "Could not submit" on the budget form

## What is confirmed so far

- The budget cycle **5-day Budeget Cycle-september 2026** is open (deadline 11 Sep), and all
  8 designated heads currently pass the server-side filing check.
- Four budgets were filed successfully today (Agent Ops, Tenant Ops, Engineering & Product,
  Interns), so the server path itself works.
- The form's failure message is a **dead end**: when the server refuses a submission, the
  form throws the server's reply, which is not a standard error object, so the screen always
  falls back to the words "Could not submit" and the real reason (for example
  "You can only budget for a department you are registered in", "Only draft budgets can be
  submitted", or "Budget cycle is not open") is thrown away and never shown.

So the visible symptom is one bug (no reason shown) hiding another (whatever the server is
actually refusing for this user). Both get handled.

## What will be done

1. **Show the real reason.** Make the submit failure display the server's own message,
   including the extra detail and hint the server sends. If the server sends nothing at all,
   show a clear "the server refused without a reason — please report this" line instead of a
   bare "Could not submit". Log the full reply to the browser console so a failure can be
   traced.
2. **Stop silent attachment failures.** Attaching supporting documents currently ignores its
   own failures; surface them instead of losing them.
3. **Reproduce it live.** Sign in as one of the five heads who have not filed yet
   (Human Resources, Landlord Ops, Marketing, Operations, Partner Ops), fill the form in
   completely, press Submit, and read the now-visible reason.
4. **Fix the named cause.** Based on step 3, apply the smallest correction that lets the head
   through — most likely how the form resolves which department the budget is filed under.
   If (and only if) the cause turns out to be a server rule that wrongly blocks a designated
   head, I will come back for approval before touching any database rule.

## Out of scope / unchanged

- No changes to budget amounts, totals, approval routing, the COO/CFO stages, statuses,
  notifications, access rules, wallets, or the ledger.
- No submissions deleted — budgets are never removed. Existing test budgets stay in the
  review queue for the CFO to reject.
- No database, policy, or security-finding changes unless step 4 proves one is required and
  you approve it.

## Technical notes

- `src/components/budget/DepartmentBudgetSubmission.tsx` — `submit()` catch block:
  `e instanceof Error` is false for a Supabase `PostgrestError`, so every RPC rejection
  collapses to the generic string. Replace with a helper that reads `message`/`details`/`hint`
  off the rejection.
- `src/hooks/useDepartmentBudgets.ts` — `registerBudgetDocuments()` discards the insert error.
- Server rules verified read-only: `budget_save_draft`, `budget_submit_submission`,
  `can_access_budget_submission`, `budget_can_file_for_department`; EXECUTE grants to
  `authenticated` are present on all budget RPCs, so this is not a permissions gap.

## Report back

The exact server reason that was blocking submission, the fix applied, and a live confirmed
submission from one of the five heads who had not yet filed (reference and status).
