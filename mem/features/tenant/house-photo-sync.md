---
name: House photo two-way sync
description: Agent photo updates on house_listings propagate to the tenant's rent_requests.house_image_urls (and back), via DB triggers
type: feature
---

# House photo sync (agent ↔ tenant)

Tenant-facing house photos live in two places: `house_listings.image_urls` (browse/listing surfaces)
and the snapshot `rent_requests.house_image_urls` (tenant's own house / ops / supporter surfaces).
Agents edit whichever screen they are on, so both are kept in sync by DB triggers (2026-08-27):

- `trg_sync_rent_request_images_from_listing` — AFTER UPDATE OF `image_urls` ON `house_listings`
  → `sync_rent_request_images_from_listing()`
- `trg_sync_listing_images_from_rent_request` — AFTER UPDATE OF `house_image_urls` ON `rent_requests`
  → `sync_listing_images_from_rent_request()`

Matching: `rent_requests.house_listing_id = listing.id` OR `listing.tenant_id = rent_requests.tenant_id`
(the `house_listing_id` link is set on very few rows, so the tenant_id path carries most cases).

Rules: empty/null photo arrays never overwrite existing photos; `rejected`, `deleted_by_agent` and
`cancelled` rent records are skipped; recursion guarded with `pg_trigger_depth() < 2`. Both functions are
SECURITY DEFINER with EXECUTE revoked from anon/authenticated/PUBLIC (trigger-only). A one-time backfill
aligned all previously diverged rows.

Do not "fix" stale tenant photos by adding client-side copy logic — the triggers own this.
