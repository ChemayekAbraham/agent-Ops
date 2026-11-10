# Self-support agent facilitation fee: screens brief (for Lovable)

Owner design, 2026-11-10. The backend is built (migrations `20261112120000` to `20261112120500`) and stays **off** until the CEO switches it on. Every change below must be invisible while the switch is off.

## The rule in one paragraph

A partner who supports a tenant or an empty house themselves pays **rent + 2%** (rounded up to the nearest UGX 100). Example: a UGX 300,000 rent costs the partner **UGX 306,000**. That full amount is the partner's principal: they earn Rent profit share on 306,000 and get 306,000 back at maturity. When Partner Ops approves, 300,000 goes to the landlord float (or operational funding for an empty house) and 6,000 goes once to the partner's proxy agent. The tenant's Rent Plan and price do not change.

## What the data layer gives you

`useSelfSupportFeePolicy()` from `src/hooks/useSelfSupportFeePolicy.ts`:

| Field | Meaning |
|---|---|
| `enabled` | the switch. While `false`, `pay(rent) === rent` and `fee(rent) === 0`, so screens look exactly as today |
| `pay(rent)` | what the partner pays for that rent: rent + fee |
| `fee(rent)` | the fee part |
| `ratePct` | 2 |

The pure helpers are in `src/lib/selfSupportFee.ts` (tested). The server prices with `self_support_gross(rent)`, so `pay()` always matches what the server charges.

## Screens to change (UI only, data and rules are done)

### 1. Every amount a partner sees for a tenant plan or empty house shows `pay(rent)`

The partner sees **one** amount, labelled as today ("Rent", "Amount to support"). Totals, "you can afford / you need to top up" checks and the monthly Returns preview must all use `pay(rent)`. If the screen keeps the plain rent, the "you can afford this" check will pass and then the server will refuse with `PARTNER_FUNDS_SHORT`.

| File | Where (lines as of 2026-11-10) |
|---|---|
| `src/components/partner/SelfPortfolioFundingCard.tsx` | plan `funding_amount` and house `monthly_rent` uses: ~510, 518, 531, 663, 685, 783, 1036, 1057, 1538, 1632 (Returns preview: `monthlyReturnFor(pay(rent), rate)`), 1706 (displayed amount), 1865 |
| `src/components/supporter/FunderHouseListingsSection.tsx` | ~859 (`cost = house.monthly_rent`), ~884 (`cost = plan.funding_amount`) |
| `src/components/partner/SelfSupportHousesSection.tsx` | ~168 (Returns preview), ~171 (shortfall), ~242 (displayed rent), ~580 |
| `src/pages/SupportHouse.tsx` | ~103 (`rent` from the public offer: show and charge `pay(rent)`) |
| `src/components/funder-preview/useFunderPreviewSupport.ts` | the totals it sends to `funder_support_tenant_direct` / `partner_support_houses` (the server charges `pay()`; the preview must show the same) |
| `src/components/funder-new/*` | any per-house or per-plan amount shown to a partner |

Sorting and filtering by rent can stay on the plain rent.

### 2. The disclaimer in the house / tenant details

Show it only when `enabled` and `fee(rent) > 0`. One short line, owner-approved wording (2026-11-10). Do not show "2%" in the line.

Tenant (Rent Plan):

> **Agent Care included:** tenant checks and payment follow-up on the ground. You earn Rent profit share on the full amount.

Empty house:

> Includes **Welile Field Care:** a local agent checks this house and follows up the placement. Your full amount earns Rent profit share.

Put a small ⓘ after the line. On tap it shows the exact figure, so the amount is always there for a partner who asks: `Agent Care: UGX {fee(rent)} of UGX {pay(rent)}` (house: `Field Care: …`).

Partner earnings are called "Rent profit share" on partner screens since 2026-11-10 (lovable 894f2ac201); use the same term. Never call it "interest", the amount a "loan" or the partner a "lender". Do not call it "Cover": it pays the agent, it is not protection.

### 3. Self-support top-ups are closed while the switch is on

`src/components/partner/SelfPortfolioDeployDialog.tsx` already reads `partner_self_topup_eligibility`. While the switch is on it returns `allow_topup: false` with `block_reason`: *"Self-support portfolios are not topped up. Support more tenants or houses with a new portfolio."*

- Hide or disable the "top up this portfolio" choice when `allow_topup` is false, and show `block_reason` once.
- The dialog already falls back to "new portfolio" (line ~106). Keep that.
- Any other "Top up" button on a self-support portfolio card should follow the same flag.

### 4. Partner Ops approval: show the split

`src/components/executive/pending-vetting/CommitmentLines.tsx`: each `Line` now also has `rentAmount`, `proxyFee` and `proxyFeeStatus` (data mapping done). When `proxyFee > 0`, show under the line amount:

- `To landlord float: UGX {rentAmount}` (tenant) or `Operational funding: UGX {rentAmount}` (house)
- `Agent facilitation fee: UGX {proxyFee}`, followed by the status: `paid on approval` (pending), `paid to the proxy agent` (paid), `no proxy agent, kept as partner capital` (kept)

### 5. Agent promissory note dialog: self-support only

`src/components/agent/PromissoryNoteDialog.tsx` (~line 300 sends `support_mode`):

- While `enabled`, remove the company-managed ("existing support") choice and default to self-support. The server refuses it with `COMPANY_MANAGED_NOTES_CLOSED`. Map that message to: *"Promissory notes are self-support only. Select the tenant rent plans the partner will support."*
- The promised amount must cover `sum(pay(plan.rent))` of the attached plans (the server refuses less with `PLANS_EXCEED_AMOUNT`). Prefill or validate the amount with that total, and show the plans at `pay(rent)`.
- The RPC now returns `attached_partner_pays` (the total the partner will pay), next to `attached_amount` (rent).
- House notes and NeexaBot are unchanged.

### 6. Messages to map (if not already shown raw)

| Code | Show |
|---|---|
| `PSM_TOPUP_WINDOW_CLOSED` | the text after the colon |
| `COMPANY_MANAGED_NOTES_CLOSED` | the text after the colon |
| `PLANS_EXCEED_AMOUNT` | "The promised amount must cover the selected plans, Agent Care included." |

## Done when

- With the switch **off**, no screen changes (check a 300,000 plan: it shows 300,000).
- With the switch **on**, a 300,000 plan shows 306,000 everywhere a partner sees it, the affordability check uses 306,000, the Rent profit share preview is on 306,000, the Agent Care line shows (6,000 on tap), and the approval screen shows 300,000 + 6,000.
