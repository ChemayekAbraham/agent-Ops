# National ID FIFO — creation, linking and verification: end-to-end test

Date: 2026-09-16
Environment: RentFlow production database, **inside transactions that were rolled back**.
No real person, no real money, no persistent test row. Throwaway accounts only
(`+256777120001`–`+256777120024`, all confirmed unused first).

Test National ID used throughout: `CM90012345PE12L`, holder JOSEPH KATO, born 1990-05-04,
card 123456789, sex M.

---

## Result summary

| # | Scenario | Expected | Result |
|---|----------|----------|--------|
| 1 | A brand-new ID is registered | Tied to that one account (FIFO) | **Pass** |
| 2 | An ID already on another account is registered | Refused, and the first name of the account that holds it is shown | **Pass after fix** |
| 3 | A lookalike reading of an existing ID (O for 0) | Refused the same way | **Pass after fix** (was a real hole) |
| 4 | An ID that already carries 20 accounts | Refused with a limit message | **Pass** |
| 5 | Holder is asked, approves | Requester is linked and can submit | **Pass** |
| 6 | Holder is asked, rejects | Request closed, requester still blocked | **Pass** |
| 7 | Request left unanswered for 7 days | Expires by itself | **Pass** |
| 8 | Code cannot be approved before it is entered | Approval refused | **Pass** |
| 9 | First account inherits the name on the ID | Enforced | **Pass after fix** |
| 10 | Later accounts on the same ID keep and can edit their own name | Enforced | **Pass after fix** |
| 11 | Same name in a different word order (First+Last vs Last+First) | Detected | **Pass — new** |
| 12 | Staff confirmation of an approved link | Only Financial Ops / CFO / Super Admin, with a written reason of 10+ characters | **Pass** |

---

## What each scenario actually did

**1. New ID.** Account 1 typed the ID and its details. Saved, tied to that account alone
(`linked: false`). It became the FIFO holder of the ID.

**2. Existing ID.** Account 3 typed the same ID. Refused with:
> "This National ID is already on Joseph's Welile account. You can be added under Joseph,
> but they must agree first."

Only the holder's **first name** is revealed — never a surname, phone number or anything else.

**3. Lookalike ID.** Account 3 typed `CM9OO12345PE12L` (letter O in place of the two zeros).
Refused with the same message. Before the fix this **registered as a separate ID**, which
would have split one person's identity across two independent records. See Fix 1.

**4. Twenty-account limit.** With the holder plus 19 approved accounts on the ID, the 21st
attempt is refused:
> "This National ID has reached its limit of 20 accounts. No more accounts can be added to it."

The holder counts as one of the twenty. The 20th account is still allowed through.

**5–8. The asking journey.** Account 3 asked to join the ID. A code went to the holder's own
number — the number is resolved on the server from the holder's record, never supplied by
the person asking. The holder **cannot** approve before the code has been entered by the
requester (tested: refused). Once the code was entered and the holder pressed Approve, the
link became active and the requester could submit under it. When the holder pressed Reject
instead, the request closed as rejected and the requester remained blocked from the ID. A
request nobody answers inside 7 days expires on its own. The requester's screen re-checks
every 25 seconds, so it moves on without any refresh.

**9–10. Whose name comes from the ID.** Account 1 (the holder) had its displayed name
replaced by the name on the ID: JOSEPH KATO. Account 4, joining the same ID under an
approved link, kept its own self-entered name and is free to change it — the ID name is
already carried by the holder. Both are recorded in the audit trail.

**11. Same name, different order.** "Mata Pius" and "PIUS mata" now produce the same name
key (`MATA PIUS`), and each submission reports how many other accounts share that key. This
is a **signal for staff only** — it never blocks anybody, because genuinely different people
do share names.

**12. Staff confirmation.** Confirming an approved link requires a Financial Ops, CFO or
Super Admin account and a written reason of at least 10 characters. Tested and enforced.

---

## Text messages sent

| Moment | Message |
|--------|---------|
| A number is being confirmed as a payout number | "Welile: {name} wants to receive Welile payouts on a mobile money number ending {last4} registered in your name ({registered name}). If you agree, share this code with them: {code}. If you did NOT authorise this, ignore this message." |
| Someone asks to join an ID that is already on another account | "Welile: {name} wants to link their Welile account to your National ID {ID reference}. If you agree, share this code with them: {code}. You must also confirm it in the Welile app. If you did NOT authorise this, ignore this message." — sent to the **holder's** number, plus an in-app approval that cannot be dismissed until Approve or Reject is pressed. |
| Someone tries to use a number that already belongs to another account | **No message is sent to anybody.** The attempt is refused on the screen. This is deliberate: it avoids messaging a stranger about somebody else's attempt. |

---

## Issues found and fixed

Applied as `drizzle/migrations/0136_national_id_fifo_hardening.sql`.

**Fix 1 — lookalike IDs bypassed FIFO.** The duplicate check compared IDs character by
character, while the linking system compared them with lookalike letters folded in
(O→0, I/L→1, S→5, B→8, Z→2). A single mis-read character therefore created a second, separate
copy of the same person's ID. The duplicate check now uses the same folding on both sides, so
FIFO holds even for imperfect readings.

**Fix 2 — the holder's first name was not shown.** The refusal previously said only "Ask the
person who holds it to confirm you." It now names the holder's first name, so the person
knows who to ask, and states they can be added under that person.

**Fix 3 — name inheritance could pick the wrong account.** Inheritance was decided by which
identity record was created first. Where two records carried the same timestamp the winner was
effectively arbitrary, and a *linked* account could take the ID name. It is now decided by
ownership, not timing: only the account that holds the ID as its own can take the ID name, and
the database already guarantees there is exactly one of those. Every later account keeps its
own name.

**New — same-name detection across word order.** Added a name key that sorts the words of a
name, and a count of other accounts sharing it, reported on every submission and written to
the audit trail for staff.

---

## Notes for production testing

- Mata Pius keeps his self-entered name because the name fields read from his ID are empty;
  nothing was changed for him.
- No text message is sent when a phone number is already tied to another account. If you want
  the holder of that number to be told, say so and it can be added.
- A refusal for a lookalike ID now points at the holder of the correctly-read ID. If a genuine
  ID legitimately differs only by those characters, the person must be added through the
  approval journey — an extremely unlikely case, but worth knowing.
