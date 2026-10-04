---
name: Daytime-only house listing window
description: Agents/sub-agents can only insert into house_listings between 6 AM and 6 PM EAT; ops/managers bypass. Enforced server-side + friendly client dialog.
type: feature
---

# Daytime-only house listing

**Window:** 06:00 – 18:00 EAT (Africa/Kampala). Outside this window, agent-initiated listings are refused so photos/GPS are captured in daylight.

**Server enforcement** — `enforce_daytime_house_listing()` fires as `BEFORE INSERT` trigger `trg_enforce_daytime_house_listing` on `public.house_listings`. It:
- Bypasses when `auth.uid()` is null (edge fn / service_role / system).
- Bypasses when the caller has any of: `manager, admin, super_admin, ceo, cfo, cto, coo, cmo, tenant_ops, landlord_ops, agent_ops, financial_ops, partner_ops, crm, hr`.
- Enforces only when the caller holds `agent`, `sub_agent`, or `senior_agent`.
- Raises `check_violation` with a plain-English message.

**Client enforcement** — `src/lib/listingHours.ts` exports `isListingDaytime()`, `getEatHour()`, `LISTING_NIGHT_MESSAGE`, `LISTING_HOURS_LABEL`. `ListEmptyHouseDialog` short-circuits `handleSubmit` at night with a toast and shows a persistent amber banner at the top of the dialog so agents know before filling anything.

**Adjusting the window** — edit `LISTING_OPEN_HOUR_EAT`/`LISTING_CLOSE_HOUR_EAT` in `src/lib/listingHours.ts` and the two integer comparisons in the trigger function. Ops-bypass roles are hard-coded in the trigger's `IN (...)` list.