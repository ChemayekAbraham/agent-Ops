---
name: Tenant Placement Bounty
description: 5,000 UGX auto-bonus to the listing agent when an empty house_listings row first gets a tenant_id (any agent can be the placer); ledger-posted via credit_agent_event_bonus('tenant_placement') + trigger trg_pay_tenant_placement_bonus
type: feature
---

# Tenant Placement Bounty (UGX 5,000)

## Trigger
- **Event**: `house_listings.tenant_id` transitions NULL → not NULL.
- **DB trigger**: `trg_pay_tenant_placement_bonus` (BEFORE UPDATE on `house_listings`).
- **Idempotent**: guarded by `placement_bonus_paid_at IS NULL` AND by `commission_accrual_ledger` source_id `house_listing:<uuid>`.

## Recipient
- **Listing agent only** (`house_listings.agent_id`). The placer (whoever sets the tenant) is irrelevant — bounty always goes to the original lister.

## Money flow ("money we have → money we owe → paid out")
- Routed through `credit_agent_event_bonus(p_agent_id, 'tenant_placement', p_tenant_id, 'house_listing:<id>')`.
- Double-entry: platform `marketing_expense` cash_out ↔ wallet `agent_commission` cash_in (`recipient_type='user'` → withdrawable bucket).
- Visible immediately in agent withdrawable balance.

## UI
- `src/components/agent/EmptyHousePlacementBonusBanner.tsx` — gold/orange gradient banner shown in `FullScreenWalletSheet` for agents whenever they have ≥1 listing with `status='available' AND tenant_id IS NULL`.
- Lists up to 3 empty houses inline with share buttons (Web Share API → clipboard fallback).
- "View all empty houses" opens `AgentListingsSheet`.

## Amounts (in `credit_agent_event_bonus`)
- `tenant_placement`: 5,000
- `house_listed`: 5,000
- `tenant_replacement`: 20,000
- `subagent_registration`: 10,000
- `service_centre_setup`: 25,000
