# Worked examples

Real groups from production. **Raw** is what is written; **resolved** is what the
balance sheet shows after the resolver.

---

## 1. Tenant collection — an agent collects rent with their float

The most intricate journal in the system. Agent collects UGX 20,000 from a
tenant; 10% commission.

### Raw legs

| Scope | Bucket | Category | Dir | Amount | `recipient_type` |
|---|---|---|---|---:|---|
| platform | — | `tenant_repayment_collected` | cash_in | 20,000 | — |
| wallet | float | `agent_float_used_for_rent` | cash_out | 20,000 | `operational_wallet` |
| platform | — | `agent_commission_payable` | cash_out | 2,000 | — |
| wallet | withdrawable | `agent_commission_earned` | cash_in | 2,000 | `user` |

### Resolved

The float leg triggers `float_backed_collection_counterpart` **and** flips the
repayment direction:

| Account | DR | CR | Why |
|---|---:|---:|---|
| A5 Cash in Transit | 20,000 | | synthetic — the agent now holds the cash |
| L4 Landlord Rent Payable | | 20,000 | synthetic — owed onward to the landlord |
| A3 Rent Access Receivables | | 20,000 | the tenant's Rent Plan balance reduces |
| A2 Float with Agents | | 20,000 | the agent's float was consumed |
| X3 Agent Commission Expense | 2,000 | | commission earned |
| L1 Wallet Custody Payable | | 2,000 | now owed to the agent |
| | **42,000** | **42,000** | ✓ |

**The economics:** the agent's own float funds the tenant's rent. The company
recognises cash in custody and a landlord obligation in the same breath.

**Note the float bucket goes down, never the withdrawable balance.** Float is
company money and is never withdrawable. Commission lands in `withdrawable`
immediately and is the agent's own.

---

## 2. Withdrawal — a user takes money out

| Scope | Bucket | Category | Dir | Amount | → |
|---|---|---|---|---:|---|
| wallet | withdrawable | `wallet_withdrawal` | cash_out | 200,000 | **DR L1** |
| platform | — | `wallet_withdrawal` | cash_in | 200,000 | **CR A1** |

Liability discharged, bank reduced. Balances with no overrides.

---

## 3. Company float delivery — company sends float to an agent

| Scope | Bucket | Category | Dir | Amount | → |
|---|---|---|---|---:|---|
| wallet | float | `agent_float_deposit` | cash_in | 3,000,000 | **DR A2** |
| platform | — | `agent_float_deposit` | cash_out | 3,000,000 | **CR A8** |

Float moves from the cycle-control account out to the agent.

---

## 4. Physical cash deposit → withdrawable (post-fix shape)

| Scope | Bucket | Category | Dir | → |
|---|---|---|---|---|
| platform | — | `cash_receipt_in_transit` | cash_in | **DR A5** |
| wallet | withdrawable | `wallet_deposit` | cash_in | **CR L1** |

Cash received into custody, owed to the depositor.

**For a float deposit the shape differs** — it adds `agent_float_cash_offset`
(CR A2) and `cash_custody_payable` (CR L1) against an `agent_float_deposit`
wallet leg (DR A2). Owned by `supabase/functions/approve-deposit/index.ts`; the
`isFloatDeposit` / `needsPlatformOffset` flags decide which shape is written.

---

## 5. CFO funds landlord float for a Rent Plan

Two groups, posted by `fund-agent-landlord-float`.

### Group 1 — the principal

| Scope | Category | Dir | → |
|---|---|---|---|
| platform | `rent_disbursement` | cash_out | **CR A1** |
| bridge | `rent_receivable_created` | cash_in | **DR A3** |

Company cash leaves; a receivable against the tenant is created.
Key: `fund-agent-landlord-float:<rent_request_id>:float`.

### Group 2 — the fees (`recognise_funding_treasury`)

| Scope | Category | Dir | → |
|---|---|---|---|
| bridge | `fee_receivable_created` | cash_in | **DR A3** |
| platform | `treasury_fee_recognised` | cash_in | **CR L7** |

**No cash moves.** A1/A2/A5 are untouched; L7 is an accounting designation, not a
second cash account.

**Why it exists:** the tenant owes `principal + access fee + registration fee`,
and the repayment waterfall later credits A3 for the *whole* instalment. Without
recognising the fee receivable here, A3 would be over-credited by exactly
(access + registration) across the plan's life. It also establishes the L7 credit
the waterfall draws down — `assert_funding_treasury_recognised()` enforces that
ordering.

> ⚠ **Both categories in group 2 are treasury categories.** Any group touching
> them makes `trg_enforce_ledger_group_mapped_balance` **raise**, not log. It
> must balance on base mapping alone.

---

## 6. Repayment fee waterfall — what a collected instalment decomposes into

Posted by `post_rent_fee_collection` when a collection lands on a plan in
treasury-waterfall scope (funded on/after 2026-09-08, fees > 0).

The instalment splits pro rata against the plan weights (principal / access fee /
registration fee), with largest-remainder rounding and a hard invariant that the
parts foot exactly.

| Scope | Category | Dir | → |
|---|---|---|---|
| platform | `treasury_fee_drawdown` | cash_out | **DR L7** |
| platform | `access_fee_collected` | cash_in | **CR R1** |
| platform | `registration_fee_collected` | cash_in | **CR R1** |

Then `post_treasury_fee_cash_transfer` moves the fee portion of the cash out of
the agent's custody into Treasury — **custody only, no revenue created**:

| Scope | Category | Dir | → |
|---|---|---|---|
| platform | `agent_float_cash_offset` | cash_out | **CR A2** |
| platform | `cash_receipt_in_transit` | cash_in | **DR A5** |

Total cash (A1+A2+A5) unchanged; Treasury cash (A1+A5) rises.

**Both are non-fatal.** A failure files a row in
`rent_fee_collection_exceptions` for replay rather than unwinding the payment.
Plans funded before 2026-09-08 return `out_of_scope_legacy` and post the
repayment and commission groups only.

---

## 7. Cancelling a Rent Plan and returning landlord float

Posted by `cancel_tenant_and_return_landlord_float(rent_request_id, reason)`,
once per open/partially-paid/return-pending allocation.

| Scope | Category | Dir | → |
|---|---|---|---|
| platform | `rent_disbursement` | cash_in | **DR A1** |
| bridge | `rent_receivable_created` | cash_out | **CR A3** |

This reverses **example 5, group 1 only**.

> ⚠ **It does not reverse group 2.** The `fee_receivable_created` / 
> `treasury_fee_recognised` pair stays, so a cancelled plan leaves the access +
> registration fee stranded in A3 with the matching credit parked in L7.
> See `open-defects.md`.

---

## Agent-earnings shapes, side by side

| Paid by | Wallet leg | Platform leg | Resolves to |
|---|---|---|---|
| Collection commission | `agent_commission_earned` @ withdrawable | `agent_commission_payable` | **DR X3 / CR L1** |
| `fund-agent-landlord-float` bonus | `agent_commission_earned` | `agent_commission_earned` | **DR X3 / CR L1** |
| `credit_agent_event_bonus` | `agent_commission` | `marketing_expense` | **DR X1 / CR L1** |
| Landlord / LC1 registration bonus | `agent_commission` | `marketing_expense` | **DR X1 / CR L1** |
| 1% landlord-payout commission | `agent_commission_earned` | `marketing_expense` | **DR X1 / CR L1** |

All five balance. The **expense account is decided entirely by the platform
leg's category** — the wallet leg always takes the fallback to L1.
