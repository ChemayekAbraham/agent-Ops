# 9. Incident — "Network issue" false failures + a 10-minute lock on landlord payouts (2026-09-12)

**Severity:** P1. Agents could not pay landlords. At least 24 rent requests sat with the landlord
unpaid — some for over four months — while the tenant's repayment clock had already started.

**Status: fix designed, reviewed against production evidence, and shipped once — then silently
reverted by an automatic Lovable merge ~5 minutes later. As of this writing the fix is NOT live.**
See [§ Is the fix still live](#is-the-fix-still-live) before assuming otherwise; re-run that check,
not this sentence.

---

## The one-sentence cause

`issue-landlord-payout-otp` held the agent's phone waiting on a slow, multi-provider SMS
delivery-confirmation chain before replying, and on a flaky mobile connection that wait got the
connection dropped — which the client then reported as *"the request never reached our servers,"*
a claim that was usually false. Separately, the tenant list's Withdraw button set an unconditional
10-minute client-side lock the instant it was tapped, with no way to release it early and no
relationship to whether anything actually happened.

Neither defect is new logic added for this incident — both were designed in, on purpose, for good
reasons (delivery confirmation because Yoola's "accepted" response isn't proof the handset got the
SMS; the lock to stop a double-tap firing two SMS sends). The bug is that both were built as sync,
client-blocking mechanisms instead of server-authoritative, background ones.

---

## What people saw

Agents in the field WhatsApp group ("Welile Kyebando Kaw...") reported, independently, on different
days:

> **Mata Pius**, 2026-09-12 16:27: *"Been trying to send money to landlord. But it shows network
> issue then locks the float to wait for 10mins."*
> **Isaac Mwaka**, 2026-09-12 16:31: *"This happened to me yesterday."*

A screenshot from the same thread showed the "Pick a Tenant to Pay Their Landlord" list with a row
reading `🔒 06:15 locked` against Sowali Sebuyila, UGX 240,000 remaining.

Separately (same day, different report): tenant **Faizal Kayondo** showed in his agent's tenant list
as `PAID UP / CLEARED UGX 0`, when in fact his landlord (kayemba sharif) had never been paid — two
straight merchant-side rejections of the payout. That is a related but distinct defect, already
fixed and confirmed live in production (see
[§ Related, separate, and already fixed](#related-separate-and-already-fixed)).

---

## The trigger

Agents are on Ugandan mobile networks in the field. A request that stays open for 10-30 seconds is
routinely dropped by the carrier or the phone's browser before a response comes back. None of that
is unusual, and a payment flow has to survive it. This one did not: it turned a slow server into a
false claim of total failure, then a client-only debounce turned that false failure into a real
10-minute lockout.

---

## Cause 1 — the client waited for delivery confirmation, not just acceptance

`issue-landlord-payout-otp` (`supabase/functions/issue-landlord-payout-otp/index.ts`) did, all
inside the one HTTP request the agent's phone was holding open:

1. create the OTP challenge row,
2. send via Yoola (primary SMS gateway),
3. **poll Yoola's delivery report up to 4 times, 2.5s apart** (`confirmYoolaDelivery` in
   `supabase/functions/_shared/yoolaDeliveryConfirm.ts`) to confirm the handset — not just the
   gateway — actually got it,
4. if unconfirmed, fall back to Africa's Talking (another full send),
5. if that also fails, fall back to Twilio via the Lovable connector gateway.

Production evidence (`landlord_payout_otp_challenges` joined to `landlord_payout_otp_events`,
2026-09-12): most sends took **~9 seconds** from challenge creation to the "sent" event; one took
**15 seconds**. That is time spent server-side, after the request had already reached Welile —
the agent's phone had no way to know that.

## Cause 2 — a slow-but-honest response was reported as "never arrived"

`useLandlordOtp.ts`'s `friendlyOtpError()` mapped any fetch-level failure (timeout, dropped
connection — anything matching `failed to fetch` / `network` / `load failed`) to:

> "Network issue — the request did not reach our servers. Your code is still valid; check the
> connection and tap Verify again."

That is an assertion about server state the client cannot actually know. By the time the connection
dropped, the server had very likely already: authenticated the agent, passed eligibility, created
the OTP challenge, hashed and stored the OTP, and started (or finished) the SMS send.

## Cause 3 — the 10-minute lock fired on tap, not on outcome

`AgentLandlordFloatAllocationsDialog.tsx`'s `handleSelect()` wrote a 10-minute expiry into
`localStorage` (`WITHDRAW_LOCK_MS = 10 * 60 * 1000`) **the instant the row was tapped**, before any
network call, and regardless of what happened next. No code anywhere released it early on failure —
`grep`ing the repo for the lock's storage key turns up exactly one file. It is also purely
client/per-device, so it does not even reliably stop the double-send it exists to prevent.

Combined with Cause 1/2: tap → lock set → OTP send times out → agent sees "network issue" → agent is
now locked out of retrying **that landlord** for up to 10 minutes, even though nothing was actually
reserved server-side at that point (the Landlord Payout Float is only debited later, at Financial
Ops approval — see `landlord-payout-disburse/index.ts`).

## Cause 4 — no server-side signal for "an OTP is already outstanding"

Between "challenge created + SMS sent" and "landlord enters the code," there is **no**
`landlord_payouts` row yet — one is only created on successful verification
(`verify-landlord-payout-otp`). `useLandlordFloatAllocations.ts`'s `inflight_payout` detection only
looked at `landlord_payouts`, so a pending, unverified OTP made the allocation look completely
untouched. The 10-minute `localStorage` lock (Cause 3) existed specifically to paper over this gap —
it was covering for a missing piece of server state, not enforcing a real business rule.

## Production evidence tying this together

**Mata Pius → Sowali Sebuyila → landlord Juliet Namudu, UGX 240,000** had OTP challenges at
approximately:

| Time (EAT) | Status |
|---|---|
| 16:34:17 | pending |
| 16:44:19 | pending |
| 16:54:48 | verified |

Almost exactly 10 minutes apart — consistent with: attempt → "network issue" → locked out for
10 minutes → attempt again → same thing → eventual success on the third try. This was not
theoretical; it is the recorded pattern for the exact agent who reported the bug.

A wider sweep found **24 rent requests** (not counting Faizal Kayondo, fixed separately) currently
funded/repaying with an **open landlord-float allocation, `paid_out_amount = 0`, and zero tenant
repayment** — several with **zero landlord-payout attempts ever made**, `repayment_starts_on` as far
back as **2026-05-16**. Full list is in this session's transcript; it needs a human pass (chase the
agent, or escalate to CFO), not an automated bulk action — some of these may be older cases with a
different cause entirely.

---

## The solution (as designed — see status above)

1. **`issue-landlord-payout-otp`**: create/update the OTP challenge, then respond immediately with
   `{success, challenge_id, expires_at, delivery_status: "pending"}`. The SMS send + Yoola delivery
   poll + Africa's Talking/Twilio fallback chain (unchanged internally) runs *after* the response,
   via `EdgeRuntime.waitUntil()` — the same pattern already used in `sms-otp/index.ts`. Also made
   challenge creation **idempotent** per agent+landlord+rent_request: a retry while a live challenge
   already exists returns that same challenge instead of minting a second one (this alone would have
   collapsed Mata Pius's three separate challenge rows into one).
2. **`useLandlordOtp.ts`**: on a transport-level failure, **reconcile with the server** — query
   `landlord_payout_otp_challenges` (RLS-scoped to the calling agent) for a live challenge matching
   the landlord/rent request before declaring failure, and adopt it if found. Only when reconciliation
   genuinely finds nothing does it say the request wasn't created — and even then, without the old
   overconfident "did not reach our servers" wording.
3. **`useLandlordFloatAllocations.ts`**: a live, unexpired OTP challenge now counts as "in flight"
   (new synthetic `otp_pending` status), not just a `landlord_payouts` row — closing Cause 4.
4. **`AgentLandlordFloatAllocationsDialog.tsx`**: the `localStorage` 10-minute lock is deleted
   outright. Whether a row is tappable is decided entirely by the server-authoritative signal from
   (3) — no client timer, no arbitrary duration.

Provider hierarchy (Yoola → Africa's Talking → Twilio) and single-OTP-across-providers behaviour are
unchanged; this is a response-timing fix, not a change to how OTPs are sent or verified.

Full diff: commit `01fb22f02` ("Stop the landlord-payout OTP flow from blocking on SMS delivery
confirmation") on `origin/lovable`, pushed 2026-09-12 17:19 EAT.

---

## Why it didn't stay fixed

`01fb22f02` was pushed, merged cleanly with the then-current `origin/lovable` tip (`ea173f703`) as
`9313cc6c8`, and verified in the working tree immediately after — the fix was confirmed present.

Five minutes later, Lovable's bot produced merge commit `13aeeb4b7` ("Added location autocomplete")
with parents `ea173f703` and a second branch `9e4d6e1da` — **neither of which has `01fb22f02` as an
ancestor**. Lovable's own edit session had a checkout in flight from before my push landed, and its
next auto-commit merged from that stale base instead of from the pushed tip. The merge result quietly
carried the pre-fix version of all five touched files back into history. `01fb22f02` is still an
ancestor of the current tip (nothing was force-pushed), but its content lost every three-way merge
resolution after that point because the diverging line never had it to begin with.

**Net effect: a same-repo race between a manual push and Lovable's own auto-commit cycle can silently
resurrect reverted bugs, with no error, no conflict, and no notification.** This is a variant of
[[project_lovable_live_file_sync_bypasses_git]] and the checkpoint-revert risk noted in
[[project_lovable_rebrand_sync_pipeline]], but distinct from both: no one clicked "restore a
checkpoint" — ordinary auto-commits did it on their own via merge topology.

---

## Is the fix still live

**Repo, as of 2026-09-12 ~17:30 EAT: NO.** All five files are back to pre-fix content:

```bash
grep -c "dispatchOtpInBackground" supabase/functions/issue-landlord-payout-otp/index.ts   # 0 = reverted
grep -c "reconcilePayoutChallenge" src/hooks/useLandlordOtp.ts                            # 0 = reverted
grep -c "otp_pending" src/hooks/useLandlordFloatAllocations.ts                            # 0 = reverted
grep -c "WITHDRAW_LOCK_MS" src/components/agent/AgentLandlordFloatAllocationsDialog.tsx   # 2 = reverted (0 = fixed)
```

Re-run these before trusting this document. If all read as "reverted," the fix needs to be
re-applied — check whether `01fb22f02` is still reachable (`git log --oneline --all | grep 01fb22f02`)
and either cherry-pick it fresh onto the current tip or redo the edits, then push and **re-verify
the grep immediately after**, watching for another concurrent Lovable commit landing in the same
window.

Live-behaviour check (does not depend on git state — confirms what's actually deployed): have an
agent tap Withdraw on a real allocation and time it. Old code: 5-20+ seconds before the OTP screen
appears. Fixed code: under ~2 seconds; the SMS send finishes in the background regardless.

```sql
-- Sanity check only — this does NOT distinguish sync vs background dispatch,
-- since both record the same events, just at different points relative to
-- the client's response. Use the live-behaviour check above for that.
select c.id, c.created_at as challenge_created, e.created_at as sent_at,
       extract(epoch from (e.created_at - c.created_at)) as seconds
from landlord_payout_otp_challenges c
join landlord_payout_otp_events e on e.challenge_id = c.id and e.event_type in ('sent','resent')
order by c.created_at desc limit 10;
```

---

## Related, separate, and already fixed

Found while investigating Faizal Kayondo's case: `v_rent_plan_schedule` (drives the nightly
daily-bill pin) and `get_agent_tenants_overview` (the agent's tenant-list "OWING" figure) never
checked landlord disbursement evidence — a tenant could show `funded`/`repaying` and start accruing
a daily bill even though the landlord had never been paid. Confirmed still live in production
(unaffected by the revert above, because it was applied directly to Postgres, not through the
git/Lovable deploy pipeline):

```sql
select position('unfunded_balance' in pg_get_functiondef(
  'public.get_agent_tenants_overview(timestamptz)'::regprocedure)) > 0 as has_fix; -- expect true
select position('landlord_evidence' in pg_get_viewdef(
  'public.v_rent_plan_schedule'::regclass)) > 0 as has_fix; -- expect true
```

Migrations: `20260912150000_gate_repayment_schedule_on_landlord_evidence.sql`,
`20260912160000_expose_unfunded_balance_on_tenant_overview.sql`.

---

## Still broken / not yet actioned

| # | Problem | Evidence |
|---|---|---|
| 1 | **The OTP-timeout fix itself is reverted** (this incident's main subject). | § Is the fix still live |
| 2 | **24 rent requests** have an open, unpaid landlord-float allocation and zero repayment, several with zero payout attempts ever made, oldest from 2026-05-16. Not bulk-remediated — needs a human pass per row. | listed in this session's transcript, not yet exported to a table |
| 3 | The three-provider SMS fallback chain (Yoola → Africa's Talking → Twilio) still has no per-call timeout on the outbound `fetch()`s — a genuinely hung provider can still stall the *background* task indefinitely. Backgrounding it stopped it from blocking the agent, but not from potentially delaying delivery confirmation forever. Not addressed in this fix. | `sendYoolaSms` / `sendSms` / `sendTwilioSms` in `issue-landlord-payout-otp/index.ts` |

---

## What not to do

- **Do not diagnose a slow-provider timeout as "the agent's network."** Check
  `landlord_payout_otp_challenges` → `landlord_payout_otp_events` timing before asking the agent
  anything — the server may have already succeeded.
- **Do not re-apply this fix and walk away without re-checking the grep a few minutes later.** The
  revert mechanism here is a race with Lovable's own auto-commit cycle, not a one-time fluke — it can
  happen again on the next push if Lovable's sandbox has an edit in flight at the same moment.
- **Do not treat `01fb22f02` being in `git log` as proof the fix is active.** An ancestor commit
  existing proves nothing about the current tree's content once merges are involved — read the files
  (or better, the grep block above), not the log.
- **Do not bulk-pause or bulk-resolve the 24 stale allocations in § Still broken #2.** Some may have
  perfectly good explanations this investigation didn't check (paid through a channel outside
  `agent_landlord_float_allocations`, for instance). Each needs a look before acting.
