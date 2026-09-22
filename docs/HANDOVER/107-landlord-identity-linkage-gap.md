# 107 — Landlord self-service is almost entirely unreachable: 108 of 58,749 landlord-role accounts have a matchable property

**Built and applied live 2026-09-22.** Before assuming `landlords.registered_by = auth.uid()` can
scope a landlord's own dashboard to their own properties — it can't, for almost everyone. And
before trusting a landlord-role account count as "how many landlords use this system" — it isn't.

## What was asked

Starting the native Android app's landlord persona dashboard, following agent and tenant. Needed
the same thing those personas got: a correct, self-scoped "my summary" data source.

## What was found

`landlords` has **no column linking a row to the landlord's own `auth.uid()`**.
`registered_by` — the only candidate — is who *entered* the row, almost always the **agent** who
registered the property, not the landlord (confirmed by migration
`20260904090000_fix_landlord_id_profiles_mismatch.sql`, which had to fix several functions that
wrongly assumed `landlords.id == profiles.id`). `useLandlordStats.ts` and `MyPropertiesSheet.tsx`
both scope by `registered_by = auth.uid()` today — meaning the web app's own landlord dashboard
already shows **0 properties** to almost every real landlord who logs in.

Checked how bad this actually is, live:

```sql
select count(*) as total_landlord_role_users,
       count(*) filter (where matched_properties > 0) as with_at_least_one_match
from (
  select p.id, count(l.id) as matched_properties
  from user_roles ur
  join profiles p on p.id = ur.user_id
  left join landlords l on regexp_replace(coalesce(l.phone,''),'\D','','g')
                          = regexp_replace(coalesce(p.phone,''),'\D','','g')
                        and regexp_replace(coalesce(p.phone,''),'\D','','g') <> ''
  where ur.role = 'landlord'
  group by p.id
) s;
```

**108 of 58,749** accounts holding the `landlord` role have even a phone-matchable `landlords` row
— 0.18%. This isn't a query bug: `landlord` is one of the roles nearly every account in this
system holds simultaneously — doc 97 found the identical pattern for the `agent` role (a
"send to all agents" broadcast turned out to mean "send to everyone," since almost every account
holds that role too) — holding the role says essentially nothing about whether someone is a real
landlord with a registered property.

## What was built

`get_my_landlord_properties()` — `SECURITY DEFINER`, no params, resolves `auth.uid()` →
`profiles.phone` → every `landlords` row whose phone matches (same digit-normalization
`find_landlord_by_phone()` already uses for duplicate-detection, generalized here to return every
match instead of just the first). Returns
`{matched_by_phone, properties: [{id, property_address, house_category, district, village,
monthly_rent, is_occupied, verified, number_of_houses, number_of_rooms, tenant_name, tenant_phone,
created_at}]}`. For the native Android app's landlord dashboard, feature 1 ("My Properties").

**Deliberately excludes payout/balance figures.** `landlords.rent_balance_due` /
`rent_last_paid_at` / `rent_last_paid_amount` exist as columns but are **stale** — the live
repayment path (`record_rent_request_repayment_v2`, called by both `tenant-pay-rent` and
`agent_allocate_tenant_payment`) never writes to them; only the older, apparently-superseded
`record_rent_request_repayment` (v1) does. Showing them would show wrong numbers. This matches the
known L4 gap (`.lovable/plan/l4-landlord-rent-payable-read-only-investigation-findings-2026-09-01.md`):
there is no ledger liability account for "rent funded but not yet paid to landlord" at all —
`agent_landlord_float_allocations` / `agent_landlord_payout` are the only currently-accurate
payout-status source (~UGX 62M open as of that doc), and neither is wired into this RPC. A future
"payout status" feature needs to read those tables specifically, not `landlords`' own stale fields
and not `get_user_wallet_view` (the web dashboard's `UnifiedWalletHeroCard` balance has **no
connection** to actual rent disbursements — payouts go to external mobile money, not the in-app
wallet).

## Verified live

- A real `landlord`-role user with a phone-matched property → correct single-property result
  (`buyunduI`, UGX 500,000/month, 6 houses, unoccupied).
- A real `landlord`-role user with no matched property → `{matched_by_phone: false, properties:
  []}`, not an error.

## What this doesn't fix

The underlying data gap (most landlord-role accounts have no discoverable link to a property) is
not fixed by this RPC — it's a *correct read* of a real gap, not a workaround for it. Closing the
gap for real would mean either back-filling a proper `landlords.owner_user_id` link when a
property is registered, or an explicit landlord self-claim flow. Neither is in scope here.
