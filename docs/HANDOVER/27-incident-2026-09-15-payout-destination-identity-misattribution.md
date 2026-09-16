# 27. Payout destinations locked to the wrong person's identity (2026-09-15)

**Severity:** P1. Confirmed live money-misdirection risk — not yet materialised into an
actual wrong payout, but the mechanism that would cause one was live in production for
hours, and the deeper root cause is **still unfixed** as this is written.
**Read this before touching:** `ensure_payout_destination`, `complete_identity_binding`,
`resolve_withdrawal_destination`, `user_identity_bindings`, or before running the
`drizzle/migrations/0118` backfill pattern again for anything.

---

## What triggered this

Merchant agent Nattu Sharifah (0781515171) reported, via screenshot: *"During verification I
verified with my ID and my number, but I'm seeing landlord's name and number which don't
belong to me — in the system they made a mistake and linked landlord's number to my
account."* Two distinct bugs were found investigating this, one fixed and confirmed live,
one found but **not** fixed.

---

## Bug 1 (fixed, live): harmless name reordering forced a verified destination back to "waiting"

Before the identity-binding work below, Sharifah's own destination
(`momo:781515171`, "sharifah Nattu") had been previously verified, then bounced back to
`status='waiting'` with reason *"Account name changed after verification — needs
re-verification."* Yet `payout_name_match_report('NATTU SHARIFAH', 'sharifah Nattu')` scores
a perfect **1.00** — the algorithm considers these the same identity (order/case-independent
token match). The re-verification trigger inside `ensure_payout_destination()` used a raw
`lower(old_submitted_name) <> lower(new_submitted_name)` string comparison instead — which
cannot tell "same name, re-entered differently" from "a genuinely different person now shows
up here," and reopened on the former just as readily as the latter.

**Fix:** `20260915160000_fix_name_reverify_false_positive.sql` — the re-open condition now
uses whether the newly-submitted name still matches the **National ID / profile name**
(`payout_name_match_report`, the same score already computed for `name_match_score`) instead
of whether the literal string changed since the last submission. Includes a one-time,
tightly-scoped repair (`WHERE decision_reason = <exact stale string> AND name_match_score =
1`) that restored the one row this had already hit. **Confirmed live** — Sharifah's
`momo:781515171` row now reads `status = 'verified'`, `decision_reason = "Auto-verified:
re-checked after the name re-verification bug fix..."`.

---

## Bug 2 (found, NOT fixed): the identity-binding backfill locked 10 accounts to a stranger's payout account — and the underlying selection logic can still do this to anyone with multiple destinations

### What happened

A same-day, unrelated identity-verification initiative
(`drizzle/migrations/0118_identity_binding_locked_withdrawal_number.sql` — see
`docs/national-id-identity-work-report.md` for that initiative's own scope) introduced
`user_identity_bindings`: capture a user's National ID once, permanently lock their
withdrawal number to it, and make `resolve_withdrawal_destination()` — the function
`submit_withdrawal_request()` uses to decide where money actually goes — read from that
lock **in preference to whatever the withdrawer types**. `locked_payout_number` is immutable
by trigger once set (`identity_binding_immutable_guard`).

Migration 0118 shipped with a one-time backfill for every profile that already had complete
ID + photo data, picking one `payout_destination_verifications` row per user via:

```sql
ORDER BY (status = 'verified') DESC,
         (ownership_code_confirmed_at IS NOT NULL) DESC,
         created_at ASC
LIMIT 1
```

Many users have multiple destination rows sharing an **identical** `created_at` timestamp
(from an earlier, unrelated bulk operation) — Postgres does not guarantee a stable order
without a unique tiebreaker, so the final `created_at ASC` clause was, for these users,
effectively a coin flip. Sharifah's own verified destination (`created_at` tied with the
landlord's) lost the flip; the backfill locked her identity to landlord "Luvumba sowedi"'s
number instead.

**Confirmed live, 2026-09-15, before any fix:** 31 identities were backfilled
(`capture_source = 'backfill_2026_09_15'`); **10 of the 31 scored 0.00** on
`payout_name_match_report(full_legal_name, locked_payout_name)` — a complete, unambiguous
mismatch, each locked to a real but entirely unrelated person's mobile money account.

| Full legal name | Wrongly locked to | Locked number |
|---|---|---|
| kamulinde cosea Enoch | Namwezi Esther | 0755952210 |
| Isaacs Mwaka | Christine Kalembe Mwanja | 0780328655 |
| ISA KATO | Shanitah Nakalyango | 256761545243 |
| NATTU SHARIFAH | Luvumba sowedi | 0781455293 |
| WAKATO ALI | Nankwanga Sumaiya | 0751059413 |
| BUKOMA PETER | nakalimo Joyce | 0765659593 |
| Nyanzi Lydia Eseri | watsala Enock | 256750223152 |
| Mata Pius | Rose Wabule | 0701069344 |
| Nabateregga Brenda Nakalema | Namutebi Hamida | 0731252844 |
| yaseen kc💎 | Nalumansi Harriet | 0708453697 |

Checked every one of the 10 for withdrawal activity since the bad backfill ran
(2026-09-15 17:10:28 UTC): **none had submitted a genuine self-withdrawal under the wrong
lock** — one (Sharifah) had a pending "Landlord float payout" to a *third* number entirely,
unrelated (an agent paying a landlord from float, not a self-withdrawal, so the lock override
doesn't apply to it). No money was actually misdirected. The risk was live for all 10 for
roughly 4–5 hours regardless.

### First fix pass (applied directly to production, `20260915170000`)

Revoked (`status='revoked'`) and nulled `locked_payout_number`/`locked_payout_name`/
`locked_payout_provider` on exactly the 10 score-0.00 bindings — nothing with any partial
match was touched. `locked_payout_number` is immutable-by-trigger except when `OLD.status`
is already `'revoked'`, so this needed two separate `UPDATE` statements (flip status first,
null the fields in a second statement against the now-revoked row). Verified:
`resolve_withdrawal_destination('cc3bacad-...')` (Sharifah) now returns **no rows** —
correctly falls through to "no destination resolvable," which blocks a withdrawal outright
rather than silently paying a stranger.

### This is not fully fixed — 2 of the 10 got a fresh wrong lock within hours

Re-checked a few hours after the revoke: **8 of 10 remain correctly revoked and empty.**
**2 of 10 (Mata Pius, "yaseen kc💎") already have a brand-new `user_identity_bindings` row**,
re-created automatically (`complete_identity_binding()` runs `ON CONFLICT (user_id) DO
UPDATE`, so revoking doesn't block a fresh capture) — and **the new lock is wrong again**:

- Mata Pius → locked to "Rose Wabule" (0776368807)
- yaseen kc💎 → locked to "ssebunya yasin" (0747232577)

Investigated why: both accounts hold **20+ and 9 `payout_destination_verifications` rows
respectively**, for dozens of different real people's mobile money numbers — this is normal
for an account that processes payments *on behalf of* many landlords/tenants (proxy/partner-
style activity), not a personal identity with one number. Neither is a registered merchant
desk (no `cashout_agents` row).

`complete_identity_binding()`'s own selection query — independent of the backfill's
tiebreak bug — is:

```sql
SELECT d.momo_number, ..., d.provider
FROM public.payout_destination_verifications d
WHERE d.user_id = v_uid
  AND d.destination_type = 'mobile_money'
  AND d.ownership_code_confirmed_at IS NOT NULL
  AND coalesce(d.momo_number, '') <> ''
ORDER BY d.ownership_code_confirmed_at ASC
LIMIT 1
```

This has **no concept of "which of these destinations is actually mine"** — it picks
whichever destination *anyone* most recently proved SMS ownership of, including a
destination the account holder confirmed on behalf of a third party (a landlord, a tenant)
through the entirely separate "borrowed identity" consent flow
(`docs/HANDOVER/25-borrowed-identity-payout-consent.md`). For an account with exactly one
destination this is harmless. For an account managing many third-party destinations — which
is a normal, legitimate usage pattern on this platform — it is a live vulnerability: **every
time identity capture re-runs for such an account, it can lock onto a random transaction
counterparty's number instead of the account holder's own.**

### What is NOT fixed

- `complete_identity_binding()`'s destination-selection query has no signal for "this
  destination belongs to the account holder" versus "this account holder proved someone
  else's ownership for them." Needs one before this is safe for any multi-destination
  account (proxies, partners, agents who process third-party payments).
- Mata Pius's and "yaseen kc"'s accounts are, right now, locked to the wrong number again.
  They were not re-revoked — doing so without first fixing the selection logic would just
  reproduce the same failure on the next capture attempt.
- The other 8 of the original 10 are safely empty (no destination resolves, withdrawal
  blocked) but still need their **own** identity correctly re-captured — nobody has done
  this for them yet.
- Whether any *other* accounts beyond these two share the "many legitimate third-party
  destinations" shape was not surveyed. A reasonable next step: find every
  `user_identity_bindings` row (any `capture_source`, not just the 09-15 backfill) where the
  owning account has more than, say, 3 `payout_destination_verifications` rows, and check
  each for a name-match sanity failure the same way this investigation did.

### Verification queries

```sql
-- Any currently-active binding whose locked name doesn't match the account holder's own name:
SELECT b.user_id, b.full_legal_name, b.locked_payout_name,
       (payout_name_match_report(b.full_legal_name, b.locked_payout_name)->>'score')::numeric AS score
FROM user_identity_bindings b
WHERE b.status <> 'revoked' AND b.locked_payout_number IS NOT NULL
  AND (payout_name_match_report(b.full_legal_name, b.locked_payout_name)->>'score')::numeric < 0.5;

-- Confirm the name-reverify fix is live:
SELECT pg_get_functiondef('public.ensure_payout_destination(uuid,text,text,text,text,text,text,text)'::regprocedure)
  LIKE '%v_still_matches%';
```

---

## What not to do

- Do not re-run anything shaped like `drizzle/migrations/0118`'s backfill `ORDER BY ...
  created_at ASC LIMIT 1` pattern against any table where rows can share a timestamp.
  Duplicate `created_at` values exist in `payout_destination_verifications` for reasons
  unrelated to this incident (see the mid-September merge history) and will keep being a
  live footgun for any future "pick one row per user" query until deduped or given a proper
  unique tiebreaker.
- Do not revoke Mata Pius's or "yaseen kc"'s bindings again without first fixing
  `complete_identity_binding()`'s selection query — it will just pick another wrong
  destination out of the same pool.
- Do not assume "0 rows from `resolve_withdrawal_destination`" is a bad state to alert on —
  for these accounts right now, it is the *safe* state (blocks withdrawal) compared to the
  alternative (pays a stranger).
