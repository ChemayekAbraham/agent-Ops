# 44 — 2026-09-16: `payout_withdrawal_block_reasons` needed the locked number, not a timestamp guess

**Live as of 2026-09-16 — confirmed by re-querying both affected accounts.** Read this before
touching `payout_withdrawal_block_reasons` again — it has now been fixed three times in one day
(docs 38, 43, 44); this doc supersedes both.

## Why doc 43's reapply still wasn't enough

Doc 38 fixed the block-reasons RPC to pick the most-recently-updated mobile_money destination
instead of always preferring a rejected one. Doc 43 reapplied that fix after it got silently
reverted. Both were verified against **Grace Paul Ochieng**'s account and both times looked fixed.

**Kirunda Ivan** (`36b19095-b437-4b4f-afa5-18ca6f9ea6d2`, momo `0756404789`) exposed the real gap.
Re-checking his account live after doc 43's migration ran: still `blocked: true`, still citing an
unrelated rejected number ("matiya waiswa"). Root cause: `profiles`' trigger
`stamp_payout_destination_id_submitted_at()` fires on any National ID edit and runs

```sql
UPDATE payout_destination_verifications
SET national_id_submitted_at = now(), ...
WHERE user_id = NEW.id;
```

with no `destination_key`/`id` filter — it touches **every** destination row the user has ever had
in one statement, and `trg_touch_payout_dest` stamps all of them with the identical `updated_at`.
Kirunda has 9 old rejected destinations under other people's names sitting next to his one real,
verified number (look like leftover synthetic/test rows, not things he actually submitted — not
investigated further, doesn't block this fix). Every time he touches his National ID, all 10 rows'
`updated_at` re-tie, and `ORDER BY updated_at DESC LIMIT 1` with no tiebreaker returns whichever the
planner happens to return first — confirmed to land on a rejected row twice in a row (13:33 and
again at 13:56, after a second ID resubmission re-triggered the mass touch). **Recency was never a
reliable signal for this table and can't be made one without touching the mass-touch trigger** — a
bigger, riskier change, out of scope here.

## The actual fix

Stop inferring "the user's current destination" from timestamps at all.
`user_identity_bindings.locked_payout_number` already **is** the authoritative answer — it's set
once per user and immutable outside the Financial-Ops-approved number-change flow
(`identity_binding_immutable_guard`). When a binding exists, match the destination row by that
locked number (same last-9-digit normalization used everywhere else in this area) instead of by
recency; only fall back to "most recent" for the pre-binding case, which the function already
handles separately via its `identity_not_submitted` branch.

Verified directly against both affected accounts before writing the fix into the function:

```sql
select b.user_id, d.id as dest_id, d.momo_number, d.status
from user_identity_bindings b
join payout_destination_verifications d
  on d.user_id = b.user_id and d.destination_type = 'mobile_money'
 and right(regexp_replace(coalesce(d.momo_number,''), '\D','','g'), 9)
   = right(regexp_replace(coalesce(b.locked_payout_number,''), '\D','','g'), 9)
where b.user_id in ('36b19095-...' /* Kirunda */, '99890a2e-...' /* Grace */);
-- both correctly resolve to their VERIFIED row, ignoring the tied/rejected ones entirely.
```

## Confirmed live

Re-ran `payout_withdrawal_block_reasons` against production for both accounts after the migration
was applied:

```
kirunda: {"blocked": false, "code": "ok", "status": "verified", "reasons": []}
grace:   {"blocked": false, "code": "ok", "status": "verified", "reasons": []}
```

Both can withdraw.

## Not done

- Did not touch `stamp_payout_destination_id_submitted_at()` itself — scoping every historical
  destination row to the newly-submitted National ID name on every edit may be intentional (keeps
  old rows' name-match scores current), but it's the reason recency-based approaches keep failing
  here. Worth a second look if this pattern bites a third function.
- Same open item as doc 43: `payout_withdrawal_block_reasons` is a good candidate for the
  `critical_function_baselines` drift watchlist (doc 17) given three same-day changes.
