# Funder Dashboard — "Support Tenants Directly": Data Study (Phase 1)

**Date:** 2026-08-31 · **Status:** Read-only study, no code changes. Feeds Phase 2 planning.

## Goal

In Funder Dashboard → Capital Opportunities → **Support Tenants Directly**, the selectable list should show **houses** (empty listings) instead of tenant-bound rent requests. The house dataset must mirror the rent-requests dataset so the existing funding pipeline (`funder_support_tenant_direct`, commitments, landlord-float release) can consume it — the only structural difference being that **no tenant is attached yet**.

---

## 1. The two datasets

### A. Current list — `rent_requests` (tenant-bound)

| Field group | Columns | Notes |
|---|---|---|
| Identity | `id`, `tenant_id`, `agent_id`, `landlord_id`, `lc1_id` | Tenant + guarantor chain already known |
| Money | `rent_amount`, `duration_days`, `daily_repayment`, `total_repayment`, `access_fee`, `request_fee`, `amount_repaid` | Full repayment math already computed |
| Pipeline | `status`, `tenant_ops_reviewed_*`, `landlord_ops_reviewed_*`, `coo_reviewed_*`, `cfo_reviewed_*`, `partner_ops_comment` | Multi-stage approval chain (COO → CFO) |
| Funding | `supporter_id`, `funded_at`, `disbursed_at`, `fund_recipient_*`, `payout_*` | Where the money went |
| Property | `house_category`, `house_image_urls[]`, `request_latitude/longitude`, `request_city`, `request_country` | Location + photos |
| Verification | `agent_verified*`, `manager_verified*`, `landlord_called`, `landlord_acknowledged` | Field verification trail |

**Fetch path today:** server-side RPC pages joined with tenant/agent/landlord names (see `partner_ops_list_rent_requests` pattern in `usePartnerOpsRentQueue`). **Consume path:** selected `rent_request_ids[]` → `funder_support_tenant_direct(p_rent_request_ids, p_promised_deposit_date, p_term_months)` → capacity check (`funder_support_capacity` = strict withdrawable + float) → `psm_confirm_commitment_for` → `psm_disburse_landlord_float` onto the tenant's agent landlord float. Shortfall files a `landlord_float_receivables` row with mandatory promised deposit date.

### B. Target list — `house_listings` (empty houses, no tenant)

Already served to funders by two read paths:

1. **`agent_list_empty_house_opportunities`** RPC (SECURITY DEFINER, supporters allowed) — server-side pagination, search, district, verified-only, GPS-only, rent range, radius-around-point filters. Returns per house: `house_id`, `title`, `house_category`, `monthly_rent`, `district`, `sub_county`, `village`, `region`, `number_of_rooms`, `verified`, `listing_agent_id/name`, `image_urls[]`, `latitude/longitude`, `landlord_id`, `landlord_name` + phone.
2. **`empty_house_opportunity_summary`** RPC — aggregates (house count, total rent needed, avg monthly rent, funded vs listed, per-district/per-landlord breakdown) powering the Major Opportunity card.
3. `FunderDirectHouseListing.tsx` — direct `house_listings` select filtered to `status='available' AND tenant_id IS NULL AND verified AND has images`.

**Eligibility predicates (the "available & fundable" gate):**
- `status = 'available'`
- `tenant_id IS NULL`  ← *the key difference: no tenant attached*
- `is_hidden = false`
- `monthly_rent > 0`
- no `promissory_note_house_intents` row with `status = 'reserved'` (exclusivity lock)

---

## 2. Field mapping — rent request → house

| Rent request field | House-listing equivalent | Gap |
|---|---|---|
| `rent_amount` (per term) | `monthly_rent` | Term math (`duration_days`, `daily_repayment`, `total_repayment`) must be **derived** at selection time — houses don't carry it |
| `house_category` | `house_category` | 1:1 |
| `house_image_urls[]` | `image_urls[]` | 1:1 (rename only) |
| `request_latitude/longitude` | `latitude/longitude` | 1:1 |
| `request_city` | `district` / `sub_county` / `village` | 1:1-ish, richer on houses |
| `agent_id` (collecting agent) | `agent_id` (listing agent) | 1:1 — this is where the placement bonus + landlord float attach |
| `landlord_id` | `landlord_id` | 1:1 |
| `tenant_id`, tenant name/phone | — | **Absent by design.** No tenant until placement |
| `status` (approval chain) | `verified` boolean only | Houses have **no ops review chain** — `verified` is the whole gate |
| `supporter_id`, funding fields | — | Created at funding time |
| repayment progress fields | — | N/A pre-placement |

**Conclusion:** the user's intuition is correct — the house list is the same "shape" of opportunity (category, rent, location, photos, agent, landlord, verification flag) with the tenant block missing. Everything the funder needs to *choose* is present; everything the pipeline needs to *execute* (term math, repayment schedule, tenant identity) is produced later.

---

## 3. Fetch & consume contract for Phase 2

**Fetch (list page):**
- Reuse `agent_list_empty_house_opportunities` (already supporter-authorised, paginated, filterable) rather than a new query — one round trip per page, server-side total.
- Show per-card: photos, category, monthly rent, district/village, verified badge, landlord name (phone behind the detail sheet — already built as `EmptyHouseDetailSheet`).
- Sort/filter parity with rent-request list: search, district, verified-only, rent range, distance.

**Consume (funding):** two candidate paths, to be decided in Phase 2:

1. **Create a rent-request-shaped shell** — on selection, generate a tenant-less rent request (or a new `house_funding_intents` row) carrying the derived term math, then run it through the *existing* `funder_support_tenant_direct` machinery unchanged. Lowest risk: reuses capacity guard, commitment RPC, ledger legs, receivables shortfall path.
2. **House-native funding RPC** — `funder_support_house_direct(p_house_ids, ...)` that posts commitment + reserves the houses (`promissory_note_house_intents.status='reserved'`) and releases to the listing agent's landlord float, skipping the rent-request table until a tenant is placed.

**Open questions for Phase 2:**
- Term math source: fixed product term (e.g. 12-month note at 15% annual — existing empty-house messaging) vs derived daily-repayment schedule like rent requests?
- Reservation semantics: does selecting a house lock it (`promissory_note_house_intents`) immediately or only on CFO disbursement?
- Approval chain: houses lack tenant-ops/landlord-ops review — does Partner Ops → COO → CFO still apply, or a shorter chain since no tenant risk exists yet?
- Shortfall path: reuse `landlord_float_receivables` (keyed on rent request) or a house-keyed receivable?
- Placement handoff: when a tenant is later placed into a funded house, which rows link the funding to the new rent request (`house_assignment_audit` already tracks assignment + bonus)?

---

## 4. What is NOT changing

- `rent_requests` table, its approval chain, and `funder_support_tenant_direct` remain the tenant-bound path.
- Wallet/ledger posting rules (recipient_type routing, strict withdrawable gate, capacity = withdrawable + float) are untouched.
- This document is study-only; Phase 2 planning starts from §3's open questions.
