# 35 — `payouts_ui_enabled` freeze doesn't cover the claim/settle path

**Read this before touching `claim_withdrawal_verified`, `enforce_payouts_ui_flag_on_withdrawals`,
or before trusting the CTO Platform Controls "Enable Claim & Withdraw buttons" toggle as a
complete freeze.**

## What was found

Josh reported "although withdrawals are disabled some users are still able to withdraw"
after `payouts_ui_enabled` was flipped off at **2026-09-16 07:14:53 UTC** (as part of the
same-morning response to the agent float-allocation exploit, doc 32/34). Verified live:
the freeze has always had a narrower scope than the toggle's own description implies.

`enforce_payouts_ui_flag_on_withdrawals()` is a `BEFORE INSERT` trigger on
`withdrawal_requests` — it only stops **new** withdrawal requests from being created. It
says nothing about `claim_withdrawal_verified()`, the RPC a Merchant Agent calls to pick
up and pay out a request that **already exists** in the queue. That function checks ID
verification, float reservations, priority holds, MoMo number/name matches — everything
except the freeze flag.

Result, measured against production after the freeze went on:

- **7 ordinary (non-landlord, non-proxy) withdrawal requests that were already queued
  before the freeze got claimed, and 8 got processed — UGX 2,168,786** — paid out while
  the toggle read "frozen." (The 8th was claimed 2 minutes *before* the freeze but
  finished processing 10 minutes after; see "What was deliberately left alone.")
- **7 more (UGX 198,600) were still sitting claimable, unclaimed**, at the time this was
  found — i.e. this was still actively exploitable, not just historical.
- Separately (not a bug, confirmed intentional with Josh): landlord and proxy-partner
  payouts are hard-exempted from the freeze in the trigger itself
  (`IF NEW.landlord_payout_id IS NOT NULL OR NEW.proxy_partner_id IS NOT NULL THEN RETURN
  NEW`) — **16 new landlord withdrawal requests were created, 22 claimed, 22 processed,
  UGX 5,400,000** after the freeze. Left as-is per Josh's explicit call — landlord rent
  proceeds and proxy-partner payouts are treated as always-essential, not part of what a
  general payout freeze is meant to stop.

## What was fixed

`20260916140000_enforce_payouts_ui_flag_on_claims.sql` adds the identical check to
`claim_withdrawal_verified()`, right after the row lock and not-found check (before the
ID-verification gate, and before the "already owned by you" idempotent-success branch —
so it also stops a merchant from *continuing* a claim they started before the freeze went
on, not just starting a new one). Same exemption as the INSERT trigger: `landlord_payout_id
IS NULL AND proxy_partner_id IS NULL` is required for the block to apply, so landlord/proxy
claims are unaffected, matching Josh's decision above.

## What was deliberately left alone

- The one row claimed 2 minutes before the freeze but processed 10 minutes after it
  (`6b984281-a8b6-49ca-84b3-a7af27aab1bc`, UGX 1,650,000) was not retroactively touched,
  and no guard was added to whatever finalizes an *already-claimed* row (e.g.
  `finalize_withdrawal_from_matched_payout_sms`, `sync_withdrawal_on_payout_paid`) — a
  merchant who already claimed a row before the freeze may have already physically handed
  over cash in real life; blocking the app-side confirmation after the fact would strand
  that transaction in a worse state, not a safer one. This fix closes the "new claims
  during a freeze" gap, which was the actual reported and measured leak; it does not
  attempt to freeze mid-flight claims that predate the toggle flip.
- The landlord/proxy exemption itself — confirmed intentional, left untouched.

## Verify this is still fixed

```sql
-- Should return the current function def with the payouts_ui_enabled check present.
select pg_get_functiondef('public.claim_withdrawal_verified(uuid,text,text)'::regprocedure);

-- Should be zero for any ordinary withdrawal claimed while the flag was off, going forward.
select count(*) from public.withdrawal_requests
where landlord_payout_id is null and proxy_partner_id is null
  and dispatch_claimed_at > (
    select updated_at from public.treasury_controls
    where control_key = 'payouts_ui_enabled' and enabled = false
    order by updated_at desc limit 1
  );
```

## What not to do

- Don't remove the landlord/proxy exemption without checking with Josh again — it's
  intentional, not the bug.
- Don't extend this fix to block settlement of already-claimed rows without separately
  confirming whether a real cash handover may already have happened for them — see "What
  was deliberately left alone" above.
