# How a collection row comes into existence

Read this before changing anything that writes `agent_collections`, and before
explaining to anyone where the data comes from. Verified against production
`pg_proc` on 2026-09-08; re-read `prosrc` before relying on a detail, because
migrations in `supabase/migrations/` do not faithfully reflect the live schema.

## Contents

- [The float model](#the-float-model)
- [The main path, step by step](#the-main-path-step-by-step)
- [Every writer](#every-writer)
- [Ledger legs](#ledger-legs)
- [Triggers](#triggers)
- [Column reference](#column-reference)
- [Reversal](#reversal)

## The float model

This is the thing that explains the whole table. An agent does not pass the
tenant's cash through the system. The agent is assigned float
(`agent_float_assignment`, `agent_float_deposit`), and "collecting" spends that
float against the tenant's plan — the agent keeps the tenant's cash and settles
up separately (`agent_float_settlement`). The ledger names it
`agent_float_used_for_rent`.

Two consequences:

- Nothing verifies the tenant physically paid. The control is economic: the
  agent is out of pocket the moment they record it.
- An agent with no float cannot collect, however willing the tenant. An
  "agent didn't collect" number is sometimes a float problem, not a field
  problem — worth checking `get_user_wallet_view(agent_id)` before concluding
  anything about performance.

The float an agent spends collecting is a different pot from the money the
platform disbursed to the landlord (ledger `rent_disbursement`, platform scope,
source `rent_requests`).

## The main path, step by step

Entry point `src/components/agent/AgentTenantCollectDialog.tsx` calls
`agent_allocate_tenant_payment`. The offline queue
(`supabase/functions/submit-offline-collection`) deliberately calls the same RPC
so offline and online produce identical rows.

The client issues the RPC exactly once and never auto-retries — a retry on a
weak mobile connection would double-allocate. If it stalls past 45s the client
*queries* `agent_collections` to discover whether it committed. Preserve that
behaviour in any rework.

1. **Wrapper `agent_allocate_tenant_payment(p_agent_id, p_tenant_id,
   p_rent_request_id, p_amount, p_notes, p_partial_confirmed, p_partial_reason)`**
   computes
   `v_expected := agent_expected_collection(p_rent_request_id)` =
   `GREATEST(0, LEAST(daily_repayment, total_repayment - amount_repaid))`,
   read live from `rent_requests`. From that it derives
   `v_shortfall := GREATEST(0, v_expected - p_amount)` and
   `v_is_partial := v_expected > 0 AND p_amount < v_expected`.
   Partials are recorded, never blocked.

2. **`agent_allocate_tenant_payment_internal`** does the money:
   - rejects `p_amount <= 0`
   - ensures a `wallets_physical` row, reads
     `get_user_wallet_view(agent).float_balance`; insufficient float returns
     `error_code = 'INSUFFICIENT_FLOAT'` with the available figure
   - rejects `p_amount > outstanding` with `AMOUNT_EXCEEDS_OUTSTANDING`
   - **commission**: 10% of the amount. If the collector is a sub-agent with a
     `verified`/`approved`/`accepted` link to a different parent, and
     `is_subagent_commission_whitelisted(agent)` is false, they earn 8% and the
     parent takes a 2% recruiter override; otherwise the collector earns the
     full 10%
   - `create_ledger_transaction(legs, idempotency_key)` — see below
   - `UPDATE rent_requests SET amount_repaid = amount_repaid + p_amount`, status
     → `completed` when the plan is cleared, else `repaying` if it was
     `disbursed`/`funded`/`approved`
   - **then** inserts the `agent_collections` row with
     `tracking_id = 'AGT-' || substr(uuid, 1, 8)`

3. **Back in the wrapper**, an `UPDATE` stamps `expected_amount`,
   `shortfall_amount`, `is_partial` and `partial_reason` onto the row just
   created. This is why those columns exist on a table that is otherwise a pure
   receipt — and why they reflect the *live* per-plan instalment, not the pinned
   daily bill.

## Every writer

| RPC | Fires when | Distinguishing marks on the row |
| --- | --- | --- |
| `agent_allocate_tenant_payment` → `_internal` | agent collects cash against a plan; the dominant path | `rent_request_id` set, `expected_amount` stamped, `token_id`/`deposit_request_id`/`visit_id`/`initiated_by` all null, `tracking_id` `AGT-…` |
| `validate_and_record_collection(token_code, method, agent_id)` | token / QR redemption; amount comes from `payment_tokens.amount`, and float is capped by `agent_float_limits.float_limit` rather than the wallet view | `token_id` set, **no** `rent_request_id`, no `expected_amount` |
| `settle_tenant_rent_from_deposit(deposit_request_id)` | a tenant deposit is applied to rent | `deposit_request_id` set |
| `confirm_field_collection(field_collection_id, tenant_id, notes)` | field collection confirmed | `visit_id` path |
| `process_verified_field_deposit(batch_id, finops_user, proof)` | FinOps verifies a field deposit batch | batch context |

To identify which path produced a set of rows, count the null-ness of
`token_id`, `deposit_request_id`, `visit_id` and `initiated_by` — the columns are
the signature. Do **not** use `collection_channel`: `'agent_float'` is the column
default and appears on rows no RPC ever set it on.

## Ledger legs

`agent_allocate_tenant_payment_internal` builds four legs, plus a fifth when a
recruiter override applies:

| user | direction | category | scope |
| --- | --- | --- | --- |
| agent | `cash_out` | `agent_float_used_for_rent` | wallet (bucket `float`) |
| tenant | `cash_in` | `tenant_repayment` | platform |
| agent | `cash_in` | `agent_commission_earned` | wallet |
| agent | `cash_out` | `agent_commission_payable` | platform |
| parent agent | `cash_in` | `agent_commission_earned` (2% override) | wallet |

All legs carry `source_table = 'agent_collections'` but
`source_id = p_rent_request_id` — **not** the collection id. A ledger leg
therefore cannot be traced back to a specific receipt when a plan was collected
more than once in a day. If you need that traceability, that is the change to
make, and it is a schema-level decision.

The `idempotency_key` includes `clock_timestamp()` and a fresh uuid, so it does
not deduplicate a genuine double-submit — the client's no-retry discipline is
what prevents that.

## Triggers

On `agent_collections`:

| Trigger | Timing | Function |
| --- | --- | --- |
| `trg_enforce_agent_full_freeze` | BEFORE INSERT | `enforce_agent_full_freeze` — blocks frozen agents |
| `tr_reactivate_rent_payment_status` | AFTER INSERT | `reactivate_rent_payment_status_on_collection` |
| `trg_agent_collection_recompute_vouch` | AFTER INSERT/DELETE/UPDATE OF amount, agent_id | `trg_recompute_agent_vouch_on_collection` |
| `trg_detect_agent_unblock` | AFTER INSERT | `tr_detect_agent_unblock` |

Because vouch recomputation fires on `UPDATE OF amount`, editing an amount in
place has side effects beyond the row.

## Column reference

`agent_collections`: `id`, `agent_id`, `tenant_id`, `token_id`, `amount`,
`payment_method`, `float_before`, `float_after`, `created_at`, `visit_id`,
`momo_provider`, `momo_phone`, `momo_payer_name`, `momo_transaction_id`,
`tracking_id`, `location_name`, `sms_sent_agent`, `sms_sent_tenant`, `notes`,
`rent_request_id`, `expected_amount`, `shortfall_amount`, `is_partial`,
`partial_reason`, `collection_channel`, `initiated_by`, `deposit_request_id`,
`performance_weight`.

Defaults that mislead if read as data: `collection_channel` → `'agent_float'`,
`is_partial` → `false`, `performance_weight` → `1`, `float_before`/`float_after`
→ `0`.

There is **no status, confirmed, voided or reversed column.** Every row is a
booked event.

`agent_expected_day_plans`: `day` (Kampala date), `rent_request_id`, `agent_id`,
`tenant_id`, `expected_ugx`, `captured_at`. Unique on `(day, rent_request_id)`.

## Reversal

`agent_reverse_tenant_allocation(p_collection_id, p_reason)` requires
`auth.uid()` and a reason of at least 5 characters. It reverses the ledger and
claws back commission, then:

```sql
UPDATE public.agent_collections
   SET notes = COALESCE(notes, '') || ' [REVERSED: ' || p_reason || ']'
 WHERE id = p_collection_id;
```

`amount` is untouched and no row is deleted. Since every dashboard figure is
`SUM(amount)`, **a reversed collection still counts as collected.** Reversals
have historically been rare enough that this never surfaces — which is precisely
what makes it dangerous when a large one happens. Exclude them explicitly
(recipe 8 in `queries.md`) whenever a figure has to hold up.
