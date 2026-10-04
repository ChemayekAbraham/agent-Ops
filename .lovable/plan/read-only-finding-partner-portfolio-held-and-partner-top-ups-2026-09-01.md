# Read-only finding: Partner Portfolio Held and Partner Top-Ups Awaiting Application are neither Landlord Float line

No code or database changes were made. This document records the evidence and, if you want it, the only change worth making.

## Conclusion

Neither balance belongs under Landlord Float — Company Managed or Landlord Float — Self Managed.

- **Partner Portfolio Capital Held (L2)** is partner capital the company holds and must return. It is a non-current partner obligation, not a landlord payable.
- **Partner Top-Ups Awaiting Application (L6)** is partner cash received but not yet applied to a portfolio — short-term custody, also a partner obligation.

Landlord Float (L4, "Landlord Rent Payable") is a different obligation with a different counterparty: rent owed onward to a landlord. Partner capital only becomes landlord float after it is deployed into a rent plan and a landlord payable is raised; at that point the L4 legs already carry it. Reclassifying L2 or L6 into either Landlord Float line would count the same money twice and would state a landlord as creditor where the creditor is a partner.

## Who holds, controls and deploys — the test you asked for

| | Holds the cash | Decides deployment | Landlord is creditor? |
|---|---|---|---|
| Partner Portfolio Capital Held (L2) | Company | Company (Partner Ops / COO / CFO fund rent plans) | No — partner is |
| Partner Top-Ups Awaiting Application (L6) | Company | Nobody yet — undeployed, awaiting manual application to a portfolio | No — partner is |
| Landlord Float (L4) | Agent float / company pending payout | Field disbursement against a specific tenancy | Yes |

Self-managed partner funding (`partner_self_commitments`, `partner_supported_houses`) is the one case where the partner picks the plans and houses. That still does not make it landlord float: the balance is partner capital and the self/managed distinction there is about who selects the deployment, not who is owed. It is currently tiny — one active commitment of UGX 600,000 and one pending of UGX 300,000.

## Evidence trail

Source of truth is `general_ledger`, resolved to the reporting chart by `sofp_ledger_legs(as_at)` and totalled by `get_statement_of_financial_position`. Presentation grouping is `src/components/cfo/balanceSheetClassification.ts`.

1. `ledger_account_catalog`: `L2 = "Partner Portfolios — Capital Held"` (non_current_liability), `L6 = "Partner Top-Ups Awaiting Application"` (current_liability), `L4 = "Landlord Rent Payable"` (current_liability). Three separate accounts, two separate sections.
2. `ledger_account_map` routes to L2 only `platform.partner_funding`, `bridge.partner_funding`, `platform.roi_reinvestment`, `bridge.supporter_facilitation_capital`; to L6 only `platform.pending_portfolio_topup`. No landlord category maps to either.
3. `balanceSheetClassification.ts` already places both under `PARTNER_LIABILITY_CATEGORIES`, deliberately outside the Marketplace block that carries Landlord Float, and the file's own comment says so. Landlord Float appears in `MARKETPLACE_LIABILITY_CATEGORIES` and is split for presentation only by `expandLandlordFloat`.
4. `get_landlord_float_management_split` splits L4 by the landlord record's `landlords.is_agent_managed` flag, applied proportionally so the two lines foot to the reported L4 total. It reads L4 legs only and never touches L2 or L6.
5. Directional ledger position (production + legacy_real not filtered in this quick read, so treat as indicative): L2 credits ≈ UGX 6.94bn in, ≈ UGX 0.30bn out; L6 ≈ UGX 2.42bn in, ≈ UGX 2.32bn out, i.e. roughly UGX 97m still awaiting application. Sub-ledger comparators already exist in the statement's memo block: `investor_portfolios` against L2, `landlord_payouts` against L4.

## One real defect found while tracing this

`ledger_account_map` has **no row mapping any category to L4**, and no rule in `sofp_ledger_legs` assigns L4 either. The landlord payout categories that exist (`platform.agent_landlord_payout` ≈ UGX 17.46m out, `wallet.agent_landlord_payout` float legs) fall through to the wallet/suspense defaults. Consequently:

- the reported Landlord Float line is not being fed by the landlord payout legs, and
- `get_landlord_float_management_split` returns total 0, so `expandLandlordFloat` shows a 0% self-managed share and puts the whole line under Company Managed by residual.

Also worth knowing before anyone leans on that split: `landlords.is_agent_managed` is `false` for 46,011 of 46,016 rows, so the flag as it stands would classify almost the entire landlord book as Self Managed the moment L4 starts receiving legs.

## Proposed follow-up (only if you want it)

1. Leave L2 and L6 exactly where they are. No reclassification.
2. Investigate and then map the landlord payout categories to L4 in `ledger_account_map`, so Landlord Float is actually sourced and the Company/Self split has legs to divide.
3. Decide whether `is_agent_managed` is the right flag for the split, or whether "company managed" should be derived from the funding path (company capital vs `partner_self_*` self-support) instead.

Each of those is a separate instruction; nothing here has been changed.
