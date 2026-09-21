# 94 — Merchant agent's claimed payout survives a mobile browser discarding the page (MoMo app-switch)

**Fixed in code 2026-09-21, not yet deployed to the live preview. Before touching the
`myActiveClaims` query, `showClaimNow`, or the realtime claim-close handler in
`AgentCashPayoutsTab.tsx` again, or `merchantClaim.ts`'s cache helpers.**

## What was reported

Apophia (merchant/cashout agent): she claims a withdrawal, copies the customer's MoMo number,
switches to the MoMo app to pay, then comes back to the Welile app to confirm — and the payout's
details (number, code, amount) have disappeared. Asked to stop the dashboard from "reloading" when
she returns.

## Root cause

Not a server-side claim release — `release_stale_cashout_claims()` genuinely waits 45 minutes with
zero settlement progress (verified live, matches its own comment, cron runs every 5 minutes), far
longer than a quick MoMo trip. The claim is still hers the whole time.

It's a mobile browser tab-lifecycle issue this codebase has already fought once before, for the
exact same trigger (switching to another app and back) but for a different piece of state: doc
54/67's "Reload-proof proof state" comment in `WithdrawalPayoutCard.tsx` documents that opening the
camera/gallery "frequently makes the browser discard and re-create the page" — the same thing
happens switching to the MoMo app. When that happens, the whole React Query cache is wiped and
rebuilt from an empty `QueryClient`. The "Claimed by you" card (`AgentCashPayoutsTab.tsx`) depends
on a three-step identity cascade — `user` → `is-cashout-agent` (desk id) → `cashout-my-active-claims`
(keyed by that desk id) — that has to complete a fresh round trip before the claimed card can render
again. On a good connection that's under a second and invisible; on a merchant's rural mobile
connection it can stretch long enough to read as "gone", and on a bad enough connection or a timing
hiccup it can look permanent.

The proof-file half of this exact problem was already solved (`proofStorageKey` +
`localStorage`-based recovery, `WithdrawalPayoutCard.tsx` lines ~107-165) — the claimed-item list
itself never got the same treatment.

## Fix

Extended the existing pattern (not invented new): a small `localStorage`-backed display cache for
the "Claimed by you" list, added to `src/lib/merchantClaim.ts` (the existing home for this file's
claim-cache pure functions, unit-tested like its neighbors) —
`readCachedActiveClaims`/`persistActiveClaims`/`activeClaimsStorageKey`, keyed per user id, with a
6-hour max age (comfortably past the 45-minute auto-release window) so a genuinely stale entry never
lingers indefinitely.

In `AgentCashPayoutsTab.tsx`:
- `myActiveClaims` is now `liveActiveClaims ?? cachedActiveClaims` — the live query's own result
  wins the instant it resolves (including a real, live `[]` when there is genuinely no claim), the
  local cache only fills the gap while the live query has never resolved yet.
- The cache is written on every successful live fetch, immediately on a fresh claim
  (`showClaimNow`, so a brand-new claim is protected before the next background poll would have
  written it), and cleared/updated the moment the realtime subscription sees the claim close
  (completed/reassigned) — so a finished payout can't reappear as a "ghost" on a later reload.

**Why this is safe:** purely a display cache. Every real action — Confirm, Reject, a fresh claim —
still calls the same server RPC it always did, which is the only source of truth regardless of what
this cache shows. Worst case if the cache is ever wrong, the merchant sees a claim a few seconds
longer than reality and the confirm action fails cleanly with a server-validated error; it can never
cause a double-payment or a wrong confirmation to succeed.

**Deliberately not done:** could not actually prevent the browser from discarding the page — that's
an OS/browser memory-management decision, not something a web page can veto. This makes the
*symptom* (details vanish) go away without controlling the underlying cause.

## Verified

`npx vitest run src/lib/__tests__/merchantClaim.test.ts` — 34/34 passing, including 7 new cases for
the cache helpers (round-trip, per-user scoping, clearing on empty, missing-user-id safety,
corrupted-JSON safety, max-age eviction, and staying within max-age). `npm run guard:all` — all 7
guards pass, including `guard-frontend-ledger-writes` (this change touches no ledger/wallet writes,
read/cache-only). Full `tsc` could not be run locally (known OOM, see
[[project_tsc_cannot_complete_locally]]) — reviewed the diff by hand for type correctness instead;
`eslint` shows only this file's pre-existing, pervasive `no-explicit-any` style, no new errors.

## What not to do

- Don't let this cache become anything other than a display fallback — no mutation, claim action,
  or gate should ever read from it directly instead of the live query/server.
- Don't remove the 6-hour max-age check — without it a merchant who abandons the app for a day could
  see a long-stale "ghost" claim on their next visit.
- Don't assume this fixes every case of an actually-released claim looking wrong — if the server
  genuinely released it (45+ minutes with zero settlement progress), the live query will correctly
  return `[]` and override the cache; that's working as intended, not a bug.
