---
name: Proxy Payout Settlements
description: Stale-record-proof flow for proxy partner ROI display and withdrawal — partner-aggregated cards driven by v_user_wallet_strict + proxy_payout_settlements audit table
type: feature
---

**Goal.** Eliminate stale entries in the agent's Proxy Partners list. Source of truth is the ledger (`v_user_wallet_strict`); audit trail is `proxy_payout_settlements`.

**Table `proxy_payout_settlements`** (created 2026-05-14):
- `id`, `approval_id` UNIQUE (→ `pending_wallet_operations.id`), `withdrawal_id`, `partner_id`, `agent_id`, `amount_settled`, `settled_at`, `notes`, `created_at`.
- RLS: agents see own; partners see own; manager/CFO see all. Indexes on `(agent_id, partner_id)` and `(withdrawal_id)`.
- Backfill: 239 historical CFO-approved payouts whose partner strict withdrawable ≤ UGX 50 were inserted as settled.

**Edge fn `approve-withdrawal`.** After `status=completed`, when `proxy_partner_id` (or legacy `linked_party`) is present:

**Settlement-coverage gap fixed (2026-06-17).** The settlement step USED to recompute the partner locally as `proxy_partner_id || (linked_party≠user_id)`. Custody-V2 partner-owned rows (`user_id = partner`, no `linked_party`) and auto-routed partner withdrawals resolved to NULL there, so a delivered withdrawal wrote NO settlement row → the approval stayed "open" forever. Symptom: paid partners kept reappearing in the agent's Proxy Partners list AND each new monthly ROI approval STACKED on top of the unretired (already-paid) ones, ballooning card totals ("abnormal increase"). For one agent, 235 completed proxy withdrawals had no settlement and ~90% (UGX 32.9M of 36.5M) of the "owed" total had actually already been paid. Fix: the settlement step now REUSES the partner already resolved by the main pipeline (`proxyPartnerId` / `beneficiaryUserId`, which covers auto-routed + partner-owned rows). A one-time idempotent backfill (`DO $$` migration) FIFO-closed every delivered (`completed`/`approved`/`fin_ops_approved`) proxy withdrawal lacking a settlement against the partner's CFO-approved unsettled ROI approvals (newest-first), self-scoped to proxy/managed partners only. **Rule: every delivered proxy withdrawal MUST produce a settlement row; if you add a new completion path (not just approve-withdrawal), it must write settlements too.**

**Two-stage lifecycle (clarified 2026-06-10).** CFO approval ONLY puts the partner's ROI card onto the proxy list (`pending_wallet_operations.status='approved'` + `coo_approved_by`). The withdrawal itself is approved by **FinOps**, which runs `approve-withdrawal` → flips the request to `completed` → inserts the settlement row → card disappears. FinOps approval is the SOLE completion event. A FinOps-**rejected** withdrawal writes no settlement, so the card correctly persists (ROI returned, re-request needed). If a partner was paid in cash OFF-system, the only way to retire the card is a manual `proxy_payout_settlements` insert (force-settle) — no ledger/wallet movement occurs, so use only when CFO confirms the cash payout.

1. Fetch CFO-approved `pending_wallet_operations` (`category='roi_payout'`, `status='approved'`, `metadata.coo_approved_by IS NOT NULL`, `source_id` matches partner portfolios).
2. Exclude any `approval_id` already in `proxy_payout_settlements`.
3. FIFO-walk by `created_at ASC`, sum up to withdrawal amount.
4. INSERT one settlement row per consumed approval (last partial approval also stamped settled — splits out of scope).
5. For managed-proxy ROI, debit `agent_id` / resolved proxy agent only. The partner wallet is never a funding source; it is only the beneficiary/linked party for audit and settlement.

**Frontend `ProxyPartnerFunds.tsx`.**
- One card per partner (NOT per approval). Amount = `v_user_wallet_strict.available`.
- Settlement-aware filter is the SOLE source of truth — drop any approval whose `id` exists in `proxy_payout_settlements`.
- **Chunked settlement lookup (2026-06-17 fix).** The settlement filter MUST chunk the `approval_id` lookup (batches of 100) instead of one giant `.in(rawOps.map(id))`. High-volume agents (e.g. Kabahuma Lillian — 589 CFO-approved approvals, 576 already settled) overflow the PostgREST URL length when every id is crammed into a single `.in(...)`; the request fails, `settledRows` returns empty, NO approval gets filtered, and hundreds of already-PAID partners flood back into the queue ("she has 300+, most paid but back in the queue"). On any chunk error the loader MUST bail (toast + return) rather than fall through to showing every approval as owed. NOTE: filtering by `agent_id` alone is NOT a substitute — ~33% of settlements covering an agent's approvals carry a different/legacy `agent_id`, so the canonical key remains `approval_id`.
- **Managed-proxy visibility (2026-06-01 fix).** For `is_managed_account=true` partners, ROI lives in the AGENT's wallet so the partner's own strict withdrawable is always 0. The per-card visibility ceiling MUST be the approved (historical-open) ROI amount the partner is OWED — NOT the agent's current wallet balance and NOT a shared agent-wallet FIFO budget. The previous shared-budget clamp silently hid every CFO/COO-approved partner once the owed total exceeded what the agent currently held (e.g. 81.6M owed across 37 partners vs 5.6M agent withdrawable → only the newest few appeared). The agent-wallet limit is real but is enforced at withdrawal time by the strict ledger gate / `approve-withdrawal`, never by dropping an approved partner from the list.
- Hide partners with strict available ≤ UGX 50 (dust threshold).
- Optimistic submit lock via `submittingPartnerIds` set populated on `handleWithdrawSuccess`, cleared after 5s — button disabled + spinner.
- Realtime channel on `proxy_payout_settlements` INSERT (scoped to agent_id) → refetch.

**Invariants.**
- Only approvals carrying `metadata.cfo_approved_by` surface a card. COO-only does not.
- **Proxy delivery drains BOTH buckets (2026-07-07).** A merchant agent settling a proxy partner delivery (`acting_as_merchant=true`, non-pool-funded) debits the proxy agent's wallet (funding leg, `fundingUserId`) AND consumes the merchant's own `float_balance` via the `agent_float_settlement` leg — because the merchant physically dispenses company cash from their float. The merchant-float pre-check + consume in `approve-withdrawal` therefore apply to proxy payouts (only `poolFunded` stays excluded, since it debits float in the main block). Consequence: a proxy delivery larger than the merchant's available float is blocked (`INSUFFICIENT_MERCHANT_FLOAT`) until the CFO/treasury tops up their float. Do not re-add a `!isProxyPayout` guard to those two blocks.
- `approval_id` UNIQUE — an approval can only be settled once.
- Settlement is out-of-band; original `pending_wallet_operations` audit trail preserved.
- Wallet writes still go through `apply_wallet_movement` only.
- Partner credit follows Wallet Routing v2: `recipient_type='user'` → withdrawable bucket.
- Managed-proxy partner ROI follows proxy-custody routing: CFO/COO-approved ROI wallet legs credit the proxy agent's withdrawable wallet with `linked_party=partner_id`; the partner wallet/dashboard must not show that ROI as withdrawable.
- Managed-proxy ROI is full-amount only. Do not split ROI into partial cash/reinvestment for managed proxy partners.
- Proxy custody v2 cutoff still enforced; legacy `linked_party` rows pre-cutoff drained via the same edge fn branch.
- **Amount-aware settlement filter (2026-06-17).** The frontend settlement filter selects `approval_id, amount_settled` and drops an approval ONLY when its summed `amount_settled` fully covers the approved amount (`settled >= amount - 1` dust). A PARTIALLY-settled approval (FIFO backfill consumed only part of it) stays in the queue and its displayed owed amount is reduced by the settled portion (`opsByPartner` subtracts `settledByApproval[op.id]`). The old boolean "any settlement row exists → drop" hid every residual, so a partner whose 12,954,560 ROI was only 7,520,000 settled vanished as "fully paid" while 5,434,560 was still owed. After the fix the queue ties to CFO records: `Σ CFO approved = Σ amount_settled (paid) + Σ residual (in queue)` (verified for Kabahuma Lillian on 17 Jun: 27,299,152 = 17,375,592 + 9,923,560).

**Do not.**
- Do not render per-approval cards.
- Do not derive the displayed amount from approval rows or wallet cache — only from `v_user_wallet_strict`.
- Do not bypass the settlement insert in `approve-withdrawal` for proxy withdrawals.
- Do not delete settlement rows to "re-show" a partner — issue a fresh CFO approval instead.

**Backfill chronology bug fixed (2026-06-17 v3).** The one-time FIFO backfill (migration `20260617115158`) walked a partner's unsettled approvals `ORDER BY pwo.created_at DESC` (newest-first) when closing delivered withdrawals. For partners whose OLD withdrawals had no settlement row yet, the backfill applied those OLD, already-accounted withdrawals to the partner's NEWEST approvals — including fresh current-date CFO approvals the old withdrawal could not possibly have paid. The amount-aware filter then subtracted those phantom settlements, so current approvals displayed LESS than the CFO approved (THE GREAT MARRIEDS: 5,000,000 approved today shown as 2,000,000 because a 2026-04-17 withdrawal was wrongly applied). Migration `20260617125340` deleted the 25 chronologically-impossible rows (`notes ILIKE 'Backfill: retroactive FIFO%' AND withdrawal.created_at < approval.created_at`, ~30.6M total). **Rule for any future retroactive settlement backfill: match a withdrawal only to approvals that already existed at the withdrawal's delivery time (`approval.created_at <= withdrawal.created_at`), and FIFO oldest-approval-first — never DESC. A withdrawal can never settle an approval created after it.**

**Files.**
- Migration `supabase/migrations/20260514091255_*.sql`
- `supabase/functions/approve-withdrawal/index.ts`
- `src/components/agent/ProxyPartnerFunds.tsx`

**User docs.** `/mnt/documents/Proxy_Partner_Money_Flow_v2.pdf` + `/mnt/documents/Proxy_Money_Flow_Chart.pdf`.
