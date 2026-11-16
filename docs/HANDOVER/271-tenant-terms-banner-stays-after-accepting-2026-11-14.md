# 271 — "You must accept Terms" stays on screen after the tenant accepts

**Date:** 2026-11-14 · **Asked by:** Josh (CTO) · **Status:** code change on `dev/financial-ops`, tests pass, **NOT PUSHED, NOT LIVE.** Frontend only.

## What was asked

The test tenant (0761658253, MUSA ABDU) accepted the Tenant Agreement, but the amber "You must accept Terms to continue. Accept now" banner stayed on the tenant home.

## What was found

- The acceptance **was saved**: `tenant_agreement_acceptance` has one `v1.0` / `accepted` row at 10:22 UTC. It is a display bug only.
- `useTenantAgreement` kept its own `useState` per caller. The banner (`TenantAgreementNotice`), the agreement pop-up in `TenantDashboard` and `TenantAgreementButton` / `LegalSection` each called it, so accepting in the pop-up set only the pop-up's copy. The banner kept its "not accepted" copy until a reload.
- Tenants accepted again because of it: of 10,657 tenants with a `v1.0` acceptance, **234 accepted more than once, one 19 times** (10,954 rows).

## Fix

`src/hooks/useTenantAgreement.ts`: one shared answer per account (a small store read with `useSyncExternalStore`). Every caller reads the same entry, a first load is shared, and accepting updates all of them at once, so the banner disappears immediately. If the account has already accepted, `acceptAgreement` returns success without saving another row. The return shape is unchanged.

## Tested

`src/hooks/useTenantAgreement.test.tsx` (3): the banner disappears as soon as a separate component accepts; a second tap saves nothing; a tenant who accepted before sees no banner. `vitest related` on the hook: the only failures (RoleGating, SettingsName, AuthSignupName) fail the same way before this change.

## Not changed

- The existing duplicate acceptance rows are left as they are (the newest one is what counts).
- `acceptAgreement` still looks up the tenant's IP address through the outside service `api.ipify.org`. Worth reviewing for privacy separately.
