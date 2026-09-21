# 93 — Voided 46 unbacked agent-reported cash collections for 2026-09-14, UGX 1,260,000

**Executed live against production on 2026-09-21, per explicit CEO (Josh Wanda) directive, after
confirming scope and consequences with him twice.**

## What was reported

Josh shared a printed "Rent Collectors Report" (ref `W-RCR-20260921`, date window 14–21 Sept 2026,
"Top Collecting Agents" chart) and asked: for the agents on that chart, was the money they're shown
as having "collected" actually deposited, and do we have an email transaction (an ingested MoMo/bank
receipt in `gmail_transactions`) to back each one up? If not, he wanted it voided.

## What was found

The 8 agents on the chart (Oscar Arnold, Thomas Kawahka, Kakooza Charles, David Kanyesigye, Ian
Muhwezi, Sharifu Kalule, Mugisha Emmanuel, Denis Tushabe) matched live `agent_collections` data
exactly. Every one of their 497 collections in the 14–21 Sept window was posted with
`collection_channel = 'agent_float'`, `payment_method = 'cash'`, `momo_transaction_id IS NULL`, and
`deposit_request_id IS NULL` — i.e. the agent self-reported taking cash from a tenant and it was
credited straight to their own float, with no bank/MoMo event and therefore nothing that could ever
appear in `gmail_transactions`. Against UGX 53,977,812 self-reported "collected" for these 8 agents
that week, only UGX 570,000 (Oscar Arnold: 5 small top-ups; Ian Muhwezi: 1 top-up) had any matching
`deposit_requests` → `gmail_transactions` evidence at all — and even that evidence wasn't linked to
any specific collection row (`deposit_request_id` was null on all 497). This channel is not unique to
these 8: platform-wide that week, `agent_float` cash accounted for UGX 81.1M of UGX 81.26M collected
(99.9%); these 8 were simply the agents with the *least* deposit activity of the agents using it.

Asked to scope the void, Josh first said the whole 14–21 window, then narrowed it to **2026-09-14
only** ("that report is from 14th").

## What was voided

46 `agent_collections` rows, 2026-09-14 (Africa/Kampala day), for the 8 agents above, matching
`collection_channel='agent_float' AND momo_transaction_id IS NULL AND deposit_request_id IS NULL`:

| Agent | Collections | Tenants | Amount (UGX) |
|---|---:|---:|---:|
| Ian Muhwezi | 7 | 6 | 700,000 |
| Thomas Kawahka | 26 | 24 | 305,000 |
| David Kanyesigye | 1 | 1 | 100,000 |
| Mugisha Emmanuel | 10 | 9 | 90,000 |
| Oscar Arnold | 2 | 2 | 65,000 |
| **Total** | **46** | **42** | **1,260,000** |

(Kakooza Charles, Sharifu Kalule, and Denis Tushabe had no `agent_float` collections specifically on
the 14th — theirs fell later in the window and were left untouched, per the narrowed scope.)

Voided via a new function, `admin_void_unverified_collection(p_collection_id, p_actor_id, p_reason)`
(migration `20260921090000_admin_void_unverified_collection.sql`), run once per row live. It is
**not** the same as the existing `agent_reverse_tenant_allocation` — that one only lets an agent
reverse their own "float allocation" note-tagged rows and can't be invoked by staff against someone
else's collections.

Per collection, the function:
- Finds every `general_ledger` leg posted for it (matched by `source_table='agent_collections'`,
  `source_id=rent_request_id`, `created_at` exactly equal to the collection's `created_at` — all legs
  of one collection share that timestamp down to the microsecond, verified unique) and inserts a
  mirror leg with the direction flipped (cash_in↔cash_out), same user/category/scope/bucket. This
  self-generalized to however many legs a given collection had (4 for a normal collection, 5 when a
  sub-agent recruiter-override commission leg was also present) — no per-category logic to maintain.
- Reverts `rent_requests.amount_repaid` down by the collection amount (floored at 0) and rolls
  `status` back from `completed` to `repaying` where applicable.
- Inserts a negative `repayments` row.
- Sets `agent_collections.reversed_at` and appends a `[VOID by ...]` note. Idempotent — re-running on
  an already-voided row returns `{"success": false, "error": "already_reversed"}`, no double-posting.

**One real complication, handled deliberately, not worked around:** reversing the agent's 10%
commission on these collections tried to debit their `withdrawable` wallet bucket by an amount they
no longer had — several of these agents had already cashed out the commission earned on this
unverified cash before today. `enforce_no_negative_wallet_ledger()` correctly blocked that as
`LEDGER_BACKING_REQUIRED`. This is real: those agents now owe that commission back, not a bug to
route around. The reversal legs are tagged `classification='admin_correction'` +
`solvency_bypass_reason='other_with_note'` (existing, general_ledger.solvency_bypass_reason enum) so
the trigger lets the correction through while still recording it as a documented bypass, not a silent
override.

## Verified after execution

```sql
-- 46/46 reversed, UGX 1,260,000 total — matches the pre-execution preview exactly
select count(*), sum(amount) from agent_collections
where reversed_at is not null and notes ilike '%VOID by cb798acb%';
-- → 46, 1260000

-- 186 reversal ledger legs inserted (44 collections × 4 legs + 2 sub-agent collections × 5 legs),
-- net to UGX 0.00 — double-entry balanced
select count(*), sum(amount*(case when direction='cash_in' then 1 else -1 end))
from general_ledger where idempotency_key like 'void_unverified_collection:%';
-- → 186, 0.00

-- 46 negative repayments rows inserted
select count(*) from repayments where amount < 0 and created_at > now() - interval '20 minutes';
-- → 46

-- Report now shows zero agent_float "collected" for these 8 agents on the 14th —
-- only their genuinely-evidenced deposits (if any) remain
select p.full_name, sum(ac.amount) from agent_collections ac join profiles p on p.id=ac.agent_id
where ac.agent_id in (...) and ac.created_at >= '2026-09-14T00:00:00+03:00'
  and ac.created_at < '2026-09-15T00:00:00+03:00' and ac.reversed_at is null
group by p.full_name;
-- → 0 rows
```

## Consequence, explicitly accepted by Josh before execution

This reverts these 42 tenants' rent balance for that day back to owing the money — they will show as
having a shortfall again, even though most of them plausibly did hand cash to their agent (the
missing evidence is about the *agent* not floating it back to the company, not proof the *tenant*
didn't pay). Flagged this distinction to Josh explicitly before running anything; he confirmed he
wants the tenant side reverted too, not just the agent's float credit.

## What was deliberately NOT done

- **Did not touch the 15–21 Sept portion** of these agents' unbacked collections (~UGX 52.7M across
  ~107 more tenants) — narrowed to the 14th only per Josh's explicit instruction. That money is in
  the exact same evidentiary state (self-reported cash, zero deposit backing) and the same question
  will apply if/when he wants it addressed.
- **Did not touch any other agent's `agent_float` collections** platform-wide (~UGX 80M/week) — this
  was scoped strictly to the 8 agents on the report he showed.
- **Did not build an evidence gate** to stop this from recurring going forward (e.g. requiring a
  `deposit_request_id` before a collection counts toward reported "Collected"). This pass only
  corrects the numbers already reported for 2026-09-14; the underlying `agent_float` channel still
  lets any agent self-credit cash with no verification. That's a real, larger gap — worth a
  follow-up in the same shape as the Merchant OOP attestation-gate fix
  ([[project-merchant-oop-attestation-gate-hides-debt]]) — but wasn't asked for in this pass.

## What not to do

- Don't assume `agent_float` collections are inherently fraudulent — it's the platform's normal cash
  channel (99.9% of collected cash that week). The finding here is the *evidence gap*, not that the
  channel itself is wrong.
- Don't re-run this against the 15–21 Sept rows or any other agent without a fresh, explicit scoping
  conversation — the tenant-arrears consequence is real and was a deliberate, informed call for this
  specific slice, not a general policy.
