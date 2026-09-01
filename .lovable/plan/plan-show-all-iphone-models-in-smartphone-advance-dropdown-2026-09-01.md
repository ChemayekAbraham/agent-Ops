# Plan: Show all iPhone models in Smartphone Advance dropdown

## Goal
In the agent Smartphone Advance order dialog, the iPhone dropdown currently hides any model priced above the agent's eligibility cap. List every iPhone model from XR through the latest (17 Pro Max) in release order, without capping by price.

## Current state
- The catalog already contains all iPhone models XR → 17 Pro Max (`supabase/migrations/20260901220020_*.sql`).
- `SmartphoneOrderDialog.tsx` computes `options` by filtering active catalog entries, then applying `cap <= 0 || default_amount <= cap`, then `os_type === osType`.
- Because most iPhones exceed the typical UGX 1,000,000 agent ceiling, only a subset appears.

## Changes
1. **Remove the price-cap filter for iOS options** in `SmartphoneOrderDialog.tsx`.
   - Android options remain capped by eligibility so agents cannot order unaffordable Android devices.
   - iPhone options show every active priced model regardless of the agent's `max_amount`.
2. **Preserve release-order sorting**. The existing `sortCatalogEntries`/`IPHONE_RELEASE_ORDER` logic in `SmartphoneCatalogDialog.tsx` orders iOS models chronologically; the dialog consumes the same sorted catalog.
3. **Keep the "no open application" gate and document checkbox** unchanged so submission flow remains guarded.

## Outcome
Agents switching to the iPhone tab will see the full XR → 17 Pro Max lineup, ordered from oldest to newest, even if their current eligibility cap is lower than the phone price.
