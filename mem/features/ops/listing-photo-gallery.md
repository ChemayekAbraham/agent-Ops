---
name: Listing Photo Gallery (Airbnb/Booking pattern)
description: Multi-photo-per-listing child table + ops/agent gallery manager surfaced in the Welile Operations Empty Houses drill-down
type: feature
---
Airbnb/Booking.com-style photo management for `house_listings`. Binaries live in the existing public `house-images` storage bucket (optimized client-side to 1200px WebP via `optimizeImage`); the DB stores only keys/URLs.

Canonical source of truth = `listing_photos` child table (id, listing_id FK→house_listings ON DELETE CASCADE, storage_path, position, is_cover, uploaded_by, timestamps). `house_listings.image_urls` is kept in sync automatically by trigger `trg_listing_photos_sync` → `sync_house_listing_image_urls(listing)` (array ordered by is_cover DESC, position ASC). Do NOT write image_urls directly anymore — write `listing_photos` and let the trigger rebuild it. Existing image_urls were backfilled into the table.

Triggers: `trg_listing_photos_before_insert` auto-assigns position (max+1) and auto-covers the first photo; `trg_listing_photos_event` emits a `system_event` of type `listing_photo_added` (new enum value) per upload (trust/activity trail). Backfill was done with all three triggers disabled to avoid using the new enum value in the same txn.

RLS: SELECT public (true; granted to anon+authenticated). INSERT/UPDATE/DELETE allowed to `is_ops_role(auth.uid())` OR the listing's own `agent_id`.

Frontend: hook `useListingPhotos(listingId, enabled)` + `useListingPhotoActions(listingId)` (upload/remove/setCover/swap) in `src/hooks/useListingPhotos.ts`. Component `src/components/executive/tenant-ops/ListingPhotoGallery.tsx` — lazy-loaded thumbnail strip (StorageImage + loading="lazy"), camera/gallery add, set cover, reorder (swap left/right), delete, lightbox. Rendered per row in `WelileMissionBoard.tsx` EmptyHousesDialog behind a per-row "Manage photos" toggle (`photosOpen` Set).
