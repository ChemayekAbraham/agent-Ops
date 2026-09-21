# 96 — New hard rule: only TID-verified float may fund rent-collection allocation, effective 2026-09-22 00:00 EAT

**Built and applied live 2026-09-21, per explicit CEO (Josh Wanda) directive.** Before touching
`agent_allocate_tenant_payment_internal`, `agent_tid_backed_float`, or
`tg_credit_tid_backed_float` again.

## Where this came from

Follows directly from docs 93's investigation. After voiding 46 unbacked collections for
2026-09-14, tracing individual agents' evidence turned up a structural gap: `agent_collections`
draws down an agent's `float_balance`, but `float_balance` itself is fungible — it mixes real,
TID-evidenced deposits with commission self-transfers, admin "operator move" reassignments between
agents (found live: Kagoda Peter Claver's entire UGX 1.5M float was a manual `finops_wallet_move`
from Mercy Bayo, no TID, no deposit at all), and other non-deposit credits. `agent_allocate_tenant_payment_internal`
only ever checked `float_balance >= amount` — never whether that specific money was independently
evidenced.

A full chronological reconciliation (every real, gmail-matched deposit vs every collection draw,
in order, for the 8 agents on the original photographed report) found only **~13% (UGX 7.0M of
UGX 54.4M)** of the 14–21 Sept window's collections were genuinely TID-backed — most agents'
backed pool was already exhausted before the window even started. Platform-wide, of 74 agents
active in the last 14 days, **68 (92%) are currently running a net TID deficit** (UGX 375M drawn
lifetime vs UGX 206M in evidenced deposits, agent_float_deposit only).

Josh's directive: **"Only float backed up by TIDs should be used to allocate and pay rent
collection."** Tenant agents only — explicitly **not** merchant/cashout agents, a separate
subsystem this does not touch. Rollout: don't claw back what's already sitting in wallets: *"let
it be on the wallet"* — but gate every **new** allocation starting **2026-09-22 00:00 EAT**.

## What was built

**`agent_tid_backed_float`** (new table): `agent_id PK, balance numeric, updated_at`. A
second, stricter ledger tracked in parallel to raw `float_balance`.

**Seeded once, live, from full history** — not zeroed for everyone, and not a naive
"total-deposits-minus-total-draws" either. Uses the reflected-random-walk formula for a
floor-at-zero running balance: `pool_k = S_k − min(0, running_min(S_0..S_k))`, where `S_k` is the
raw (unclamped) cumulative sum of TID-backed credits minus draws in chronological order. This
matters: a naive clamp-at-each-step-only calculation (what the first, wrong version of this
analysis used) permanently punishes an agent for an old deficit even after a later real deposit
would have covered it. The reflected formula correctly "forgives" old deficits once genuinely
repaid. 439 agents seeded, UGX 975,445,098 total pool. Spot-checked: Hassan Hussein (large recent
real deposits) UGX 6,686,000; Thomas Kawahka UGX 838,460; David Kanyesigye UGX 0 (his window-period
backing had already been drawn down by further collections since).

**Credit sources** (via `tg_credit_tid_backed_float`, an `AFTER INSERT ON general_ledger` trigger
— centralized there rather than patched into every deposit/transfer code path, since
`general_ledger` already has ~35 triggers doing exactly this kind of side-effect bookkeeping):
- `category='agent_float_deposit', direction='cash_in'`, only if the deposit's `deposit_requests.transaction_id`
  has a real matching row in `gmail_transactions` — credits the pool.
- Same category, `direction='cash_out'` (a reversed deposit) — claws the credit back out.
- `category='bucket_reclass_in', source_table='agent_withdrawable_to_float'` — an agent
  voluntarily moving their own commission-sourced withdrawable balance into float; legitimate per
  Josh's own wording ("deposits, commissions"). No advance-related credit path currently routes
  into the `float` bucket at all (`agent_advance_credit` posts to a wholly separate
  `advance_credit` bucket) — so "advances" has nothing to wire up here yet; noted, not built.

**The gate itself**, inside `agent_allocate_tenant_payment_internal`: after the existing
`float_balance >= amount` check (kept, unchanged), a new check — only active `IF now() >=
'2026-09-22 00:00:00+03'::timestamptz` — requires `agent_tid_backed_float.balance >= p_amount`,
refusing with a new `INSUFFICIENT_TID_BACKED_FLOAT` error code otherwise. On every successful
allocation (regardless of date, so the counter stays accurate through the cutover) the pool is
decremented by the allocated amount in the same statement as the real float draw.

## Verified live (2026-09-21, before the cutover — behavior must be unchanged today)

```sql
select now() >= '2026-09-22 00:00:00+03'::timestamptz as gate_active;        -- false, correct
select prosrc ilike '%INSUFFICIENT_TID_BACKED_FLOAT%' from pg_proc
  where proname='agent_allocate_tenant_payment_internal';                    -- true
select count(*) from pg_trigger where tgname='trg_credit_tid_backed_float';  -- 1
```

Did **not** live-fire a synthetic `general_ledger` insert to test the trigger end-to-end — that
would mean deliberately working around `trg_enforce_ledger_rpc_only`'s RPC-only guard, which is
exactly the kind of thing not to route around. **First real deposit approval after this deploy
should be spot-checked** (`select balance from agent_tid_backed_float where agent_id = '<that
agent>'` before/after) to confirm the trigger actually fires as designed.

## What happens at midnight 2026-09-21→22 EAT

Given 92% of recently-active agents are already in deficit, **most agents will be refused with
`INSUFFICIENT_TID_BACKED_FLOAT` on their next collection attempt** starting 00:00 EAT — this is
the intended, explicit effect of the rule, not a bug. The app-side error message currently
returned is a raw jsonb `error_code`/`error` string; **no frontend UI change has been made** to
surface this new error distinctly from `INSUFFICIENT_FLOAT` — whoever owns the collection UI
(Gemini, per this repo's division of labor) should give `INSUFFICIENT_TID_BACKED_FLOAT` its own
message ("deposit real money to keep collecting" vs. generic "top up your float") rather than
letting it render as a raw/generic error.

## What was deliberately NOT done

- **No claw-back of existing float balances.** Exactly as directed — money already in a wallet
  stays there, whatever its origin.
- **No change to merchant/cashout agent float** — structurally separate tables/flow, out of scope
  per Josh's explicit instruction.
- **No advance-to-float credit path built** — advances don't currently fund the `float` bucket in
  this codebase at all, so there was nothing to make TID-aware. If that changes later, extend
  `tg_credit_tid_backed_float`.
- **No retroactive re-evaluation of the 8 agents' 14–21 Sept collections** beyond doc 93's 14th-day
  void. This migration only changes what happens going forward from the cutover.

## What not to do

- Don't move the `v_tid_gate_effective` cutover date without Josh's explicit sign-off — it's a
  hardcoded constant inside the function body specifically because this was a one-time, dated
  policy decision, not a config toggle.
- Don't "fix" the coming wave of `INSUFFICIENT_TID_BACKED_FLOAT` refusals by loosening the gate —
  that's the rule working as designed. The fix, if agents complain, is telling them to deposit real
  money, not weakening the check.
- Don't assume `float_balance` and `agent_tid_backed_float.balance` should ever be reconciled to
  match each other — they're deliberately different numbers now (raw vs. evidenced), and that gap
  *is* the point.
