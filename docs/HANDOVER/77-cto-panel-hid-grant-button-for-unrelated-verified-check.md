# 77 — CTO panel hid the "Grant exception" button whenever an unrelated check happened to pass

**Fixed in code 2026-09-18, not yet deployed (frontend). Read this before touching
`CTOKycLevelPanel.tsx`'s `idVerified`/`hasActiveException`/Grant-form visibility again.**

## What was reported

Josh, trying to grant Lukodda Joseph (`b4d7c324-1f7e-4e1c-91a8-3f0e10e0b25c`, +256751424629) the
same ID-verification exception given to Claire/Mark/Carolyne: "that field is not open, since it
shows verified yes."

## What was found

`CTOKycLevelPanel.tsx` wrapped the entire Grant textarea + button in `{!idVerified && (...)}`.
`idVerified` is `withdrawal_user_id_verified()` — the merchant-claim gate, already established in
docs 74/75/76 as a check that returns `true` for reasons that have nothing to do with an actual
`id_verification_exceptions` row (here: `user_is_funder_with_portfolio`). Confirmed live: he has
**zero** rows in `id_verification_exceptions`, yet the panel showed "Verified for withdrawal: Yes"
and, because of that, hid the only control that could create one. The CTO could see the badge, but
had no way to act on the fact that it was wrong — the Grant form simply didn't render.

This is the fourth thing today that treated `withdrawal_user_id_verified`'s narrower/wider result as
interchangeable with "has an id_verification_exceptions row" or "is exempt from the self-withdraw
gate" (docs 74 wrong-function, 75 gate-not-wired, 76 dialog-not-wired, now this — a control
hidden entirely based on the wrong signal).

## What was fixed

`src/components/cto/CTOKycLevelPanel.tsx` — added `hasActiveException`, derived from the
`exceptionHistory` query already fetched for this same panel (`(exceptionHistory ?? []).some(h =>
!h.revoked_at)` — the DB enforces at most one unrevoked row per user via a partial unique index, so
`.some` is exact, not just a first-match heuristic). Changed the Grant form's guard from `!idVerified`
to `!hasActiveException`. The "Verified for withdrawal: Yes/No" label itself is untouched — it's
still `idVerified`-driven and still potentially confusing (flagged earlier this session, not yet
addressed) — but it can no longer block the one action that actually matters.

Not yet deployed (frontend-only change, same as doc 76).

## What not to do

- Don't gate the Grant control on any read of `withdrawal_user_id_verified`,
  `user_is_pure_partner`, `is_partner_not_agent`, or `user_is_funder_with_portfolio` — none of them
  answer "does this specific user have an active `id_verification_exceptions` row," which is the
  only thing that determines whether granting one makes sense (the RPC itself already refuses a
  second grant while one is active, so this is a UX nicety, not a safety gate the frontend needs to
  duplicate correctly).
- The "Verified for withdrawal" label question from earlier this session (whether to relabel it or
  add a second, accurate self-withdraw-status indicator) is still open — this fix only unblocks the
  Grant button, it doesn't address the label's own confusion.
