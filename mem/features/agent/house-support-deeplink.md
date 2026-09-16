---
name: Shared empty-house self-support deep link
description: Agent/proxy-agent house share links resolve to a public support page that carries agent attribution through auth into the existing partner_support_houses flow
type: feature
---
Agents/proxy agents share verified empty houses from `ProxySupportOpportunities.tsx`.

- Share link = `get_or_create_house_share_link(p_house_id)` → row in the existing
  `short_links` (`resource_type='house_support'`, `resource_id=house_id`,
  `user_id` = sharing agent = **the only attribution source**, `target_path='/support-house'`,
  `target_params={s:code}`). Public URL `welileapp.com/s/<code>` → `TrackedRedirect` →
  `/support-house?s=<code>`. Never build a second share architecture for houses.
- Public page `src/pages/SupportHouse.tsx` (unauthenticated route) reads
  `public_house_support_offer(p_code)` (anon EXECUTE, single round trip, public fields only,
  computed `availability`: available / supported / reserved / unavailable).
- "Support This House" when signed out: `saveHouseSupportIntent` writes
  `localStorage.welile_house_support_intent` (24h) + `sessionStorage.welile_post_auth_redirect`
  and sends the visitor to `/auth?redirect=/support-house?s=<code>&role=supporter`; on return the
  page reopens the confirm step automatically.
- Support itself always goes through the existing `partner_support_houses` RPC (advisory lock +
  server-side revalidation of availability, agreement and float). No duplicate support/payment
  engine, no client-side availability decisions.
- Funnel: `log_house_support_share_event(code, event, commitment_id, user_agent)` — anon-executable,
  resolves the sharer server-side into `house_support_share_events`. Events: opened,
  visit_location_clicked, support_clicked, auth_started, signup_completed, support_started,
  support_completed. `house_share_performance()` feeds the agent dashboard strip.
- Visit House uses `house_listings.latitude/longitude` via Google Maps search URL; hidden when
  coordinates are missing. Share description is plain text with exactly one URL and no emojis.
