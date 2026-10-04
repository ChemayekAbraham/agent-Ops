# Tenant Operations Architecture Manual

> Read-only architectural reverse-engineering of the Tenant Operations (Tenant Ops) module.
> Nothing in the codebase, database, Edge Functions, RPCs, triggers or crons was modified to produce this document.
> All figures were read live from the production database and the current `main` working tree.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Tenant lifecycle](#2-tenant-lifecycle)
3. [Business model and money mechanics](#3-business-model-and-money-mechanics)
4. [Rent request engine](#4-rent-request-engine)
5. [Tenant management surfaces](#5-tenant-management-surfaces)
6. [Data inventory](#6-data-inventory)
7. [Edge Function inventory](#7-edge-function-inventory)
8. [RPC inventory](#8-rpc-inventory)
9. [Trigger inventory](#9-trigger-inventory)
10. [Collection engine](#10-collection-engine)
11. [Financial interaction with the ledger](#11-financial-interaction-with-the-ledger)
12. [State machines](#12-state-machines)
13. [Tenant Ops dashboard architecture](#13-tenant-ops-dashboard-architecture)
14. [Reporting and analytics](#14-reporting-and-analytics)
15. [Security model](#15-security-model)
16. [Failure modes](#16-failure-modes)
17. [Scheduled jobs](#17-scheduled-jobs)
18. [End-to-end diagrams](#18-end-to-end-diagrams)
19. [Risk assessment](#19-risk-assessment)
20. [Appendices](#20-appendices)

---

## 1. Executive summary

Tenant Operations is the module that turns **a person who cannot pay rent today** into **a funded tenancy that repays daily**, and then supervises that repayment until the balance is cleared.

It is built from five cooperating layers:

| Layer | Where it lives | Role |
|---|---|---|
| Origination | `register-tenant`, `submit-tenant-form`, `generate-tenant-form-token` | Creates tenant identity, landlord, LC1 chairperson, and the `rent_requests` row |
| Approval pipeline | `rent_requests` status machine + ops dashboards | Multi-desk review (Agent Ops → Tenant Ops → Landlord Ops → COO → CFO) |
| Funding & disbursement | `fund-tenants`, `fund-tenant-from-pool`, `disburse-rent-to-landlord`, `pay-landlord-rent` | Moves supporter/pool capital to the landlord and creates the tenant receivable |
| Collection | `agent_allocate_tenant_payment`, `manual-collect-rent`, `tenant-pay-rent`, `submit-offline-collection`, `auto-charge-wallets` | Reduces the receivable, pays 10% agent commission |
| Supervision | Tenant Ops hub, `tenant_idle_states`, penalty/reminder crons, `tenant_balance_edits` | Detects idle tenancies, corrects balances, escalates and reassigns |

**Core invariant.** `rent_requests` is the *tenancy contract of record*; `general_ledger` is the *money record of record*. A tenancy's outstanding balance is `total_repayment - amount_repaid` on `rent_requests`, mirrored (not driven) by `bridge`-scope ledger legs. There is **no** `outstanding_balance` column — every consumer derives it.

**Live scale (at time of writing).**

| Table | Rows |
|---|---|
| `house_listings` | 33,876 |
| `agent_collections` | 7,428 |
| `rent_requests` | 1,485 |
| `tenant_agreement_acceptance` | 772 |
| `tenant_idle_states` | 686 |

**Rent request status distribution.**

| Status | Count |
|---|---|
| `repaying` | 590 |
| `completed` | 380 |
| `rejected` | 180 |
| `pending` | 143 |
| `funded` | 99 |
| `deleted_by_agent` | 79 |

**Tenant idle-state distribution.**

| State | Count |
|---|---|
| `healthy` | 371 |
| `reassign_ready` | 177 |
| `warn` | 89 |
| `at_risk` | 49 |

> 315 of 686 supervised tenancies (46%) are currently *not* healthy, and 177 have crossed the reassignment threshold. This is the single largest operational signal in the module.

---

## 2. Tenant lifecycle

```text
                      ┌──────────────────────────┐
   Agent in the field │  register-tenant         │  ← staff/agent JWT
   or a shared link   │  submit-tenant-form      │  ← agent_form_tokens (no JWT)
                      └────────────┬─────────────┘
                                   │ creates
        profiles + user_roles(tenant) + referrals
        landlords + lc1_chairpersons + house photos
                                   │
                                   ▼
                        rent_requests (status = pending)
                                   │
        ┌──────────────────────────┴─────────────────────────┐
        │  Review desks (status machine, section 12)         │
        │  agent_ops → tenant_ops → landlord_ops → coo → cfo │
        └──────────────────────────┬─────────────────────────┘
                                   │ approve-rent-request
                                   ▼
                        status = approved  + subscription_charges row
                                   │
                 ┌─────────────────┴──────────────────┐
                 │ fund-tenants (direct supporter)    │
                 │ fund-tenant-from-pool (pool)       │
                 └─────────────────┬──────────────────┘
                                   ▼
                        status = funded  (receivable created)
                                   │ disburse-rent-to-landlord
                                   ▼
                        status = disbursed → repaying
                                   │
        daily/weekly collection (section 10) reduces amount_repaid
                                   │
                    amount_repaid >= total_repayment
                                   ▼
                        status = completed
```

**Alternate entry: outstanding-balance registration.** When `registration_type = 'outstanding_balance'`, the tenant already owes a landlord and no money moves on-platform. `rent_requests_outstanding_pipeline_guard` blocks `coo_approved`, `funded` and `disbursed` entirely and rewrites `tenant_ops_approved → landlord_ops_approved` into `repaying` directly, stamping every downstream review column and `payout_method = 'no_disbursement_outstanding'`.

**Terminal / exit states.**

- `completed` — fully repaid (auto-set nightly by `auto_close_fully_repaid_rents`).
- `rejected` — declined at a review desk; can be resubmitted or force-approved.
- `deleted_by_agent` — agent-initiated cancellation via `agent_cancel_rent_request` (mandatory reason).
- Replacement — `replace_tenant_at_property` ends one tenancy and opens another at the same property.
- Transfer — `transfer-tenant` moves the tenancy to a different agent, not a different tenant.

---

## 3. Business model and money mechanics

The canonical pricing formula lives in one place, `public.compute_rent_repayment(rent_amount, duration_days)`:

```sql
access_fee      = ROUND(rent * (1.33 ^ (days / 30) - 1))
request_fee     = CASE WHEN rent <= 200,000 THEN 10,000 ELSE 20,000 END
total_repayment = rent + access_fee + request_fee
daily_repayment = CEIL(total_repayment / days)
```

- **33% per 30 days, compounded on the term length.** A 30-day plan costs 33% of rent; a 60-day plan costs 76.9%; a 90-day plan costs 135.2%.
- **Registration fee** is a flat UGX 10,000 (rent ≤ 200,000) or UGX 20,000.
- Trigger `enforce_rent_request_formula` (BEFORE INSERT/UPDATE) **overwrites** `access_fee`, `request_fee`, `total_repayment` and `daily_repayment` from the RPC on every write — client-supplied values for these four columns are never trusted. For `registration_type = 'outstanding_balance'` the fees are forced to zero and the formula is skipped.
- `clamp_rent_request_amount_repaid` (BEFORE INSERT/UPDATE) clamps `amount_repaid` into `[0, total_repayment]`, so overpayment can never be recorded on the contract.

**Revenue recognition.** Fee revenue is not recognised at approval. `sync_collection_to_ledger` splits each collected shilling proportionally: `rent_share = amount × (rent_amount / total_repayment)` is posted as `rent_principal_collected` (bridge scope, `cash_out` against the tenant), with the remainder implicitly recognised as fee income — i.e. **incremental proportional recognition**, not front-loaded.

**Agent economics on collection.** 10% of every allocated collection, paid instantly:
- Solo agent: 10% to the collecting agent (`agent_commission_earned`, wallet scope, `recipient_type = 'user'` → withdrawable).
- Sub-agent: 8% to the sub-agent, 2% recruiter override to the verified parent agent.
- Platform side: full 10% posted as `agent_commission_payable` (platform scope, `cash_out`).

**Overdue penalty.** `apply-rent-overdue-penalty` charges 33% of outstanding per 30-day cycle after term expiry, posted as `tenant_default_charge` (platform `cash_in` / bridge `cash_out`) and folded into `total_repayment`.

---

## 4. Rent request engine

`public.rent_requests` is a 113-column table — the widest in the module — because it carries the contract, the pricing, six review desks, the disbursement proof, the collection state and the agent-supervision state in one row.

**Column families.**

| Family | Representative columns |
|---|---|
| Parties | `tenant_id`, `agent_id`, `assigned_agent_id`, `landlord_id`, `supporter_id` |
| Pricing (trigger-owned) | `rent_amount`, `duration_days`, `access_fee`, `request_fee`, `total_repayment`, `daily_repayment` |
| Progress | `amount_repaid`, `last_payment_amount`, `tenancy_status`, `schedule_status` |
| Review desks | `agent_verified*`, `tenant_ops_*`, `landlord_ops_reviewed_*`, `coo_reviewed_*`, `cfo_reviewed_*`, `manager_verified*` |
| Disbursement | `funded_at`, `disbursed_at`, `fund_routed_at`, `fund_recipient_id/type/name`, `payout_method`, `payout_transaction_reference` |
| Landlord payout schedule | `landlord_payout_enabled`, `landlord_payout_next_run_at` |
| Agent supervision | `agent_payment_status`, `agent_payment_status_reason`, `agent_payment_status_set_by/at` |
| Classification | `registration_type` (`normal` \| `outstanding_balance`), `outstanding_grace_days` |

**There is no `outstanding_balance` column.** Every surface computes `GREATEST(0, COALESCE(total_repayment,0) - COALESCE(amount_repaid,0))`. Any new code must do the same.

**Write authority.** Direct client `UPDATE`s on `rent_requests` are heavily constrained by `guard_rent_request_agent_updates` (section 9). Ops corrections must go through `ops_edit_tenant_balance` or `tenant_ops_correct_rent_request`; agent collections must go through `agent_allocate_tenant_payment`.

---

## 5. Tenant management surfaces

| Capability | Mechanism | Guard |
|---|---|---|
| Correct rent amount / outstanding | `ops_edit_tenant_balance` | `is_tenant_ops_staff()`, reason ≥ 10 chars, writes `tenant_balance_edits` + `audit_logs` |
| Correct full contract (fees, duration, repaid) | `tenant_ops_correct_rent_request` | manager/operations/coo/cfo/ceo/super_admin, reason ≥ 10 chars, blocked on terminal statuses |
| Reassign agent | `reassign_rent_request_agent` | ops roles, reason required |
| Transfer tenant between agents | `transfer-tenant` Edge Function | manager/super_admin/coo/operations, reason ≥ 10 chars, writes `tenant_transfers` |
| Replace tenant at a property | `replace_tenant_at_property` | Role check inside the RPC (invoked with caller JWT) |
| Pause repayment | `pause_tenant_repayment` / `resume_expired_repayment_pauses` | Ops; auto-resume cron at 00:10 |
| Cancel own in-review request | `agent_cancel_rent_request` → `deleted_by_agent` | Agent-owned, reason mandatory |
| Delete rejected request | `agent_delete_rejected_rent_request` | Agent-owned, rejected only |
| Hard delete (destructive) | `delete-rent-request` Edge Function | `manager` only — deletes 13 dependent tables **including `general_ledger` rows** |
| Reopen a closed request | `reopen_rent_request` | Ops, reason required |
| Renew | `renew_rent_request` | Creates the follow-on contract |
| Flag as not paying | `agent_set_rent_payment_status` → `notify-tenant-inactive` | Agent-owned; frees the house back to Priority 1 |

**Balance-edit audit trail.** `tenant_balance_edits` (18 columns) stores before/after for rent, total, repaid, daily and outstanding, plus editor identity and reason. `ops_tenant_balance_history` reads it back.

---

## 6. Data inventory

| Table | Cols | Purpose |
|---|---|---|
| `rent_requests` | 113 | Tenancy contract, pricing, review desks, progress |
| `agent_collections` | 20 | Every field collection (the capacity source of truth) |
| `repayments` | 5 | Repayment log written by `record_rent_request_repayment` |
| `tenant_idle_states` | 14 | Cadence/idleness classification per active tenancy |
| `tenant_balance_edits` | 18 | Ops balance-correction audit |
| `tenant_transfers` | 14 | Agent-to-agent tenancy moves |
| `tenant_replacements` | 12 | Tenant swaps at a property |
| `tenant_inactive_reviews` | 11 | Tenant Ops review of not-paying flags |
| `rent_request_deletions` | 22 | Deletion history |
| `rent_request_drafts` | 12 | Agent-side unsent drafts |
| `tenant_agreement_acceptance` | 8 | Digital tenancy agreement acceptance |
| `tenant_ops_filter_presets` | 8 | Saved ops filters (private/shared) |
| `tenant_ratings` | 6 | Landlord ratings of tenants |

Adjacent but load-bearing: `house_listings` (33,876 rows — the property inventory a tenancy binds to), `subscription_charges` / `subscription_charge_logs` (the auto-charge schedule), `landlords`, `lc1_chairpersons`, `offline_collection_submissions`, `ops_inbox_events`.

---

## 7. Edge Function inventory

### Origination

| Function | Auth | Writes | Idempotency |
|---|---|---|---|
| `register-tenant` | `getUser` (service client); **no role check** | `profiles`, `user_roles`, `referrals`, `landlords`, `lc1_chairpersons`, `rent_requests` | Manual rollback bookkeeping + phone/national-ID dedupe |
| `submit-tenant-form` | **No JWT** — validated by `agent_form_tokens` (token + agent + expiry + use count) | as above, plus `supporter_invites` and `house-images` storage | Token use-count + phone dedupe only |
| `generate-tenant-form-token` | `getUser`; no role restriction | `agent_form_tokens` | None |

### Approval, funding, disbursement

| Function | Auth | Key behaviour |
|---|---|---|
| `approve-rent-request` | `manager` or `agent`; `verify_jwt=false` | Requires `landlords.verified = true` (400 `LANDLORD_NOT_VERIFIED`); recomputes via `compute_rent_repayment`; creates `subscription_charges`; notifies + SMS. Re-entry blocked by `status = 'pending'` gate |
| `fund-tenants` | `supporter`; `verify_jwt=false` | Wallet-funded; posts `rent_disbursement` (platform) + `rent_receivable_created` (bridge); queues `pending_wallet_operations`. **No idempotency key** |
| `fund-tenant-from-pool` | `manager`; `verify_jwt=false` | Pool balance = Σ`supporter_rent_fund` − Σ`pool_rent_deployment`; **15% liquidity floor gate**; credits landlord wallet; pays UGX 5,000 agent bonus. **No idempotency key** |
| `fund-rent-pool` | `supporter` (gateway-verified — inconsistent with siblings) | Creates a 12-month, 15%/month `investor_portfolios` row; `partner_funding` legs |
| `disburse-rent-to-landlord` | `cfo`/`manager`/`super_admin` + treasury guard | Requires `coo_approved`/`funded`; writes `disbursement_records`; UGX 5,000 agent bonus; `audit_logs`. **All errors return 400**; no idempotency key |
| `pay-landlord-rent` | **None** (cron, service role) | Monthly landlord payout; `idempotency_key = landlord_rent:{id}:{YYYY-MM}`; `capture_trust_signal` for landlord + tenant |

### Collection

| Function | Auth | Idempotency |
|---|---|---|
| `manual-collect-rent` | manager/super_admin/operations/coo/cfo/ceo/employee; reason ≥ 10 chars | Commission leg only, and its key embeds a fresh timestamp → **principal is not protected** |
| `tenant-pay-rent` | Tenant's own JWT | `tenant-pay-{rentRequestId}-{amount}` — **collides across two legitimate same-amount payments** |
| `submit-offline-collection` | Agent's own JWT | **Strongest in the module**: reserved `offline_collection_submissions` row keyed on `draft_id` (unique constraint → 409), replay returns the cached receipt. Delegates money movement to `agent_allocate_tenant_payment` using the agent's JWT |

### Mutation tools

`transfer-tenant` (ops roles, all errors 400), `replace-tenant` (thin wrapper over `replace_tenant_at_property`, role check inside the RPC), `delete-rent-request` (`manager` only; destructive — removes `general_ledger` rows by `source_id` with **no compensating entries**).

### Cron / monitoring

`apply-rent-overdue-penalty` (count-based idempotency against existing penalty legs), `rent-reminders` (no idempotency — double-run duplicates notifications), `rent-amount-change-notify` (`notified_at` stamp + email/SMS keys), `refresh-tenant-idle-states` (full rebuild, naturally idempotent), `notify-tenant-inactive` (6-hour dedupe window), `notify-agent-collection-lapse` (**idempotency key computed but never persisted or checked**), `agent-daily-collection-report` (per-agent per-day notification check).

### SMS-only

`send-collection-sms` (**checks only that an `Authorization` header exists — never calls `getUser`**), `send-rent-access-sms` (any authenticated caller; 3-provider chain), `welile-home-tenant-onboarding-sms` (permanent per-tenant idempotency key).

---

## 8. RPC inventory

**Pricing & progress:** `compute_rent_repayment`, `record_rent_request_repayment`, `agent_allocate_tenant_payment` (+ `_internal`), `agent_unallocate_tenant_payment`, `agent_reverse_tenant_allocation`, `auto_close_fully_repaid_rents`.

**Ops corrections:** `ops_edit_tenant_balance`, `ops_tenant_balance_history`, `ops_update_rent_request_amount`, `tenant_ops_correct_rent_request`, `pause_tenant_repayment`, `resume_expired_repayment_pauses`, `reopen_rent_request`, `renew_rent_request`, `return_rent_request_for_correction`, `force_approve_rejected_rent_request`, `reassign_rent_request_agent`, `replace_tenant_at_property`.

**Agent-owned:** `agent_cancel_rent_request`, `agent_delete_rejected_rent_request`, `agent_resubmit_rent_request`, `agent_set_rent_payment_status`, `agent_respond_payment_edit`, `get_agent_rent_request_capacity`, `get_agent_tenant_profile`, `get_agent_tenants_overview`, `get_agent_collections_detail`.

**Ops read/analytics:** `ops_tenant_inbox`, `ops_query_tenants`, `ops_search_tenant_rents`, `ops_tenant_behavior`, `get_tenant_behavior_segments`, `search_tenant_behavior`, `get_tenant_ops_geo_metrics`, `get_tenant_ops_agent_360`, `get_tenant_location_breakdown`, `get_tenants_at_leaf` (two overloads), `get_funded_tenants_at`, `get_rent_requests_summary`, `get_tenant_rent_summary`, `get_tenant_missed_dates` / `get_tenant_missed_days`, `get_flagged_tenants_for_transfer`, `get_tenant_ops_recipients`, `get_tenant_ops_preset_by_slug`.

**Authorisation helpers:** `is_tenant_ops_staff(_uid)` — `EXISTS` on enabled `user_roles` in `manager, operations, coo, super_admin, ceo, cfo, cto, cmo, crm, employee, hr`; `is_tenant_locked`; `is_ops_role`.

**Maintenance:** `refresh_tenant_idle_states`, `detect_tenant_phone_near_duplicates`, `backfill_receivables_summary`.

> Every RPC listed above is `SECURITY DEFINER` except `enforce_rent_request_formula`, `enforce_outstanding_total_repayment`, `enforce_rent_request_tenant_photo`, `rent_requests_outstanding_pipeline_guard` and `touch_tenant_ops_filter_preset` (invoker). **`EXECUTE` is granted to `anon` on almost all of them** — see section 15.

---

## 9. Trigger inventory

### `rent_requests`

| Trigger | Timing | Function | Effect |
|---|---|---|---|
| `trg_clamp_rent_request_amount_repaid` | BEFORE I/U | `clamp_rent_request_amount_repaid` | Clamps `amount_repaid` to `[0, total_repayment]` |
| (formula) | BEFORE I/U | `enforce_rent_request_formula` | Recomputes all four pricing columns from `compute_rent_repayment` |
| `trg_guard_rent_request_agent_updates` | BEFORE U | `guard_rent_request_agent_updates` | The anti-fraud core — see below |
| (pipeline) | BEFORE U | `rent_requests_outstanding_pipeline_guard` | Outstanding-balance short-circuit to `repaying` |
| `tr_enforce_agent_daily_eligibility` | BEFORE I | `enforce_agent_daily_eligibility` | Blocks new requests from ineligible agents |
| `trg_enforce_agent_rent_request_capacity` | BEFORE I | `enforce_agent_rent_request_capacity` | Per-agent exposure cap |
| `trg_auto_activate_outstanding_rent_request` | BEFORE I | `auto_activate_outstanding_rent_request` | Arrears fast-path |
| `trg_auto_assign_landlord_on_rent_request` | AFTER I | `auto_assign_landlord_to_agent` | Links landlord to the agent |
| `trg_auto_verify_agent` | AFTER I | `auto_verify_agent_on_rent_request` | Auto-verifies the agent |
| `trg_create_outstanding_subscription_charge` | AFTER I | `create_outstanding_subscription_charge` | Schedules arrears collection |
| `trg_credit_agent_rent_funded_bonus` | AFTER U | `credit_agent_rent_funded_bonus` | Agent bonus on funding |
| `trg_boost_tenant_credit_on_agent_rent` | AFTER U | `boost_tenant_credit_on_agent_rent` | Trust-score uplift |
| `on_rent_request_log_event` | AFTER I/U | `trigger_log_rent_request_event` | `system_events` emission |
| `trg_kyc_upgrade_from_rent_request` | AFTER | `trg_kyc_upgrade_from_rent_request` | KYC level promotion |
| Disabled (`tgenabled='D'`) | — | `notify_watchers_on_verification`, `notify_supporters_new_opportunity`, `notify_agent_landlord_registration` | Notification write-suppression policy |

**`guard_rent_request_agent_updates` in detail.** For any caller holding `agent`/`senior_agent`/`sub_agent` (and not a sensitive-field editor or manager) it:

1. Unconditionally restores `approved_by/at`, `funded_at`, `disbursed_at`, `fund_routed_at`, `fund_recipient_*`, `manager_verified*` from `OLD`.
2. Computes a **trusted allocation** only when, *in the same transaction*, a matching `general_ledger` leg exists with `source_table='agent_collections'`, `source_id=OLD.id`, `category='agent_float_used_for_rent'`, `direction='cash_out'`, `ledger_scope='wallet'`, `wallet_bucket='float'`, `recipient_type='operational_wallet'` and `xmin = txid_current()`, whose amount equals the `amount_repaid` delta, and whose resulting status equals the expected status.
3. If not trusted, `amount_repaid` and `last_payment_amount` are reverted to `OLD`.
4. Status transitions by agents are rejected (`ERRCODE 42501`) unless trusted, or moving to `pending`/`rejected`/`deleted_by_agent`, or `rejected → repaying`.

In effect: **an agent can only move money on a rent request by paying for it out of their own float in the same transaction.**

### `agent_collections`

`tr_reactivate_rent_payment_status` (AFTER I — un-flags a tenant previously marked not-paying), `trg_agent_collection_recompute_vouch` (AFTER I/U/D), `trg_detect_agent_unblock` (AFTER I), `trg_enforce_agent_full_freeze` (BEFORE I — frozen agents cannot collect).

### `house_listings` (17 triggers)

Notable: `trg_pay_tenant_placement_bonus` (BEFORE U — UGX 5,000 to the listing agent on first tenant binding), `trg_enforce_property_chain`, `trg_enforce_listing_has_landlord`, `trg_enforce_daytime_house_listing`, `trg_enforce_uganda_house_region`, `trg_house_listing_geo_point`, `trg_award_subagent_bonus_on_listing`, `trg_recruiter_override_house_verified`, `trg_receivables_summary_house_listings`.

---

## 10. Collection engine

Five collection paths converge on the same contract row:

```text
1. Agent float allocation   agent_allocate_tenant_payment  (the dominant path)
2. Offline field draft      submit-offline-collection → same RPC
3. Tenant self-service      tenant-pay-rent
4. Ops manual sweep         manual-collect-rent
5. Automatic wallet charge  auto-charge-wallets → subscription_charges/_logs
```

**`agent_allocate_tenant_payment_internal` — the canonical path.**

1. Reads float capacity **only** from `get_user_wallet_view(agent).float_balance`. `agent_landlord_float` is deliberately *not* consulted — that pool is exclusively for MoMo landlord payouts. Shortfall → `INSUFFICIENT_FLOAT`.
2. Computes outstanding from the contract; rejects `AMOUNT_EXCEEDS_OUTSTANDING`.
3. Splits commission: 10% total; 8/2 if a verified parent agent exists.
4. Posts one `create_ledger_transaction` with 4–5 legs:
   - agent `cash_out` `agent_float_used_for_rent` (wallet, float, `operational_wallet`)
   - tenant `cash_in` `rent_receivable_created` (bridge)
   - agent `cash_in` `agent_commission_earned` (wallet, `recipient_type='user'`)
   - platform `cash_out` `agent_commission_payable`
   - optional parent `cash_in` `agent_commission_earned`
5. Updates `rent_requests.amount_repaid` and advances status (`disbursed|funded|approved → repaying`; fully repaid → `completed`).
6. Inserts the `agent_collections` row with `float_before`/`float_after` and an `AGT-xxxxxxxx` tracking ID.

> Step 6 is mandatory: "today's capacity" (`paid_today`) reads **only** from `agent_collections`. Any collection path that skips this insert leaves the agent's capacity bar at zero.

**Idempotency key** is deliberately unique-per-call (`…:{epoch}:{uuid}`), so the RPC does not deduplicate — the caller (e.g. `submit-offline-collection`'s reserved row) owns replay protection.

**`record_rent_request_repayment`** is the simpler legacy path: it selects the newest `funded|disbursed|approved` request with `amount_repaid < total_repayment`, applies `LEAST(amount, outstanding)`, inserts into `repayments`, and reduces `landlords.rent_balance_due`. Note it **does not match `repaying`**, so it silently no-ops for the 590 tenancies currently in that status.

**Idleness supervision — `refresh_tenant_idle_states` (every 15 minutes).** For every `tenancy_status='active'` request in `funded|disbursed|repaying`:

- Cadence = explicit `subscription_charges.frequency`, else the median gap of the last 5 collections (≥ 4 days → weekly, else daily), else `unknown`.
- Thresholds: daily → warn 5 / at_risk 8 / reassign_ready 12 days; weekly → 10 / 15 / 20. `unknown` cadence can only reach `warn`.
- Upserts `tenant_idle_states` with sticky `warned_at` / `at_risk_at` / `reassign_ready_at` timestamps, clears `resolved_at` on recovery, and deletes rows for tenancies that are no longer active.

---

## 11. Financial interaction with the ledger

Tenant Ops never writes `general_ledger` directly; every posting goes through `create_ledger_transaction(entries jsonb, idempotency_key)` with a raw JSON array (never stringified).

**Scopes used by this module.**

| Scope | Meaning in Tenant Ops |
|---|---|
| `wallet` | Agent float spend, agent commission credit, landlord payout credit |
| `bridge` | The tenant receivable — creation (`rent_receivable_created`) and reduction (`rent_principal_collected`) |
| `platform` | Company-side legs: `rent_disbursement`, `agent_commission_payable`, `tenant_repayment`, `tenant_default_charge` |

**Category map.**

| Category | Direction / scope | Raised by |
|---|---|---|
| `rent_disbursement` | platform `cash_out` | fund-tenants, fund-tenant-from-pool, disburse-rent-to-landlord, pay-landlord-rent |
| `rent_receivable_created` | bridge `cash_in` (tenant) | all funding paths + agent allocation |
| `rent_principal_collected` | bridge `cash_out` (tenant) | `sync_collection_to_ledger` |
| `agent_float_used_for_rent` | wallet `cash_out`, bucket `float` | `agent_allocate_tenant_payment` |
| `agent_commission_earned` | wallet `cash_in`, `recipient_type='user'` | allocation, manual collect, funding bonuses |
| `agent_commission_payable` | platform `cash_out` | allocation |
| `tenant_repayment` | wallet `cash_out` / platform `cash_in` | tenant-pay-rent, manual-collect-rent |
| `tenant_default_charge` | platform `cash_in` / bridge `cash_out` | apply-rent-overdue-penalty |
| `landlord_rent_payment` | wallet `cash_in`, `recipient_type='user'` | pay-landlord-rent |
| `wallet_deposit` | wallet + platform | fund-tenant-from-pool (landlord credit) |
| `partner_funding` | wallet `cash_out` / platform `cash_in` | fund-rent-pool |

**Routing rule.** `recipient_type` is the sole bucket router: `user` → withdrawable, `operational_wallet` → float. Agent commission is always `user` (withdrawable); float spend is always `operational_wallet`.

**User-facing reads** of `general_ledger` in tenant/agent surfaces must chain `.neq('classification','admin_correction').neq('category','system_balance_correction')`.

---

## 12. State machines

### Rent request status

```text
                          ┌──────────┐
                          │ pending  │◄── agent resubmit / return for correction
                          └────┬─────┘
             reject ◄──────────┼──────────► agent_ops_approved
                               │
                     tenant_ops_approved
                               │
                    landlord_ops_approved
                               │
        normal ────────────────┴──────────── outstanding_balance
          │                                          │
      coo_approved                          (coo/funded/disbursed BLOCKED)
          │                                          │
       approved ──► funded ──► disbursed ──────► repaying
                                                     │
                              amount_repaid >= total_repayment
                                                     ▼
                                                completed

  side exits:  rejected ──(agent)──► repaying | pending | deleted_by_agent
               any ──(ops reopen)──► repaying
```

### Tenant idle state

```text
healthy ──idle≥warn_at──► warn ──idle≥risk_at──► at_risk ──idle≥ready_at──► reassign_ready
   ▲                                                                             │
   └──────────────────── a new agent_collections row ────────────────────────────┘
```

### Agent payment status

```text
(null) ──agent flags──► not_paying ──► notify-tenant-inactive (ops inbox + push + email)
   ▲                        │
   │                        └─► house freed to Priority 1, landlord link cleared
   └── new collection ──► tr_reactivate_rent_payment_status restores paying
completed_auto ◄── auto_close_fully_repaid_rents (nightly 23:00 UTC)
```

---

## 13. Tenant Ops dashboard architecture

**Mount point.** `/executive-hub?tab=tenant-ops` → `pages/ExecutiveHub.tsx` → `TenantOpsHub`. The route is wrapped in `RoleGuard allowedRoles={['ceo','cto','cmo','crm','coo','cfo','super_admin','manager','employee','operations']}`; the tab itself is gated by `useStaffPermissions().hasPermission('tenant-ops')`, a DB-driven `staff_permissions` check. `/operations` redirects single-department users straight into this tab.

**`TenantOpsHub` is a view-mode shell**, not a dashboard. It persists `mode` in `localStorage['tenant-ops-view-mode']` and renders one of three surfaces — **all three are live; none is dead code**:

| Mode | Component | Content |
|---|---|---|
| `v2` (default) | `TenantOpsDashboardV2` | Tabs: Inbox (`InboxBucketList`), Segments (`SegmentBrowser`), Search (`TenantOpsSearch`) |
| `classic` | `TenantOpsDashboard` (1,710 lines) | Legacy table view over `general_ledger`, `rent_requests`, `agent_collections`, `profiles`, `user_roles`, `landlords`; invokes `delete-user` |
| `intel` | `TenantOpsGeoCommandCenter` | Geo drill-down (district → agent) via `useTenantOpsAnalytics` → `get_tenant_ops_geo_metrics`, `get_tenant_ops_agent_360` |

Always-on chrome: `AgentInactiveAlertBanner`, `TenantPhoneDuplicatePanel`, `BehaviorDrawer`, a Welile Homes admin sheet, and a link to the Locations tab.

**Supporting panels** (`components/executive/tenant-ops/`): `TenantBalanceEditPanel` (`ops_search_tenant_rents`, `ops_edit_tenant_balance`, `ops_tenant_balance_history`), `TenantLocationBrowser` (`get_tenant_location_breakdown`), `TenantOpsAgent360Panel`, `WelileMissionBoard` (3,377 lines), plus presentational pieces (`TenantOpsFilterBar`, `TenantLocationBreadcrumbs`, `AgentNetworkBadge`, `WelileOpsCounterBand`, `ListingPhotoGallery`, `LandlordPriorityClassification`).

**Shared ops components** (`components/ops/`): `UserDrilldownDrawer` (3,807 lines — the master 3-tab drilldown across ~14 tables and ~11 RPCs), `RentHistoryVerificationQueue`, `BusinessAdvanceQueue`, `RepaymentPauseControl`, `AssignNearbyAgentDialog`, `TenantLandlordPayoutsEditor`, `TenantPhoneDuplicatePanel`, `DuplicateAccountAlert`, `LocationManager`, `WelileHomesAdminPanel`.

> **No component under `tenant-ops/` or `ops/` performs its own role check.** They all assume `ExecutiveHub`'s permission gate already ran. Any future direct mount of these components bypasses authorisation entirely.

---

## 14. Reporting and analytics

| Surface | Source |
|---|---|
| `/coo/reports/tenant-ops` (`TenantOpsReport.tsx`) | `useTenantOpsReportData()` over `rent_requests`; PDF via `lib/activeTenantsReportPdf` |
| Geo metrics | `get_tenant_ops_geo_metrics` (continent → country → region → district) |
| Agent 360 | `get_tenant_ops_agent_360` |
| Behaviour segments | `get_tenant_behavior_segments`, `search_tenant_behavior`, `ops_tenant_behavior` |
| Location rollups | `get_tenant_location_breakdown`, `get_tenants_at_leaf`, `get_funded_tenants_at` |
| Pipeline summary | `get_rent_requests_summary` |
| Missed-payment analysis | `get_tenant_missed_dates`, `get_tenant_missed_days` |
| Saved filters | `tenant_ops_filter_presets` + `get_tenant_ops_preset_by_slug` |
| Daily agent report | `agent-daily-collection-report` (20:00 EAT, in-app + SMS) |
| Fee-change watch | `rent-amount-change-notify` (email + SMS to finance watchers) |

`lib/generateTenantOpsReportPdf.ts` and `lib/generateTenantOpsExtractPdf.ts` exist but were not observed wired into `TenantOpsReport.tsx`; their call sites are most likely inside classic-mode `TenantOpsDashboard.tsx` (unverified).

---

## 15. Security model

### RLS posture

| Table | Policy shape |
|---|---|
| `rent_requests` | Tenant sees own (`auth.uid() = tenant_id`); agent sees own (`auth.uid() = agent_id`); executives (`cfo/coo/ceo/…`) see all; manager can SELECT/UPDATE/DELETE; supporters see own funded or `approved AND funded_at IS NULL`; agents may UPDATE only their own rows or unverified `pending`/`approved` rows |
| `agent_collections` | Scoped to `agent_id = auth.uid()` |
| `tenant_balance_edits` | `is_tenant_ops_staff(auth.uid())` SELECT only |
| `tenant_inactive_reviews` | `is_tenant_ops_staff` for SELECT/INSERT/UPDATE |
| `tenant_idle_states` | Own agent rows, or `agent_ops`/`coo` |
| `tenant_ops_filter_presets` | Owner ALL; shared presets readable by `is_ops_role` |
| `tenant_ratings` | Landlord CRUD on own ratings; **any signed-in user can SELECT (`USING true`)** |
| `tenant_transfers` / `tenant_replacements` | Manager/super_admin view all; agents view own |
| `house_listings` | Public read of `available`; updates restricted to agents/ops |

### Findings

**P0 — `SECURITY DEFINER` RPCs granted `EXECUTE` to `anon`.** Nearly every tenant-ops RPC carries `anon=X/postgres`, including mutating ones: `ops_edit_tenant_balance`, `tenant_ops_correct_rent_request`, `ops_update_rent_request_amount`, `pause_tenant_repayment`, `reopen_rent_request`, `force_approve_rejected_rent_request`, `replace_tenant_at_property`, `reassign_rent_request_agent`, `agent_cancel_rent_request`, `agent_delete_rejected_rent_request`. In practice they are defended only by their *internal* `auth.uid()` role checks (`is_tenant_ops_staff`, `has_role`) — which do hold, since `auth.uid()` is null for anon. The exposure is a defence-in-depth failure, not a confirmed bypass: any future RPC added to this family that forgets its internal check is immediately anonymously callable.

**P1 — `send-collection-sms` does not authenticate.** It checks only that an `Authorization` header is *present* and never calls `getUser`. Any string passes. It will read a tenant's remaining balance from `agent_collections` and dispatch SMS to arbitrary supplied numbers → SMS-cost abuse and balance disclosure.

**P1 — `register-tenant` and `generate-tenant-form-token` have no role check.** Any authenticated user (including a tenant) can create tenant accounts, landlords, LC1 records and rent requests, or mint self-registration tokens.

**P1 — `delete-rent-request` deletes `general_ledger` rows.** It removes ledger legs by `source_id` with no compensating entries, violating the append-only double-entry invariant. Manager-only, but destructive and unrecoverable.

**P2 — `submit-tenant-form` grants four roles at once.** A single public form submission provisions `tenant`, `agent`, `landlord` and `supporter` roles for the new profile, and returns auto-login credentials in the response body.

**P2 — `tenant_ratings` readable by every signed-in user.**

**P2 — Notification triggers disabled.** Three `rent_requests` notification triggers are `tgenabled='D'`; this matches the write-suppression policy but means supporter/watcher notification now depends entirely on Edge Functions.

---

## 16. Failure modes

| # | Failure | Mechanism | Impact |
|---|---|---|---|
| 1 | **Double funding** | `fund-tenants`, `fund-tenant-from-pool`, `disburse-rent-to-landlord` pass no `idempotency_key`; only a status gate protects them | Concurrent or retried calls can double-disburse and double-pay the UGX 5,000 bonus |
| 2 | **Blocked legitimate repayment** | `tenant-pay-rent` key is `tenant-pay-{id}-{amount}` with no time component | A tenant paying the same amount twice has the second payment silently deduplicated |
| 3 | **Duplicate manual collection** | `manual-collect-rent` keys only the commission leg, using a fresh timestamp | Principal can be collected twice |
| 4 | **Collection lapse alerts unbounded** | `notify-agent-collection-lapse` builds an idempotency key it never stores or checks | Repeated pushes on every cron run |
| 5 | **Duplicate reminders** | `rent-reminders` has no dedupe | Duplicate in-app notifications on double-run |
| 6 | **Legacy repayment no-op** | `record_rent_request_repayment` matches only `funded|disbursed|approved`, not `repaying` | Silently applies nothing for the 590 `repaying` tenancies |
| 7 | **Capacity bar reads zero** | Any collection path that skips the `agent_collections` insert | `paid_today` under-reports; agent eligibility misclassified |
| 8 | **Ledger drift on agent status moves** | `guard_rent_request_agent_updates` rejects untrusted transitions with `42501` | Agent-side allocation fails hard if the float leg is missing or mismatched |
| 9 | **Destructive delete** | `delete-rent-request` | Ledger legs vanish without reversal |
| 10 | **Undifferentiated errors** | `disburse-rent-to-landlord` and `transfer-tenant` return 400 for every failure | Clients cannot distinguish auth, validation and system failures |
| 11 | **Unverified-landlord block** | `approve-rent-request` 400s with `LANDLORD_NOT_VERIFIED` | Correct by design, but a common support ticket |
| 12 | **Pool liquidity block** | `fund-tenant-from-pool` refuses if pool-after-deploy < 15% of monthly obligations | Correct by design; surfaces as an opaque 400 |

---

## 17. Scheduled jobs

All active unless noted. Schedules are UTC.

| Job | Schedule (UTC) | Effect |
|---|---|---|
| `refresh-tenant-idle-states` | `*/15 * * * *` | Rebuilds `tenant_idle_states` |
| `refresh-house-location-rollup` | `*/10 * * * *` | Location rollups |
| `rent-amount-change-notify` | `*/10 * * * *` | Fee-change email/SMS to finance |
| `detect-tenant-phone-near-duplicates-hourly` | `0 * * * *` | Fraud/duplicate detection |
| `resume-expired-repayment-pauses` | `10 0 * * *` | Auto-resume paused repayments |
| `purge-rejected-listings-daily` | `15 2 * * *` | Deletes rejected listings > 14 days |
| `auto-charge-wallets-daily` | `0 6 * * *` | Executes `subscription_charges` |
| `apply-rent-overdue-penalty-daily` | `30 6 * * *` | 33% / 30-day penalty cycles |
| `notify-agent-collection-lapse-daily` | `0 6 * * *` | Push to lapsed agents |
| `pay-landlord-rent-daily` | `0 7 * * *` | Monthly landlord payouts (idempotent) |
| `agent-ops-daily-report-1800-eat` | `30 15 * * *` | Agent Ops digest |
| `auto-close-fully-repaid-rents` | `0 23 * * *` | `funded|repaying` + fully repaid → `completed` |

Related but outside the module: `agent-growth-daily-report-0700-eat`, `daily-advance-deductions`, `daily-cmo-users-report`, `daily-cto-report`, `bridge-gap-alert-notify`, `auto-reject-unmatched-deposits`.

Inactive: `check-agent-liquidity-hourly`, `cleanup-old-system-events`.

---

## 18. End-to-end diagrams

### Funding a tenancy

```text
Supporter wallet ──fund-tenants──┐
                                 ├──► create_ledger_transaction
Rent pool ──fund-tenant-from-pool┘        │
                                          ├─ platform cash_out  rent_disbursement
                                          └─ bridge   cash_in   rent_receivable_created
                                                            (tenant now owes)
                                          │
                                 rent_requests.status = funded
                                 subscription_charges row created
                                          │
                            disburse-rent-to-landlord (CFO)
                                          │
                          disbursement_records + landlord credited
                          agent bonus UGX 5,000 (agent_commission_earned)
                                          │
                                 status = disbursed → repaying
```

### A field collection

```text
Agent taps "Collect"           (or offline draft → submit-offline-collection)
        │
        ▼
agent_allocate_tenant_payment_internal
        │
        ├─ float check: get_user_wallet_view(agent).float_balance
        ├─ outstanding check: total_repayment − amount_repaid
        ├─ commission split: 10%  (8% / 2% if sub-agent)
        │
        ├─► create_ledger_transaction (4–5 legs)
        │      agent  cash_out  agent_float_used_for_rent   (wallet/float)
        │      tenant cash_in   rent_receivable_created     (bridge)
        │      agent  cash_in   agent_commission_earned     (wallet/user)
        │      plat   cash_out  agent_commission_payable    (platform)
        │      parent cash_in   agent_commission_earned     (optional)
        │
        ├─► UPDATE rent_requests  (amount_repaid, status)
        │        └─ guard_rent_request_agent_updates validates the float leg
        │           by xmin = txid_current() before allowing the write
        │
        └─► INSERT agent_collections  (float_before/after, AGT-xxxxxxxx)
                   └─ tr_reactivate_rent_payment_status clears "not paying"
                   └─ powers today's capacity bar
```

### Supervision loop

```text
every 15 min ─► refresh_tenant_idle_states
                    │  cadence = subscription frequency | median gap | unknown
                    ▼
        healthy → warn → at_risk → reassign_ready
                    │
        agent flags not_paying ─► notify-tenant-inactive
                    │                 ├─ notifications (ops recipients)
                    │                 ├─ ops_inbox_events
                    │                 ├─ push
                    │                 └─ email (operations role)
                    ▼
        Tenant Ops: reassign / transfer / replace / pause / correct balance
```

---

## 19. Risk assessment

| Rank | Risk | Severity | Evidence |
|---|---|---|---|
| 1 | `send-collection-sms` accepts any `Authorization` header without verifying it | **Critical** | Header-presence check only, no `getUser`; leaks tenant balances and burns SMS budget |
| 2 | Money-moving Edge Functions without idempotency keys | **Critical** | `fund-tenants`, `fund-tenant-from-pool`, `disburse-rent-to-landlord` |
| 3 | `anon` holds `EXECUTE` on mutating `SECURITY DEFINER` tenant-ops RPCs | **High** | Defence-in-depth failure; one missing internal check = anonymous mutation |
| 4 | `delete-rent-request` destroys `general_ledger` rows | **High** | Breaks append-only double-entry; no compensating legs |
| 5 | 177 tenancies at `reassign_ready`, 315 non-healthy of 686 | **High** | Live `tenant_idle_states` counts — an operational, not code, risk |
| 6 | `tenant-pay-rent` idempotency key blocks legitimate repeat payments | **Medium-High** | Key omits any time component |
| 7 | `register-tenant` / `generate-tenant-form-token` lack role checks | **Medium-High** | Any authenticated user can originate tenancies |
| 8 | `record_rent_request_repayment` ignores `repaying` | **Medium** | Silent no-op across 590 rows |
| 9 | `submit-tenant-form` grants 4 roles and returns credentials | **Medium** | Public, token-gated endpoint |
| 10 | No component under `ops/` or `tenant-ops/` self-authorises | **Medium** | Single point of gate failure at `ExecutiveHub` |
| 11 | Undifferentiated 400 responses in disburse/transfer | **Low-Medium** | Hampers client handling and triage |
| 12 | `notify-agent-collection-lapse` / `rent-reminders` re-notify on re-run | **Low** | Notification noise only |

---

## 20. Appendices

### A. Pricing reference

| Rent (UGX) | Days | Access fee | Reg. fee | Total | Daily |
|---|---|---|---|---|---|
| 150,000 | 30 | 49,500 | 10,000 | 209,500 | 6,984 |
| 150,000 | 60 | 115,335 | 10,000 | 275,335 | 4,589 |
| 300,000 | 30 | 99,000 | 20,000 | 419,000 | 13,967 |
| 300,000 | 90 | 405,588 | 20,000 | 725,588 | 8,063 |

*(Derived from `compute_rent_repayment`; `access_fee = ROUND(rent × (1.33^(days/30) − 1))`.)*

### B. Idle thresholds

| Cadence | warn | at_risk | reassign_ready |
|---|---|---|---|
| daily | 5 d | 8 d | 12 d |
| weekly | 10 d | 15 d | 20 d |
| unknown | 5 d | — | — |

### C. Authoritative helper functions

- `public.compute_rent_repayment(rent, days)` — the only pricing source.
- `public.is_tenant_ops_staff(uid)` — the Tenant Ops authorisation predicate.
- `public.get_user_wallet_view(uid)` — the only float-capacity source for collections.
- `public.create_ledger_transaction(entries jsonb, idempotency_key)` — the only ledger writer.
- `public.refresh_tenant_idle_states()` — the only writer of `tenant_idle_states`.

### D. Verification notes and open items

Confirmed by live query: all row counts, status distributions, trigger lists and enable-states, RPC security/ACL flags, RLS policy bodies, cron schedules, and the full source of `compute_rent_repayment`, `guard_rent_request_agent_updates`, `rent_requests_outstanding_pipeline_guard`, `enforce_rent_request_formula`, `clamp_rent_request_amount_repaid`, `auto_close_fully_repaid_rents`, `agent_allocate_tenant_payment_internal`, `ops_edit_tenant_balance`, `tenant_ops_correct_rent_request`, `is_tenant_ops_staff`, `refresh_tenant_idle_states`, `record_rent_request_repayment`, `sync_collection_to_ledger`.

Not fully traced: the internals of `auto-charge-wallets` (the executor of `subscription_charges`); the call sites of `generateTenantOpsReportPdf` / `generateTenantOpsExtractPdf`; the mount points of `TenantOpsLandlordFloatPanel` and `TenantOpsLandlordFloatTimeline`; whether `create_ledger_transaction` applies any implicit dedupe when `idempotency_key` is omitted; and whether `/coo/tenants-balances`, `/coo/rent-requests` and `/coo/rent-coverage` are guarded at the route or inside their page components.
