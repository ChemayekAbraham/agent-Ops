---
name: House Walkthrough Video (external link)
description: Agents attach a short YouTube/Google Drive walkthrough video link to a house listing; played inline on the public detail page
type: feature
---
Agents can add a **short (≤30s) walkthrough video** to a house listing. To stay lean at 40M+ scale we do NOT store video binaries — only an external link in `house_listings.video_url` (column already existed; previously unused).

- Helper: `src/lib/houseVideoUrl.ts` — `parseHouseVideo(raw)` validates & returns `{ provider: 'youtube'|'google_drive', embedUrl, watchUrl }`. Accepts youtu.be, youtube.com (watch/shorts/embed), and drive.google.com (/file/d/<id>/, open?id=). Unsupported links -> null. YouTube embeds via youtube-nocookie.com/embed/<id>; Drive via /file/d/<id>/preview.
- Edit UI: EditHouseListingDialog.tsx has a "Walkthrough video (optional)" URL field with live validation (invalid blocks save).
- Display: HouseDetail.tsx (public /house/:id) renders an inline 16:9 lazy iframe + "Open on YouTube/Drive" link, placed after the Description section. HouseListing type gained video_url?: string | null.
