# 100 — `merchant_out_of_pocket_advances.pending_reimbursement` is a stale, unattested backlog, not real debt

**Investigation only, no code changed. Before treating `consume_merchant_float()`'s `receivable_after`
value — or any `SUM(shortfall_amount) WHERE status='pending_reimbursement'` query — as money the
company owes an agent, read this.**

## What happened

While tracing the 2026-09-10 Bayo Mercy UGX 90,002,000 handoff (doc 69/91-adjacent work) into "what's
happened to merchant float since," a report was built that presented `v_merchant_payout_float_trace`'s
`receivable_after` column as a live, real receivable: **UGX 466,197,126 owed to merchant agents
platform-wide, UGX 397,790,821 of it to the Sky Bubbles desk (Immaculate Namulindwa) alone, and
climbing.** Josh (CFO) corrected this immediately and firmly: **the company owes no one money**, and
those figures reflect a long-standing system issue, not real debt.

**He was right, and here's the actual mechanism, verified against production:**

`v_merchant_payout_float_trace.receivable_after` is not a running ledger. It's a snapshot column on
`merchant_float_reservations`, written once per transaction by `consume_merchant_float()`:

```sql
SELECT COALESCE(SUM(shortfall_amount), 0) INTO v_receivable
FROM public.merchant_out_of_pocket_advances
WHERE agent_id = p_agent_id AND status = 'pending_reimbursement';
```

Two problems compound into "this looks like real, growing debt":

1. **It's a stale snapshot, not a live figure.** It's stamped at the time of each transaction and
   never revisited. Confirmed live: BAYO MERCY's `receivable_after` from her 15 Sep transaction read
   21,330,125 — but the actual current `pending_reimbursement` sum for her, queried live on 21 Sep,
   is only 50,000. ~21.28M of what looked like "owed to her" had already resolved (rejected/
   reimbursed) since her last transaction; nothing ever re-stamped her trace row to reflect it. Any
   agent who hasn't transacted recently shows a number that's out of date, always in the direction of
   overstating what's outstanding.
2. **The underlying SUM never filters for confirmation.** It counts every `pending_reimbursement`
   row regardless of whether the agent ever *attested* to fronting the cash or whether Financial Ops
   ever *reviewed* the claim. Verified live: of the UGX 444,872,401 currently sitting in
   `pending_reimbursement` platform-wide (787 rows), **99.5% (442,758,974) has never been attested by
   the agent or reviewed by anyone.** It's raw, unconfirmed system output.

**The historical pattern backs Josh's read.** All-time, by outcome:

| Status | Claims | Total (UGX) |
|---|---|---|
| `rejected` | 2,310 | 516,563,089 |
| `pending_reimbursement` (still open) | 787 | 444,872,401 |
| `reimbursed` | 110 | 54,065,893 |

Once something in this table is actually triaged, it's roughly **10x more likely to be rejected than
reimbursed** (by both count and value). There's no reason to expect the untriaged 787-row backlog
would resolve any differently — it just hasn't been looked at. Oldest entries in the pending bucket
date to 31 Aug/2 Sep 2026 — three weeks of accumulation with essentially nothing clearing it (compare
110 reimbursed rows *all-time* against 787 sitting open *right now*).

## Sky Bubbles specifically

372 of her pending rows (UGX 397,788,821 of the 397,790,821 total) are unattested and unreviewed —
effectively the entire balance. She has processed 100+ proxy payouts since 09-12 with her float
reconciliation balance at 0 (see doc 69/91 for that trace, which is accurate and unaffected by this
finding) — every one of those, when float reads as unavailable, auto-generates an out-of-pocket
shortfall row. Nothing in the current flow ever attests, reviews, or clears them.

## What this doc does NOT establish

- **Not confirmed:** whether the `shortfall_amount`/`out_of_pocket_amount` classification itself is a
  bug (e.g., float miscalculated as unavailable when it wasn't) versus real fronting that gets
  reconciled off-system without ever touching this table's `status` column. Either explanation is
  consistent with the data gathered here; distinguishing them needs someone who actually works these
  proxy payouts, not another query.
- **Not fixed:** the backlog itself. 787 rows still need triaging through whatever the intended
  attest/review/settle flow is (`settle_merchant_out_of_pocket`, per
  [[project_merchant_oop_settlement_rpc_evidence_gap]] / doc set around 2026-09-01) or rejection.

## What not to do

- Don't read `receivable_after` (or any `merchant_out_of_pocket_advances` pending sum) as a real,
  current liability without re-querying live and checking attestation/review status — this doc is the
  second time this exact "unconfirmed status field summed as if confirmed" shape of bug has produced
  a false debt reading (see [[project-merchant-oop-attestation-gate-hides-debt]] for the *opposite*
  failure mode on the same table — that one hid real debt by requiring attestation too strictly; this
  one manufactures apparent debt by requiring none at all for the raw sum).
- Don't build a financial report from a single aggregate column again without checking what actually
  writes to it and whether it's live or a stale stamp — that's the mistake this doc corrects.

## Verify this is still the state

```sql
select status, count(*), sum(shortfall_amount)
from merchant_out_of_pocket_advances group by status order by 3 desc;

select (attested_at is not null) as attested, (reviewed_at is not null) as reviewed,
  count(*), sum(shortfall_amount)
from merchant_out_of_pocket_advances where status = 'pending_reimbursement'
group by 1,2;
```
