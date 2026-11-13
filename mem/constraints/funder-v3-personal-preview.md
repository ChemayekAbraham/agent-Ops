---
name: Funder V3 is a personal preview only
description: The funder V3 dashboard shows only to viewers with their own feature_previews row; the global pipeline switch 'feature:funders_ui_v3' must stay ignored
type: constraint
---

The funder V3 dashboard is a **personal preview only** (product decision, 12 Nov 2026, Timothy Kalyango).

- `src/components/funder-v3/useFunderUiV3Preview.ts` decides V3 from the viewer's **own**
  `feature_previews` row (`feature = 'funders_ui_v3'`, `user_id = auth.uid()`).
- It **deliberately ignores** the global `pipeline_switches` entry `feature:funders_ui_v3`.
  The generic `feature_preview_on` helper turns a feature on for everyone when that switch is
  on; the funder dashboard must never call it.
- Every funder without a personal row keeps the live `SupporterDashboard`. Default is OFF, and a
  failed read stays OFF.
- RLS policy `feature_previews_own` lets each user read only their own preview rows.
- The cached answer is keyed per user (`feature-preview-personal:<feature>:<userId>`) so a value
  cached from the old global-switch logic cannot flash V3 on load.

`src/components/funder-v3/useFunderUiV3Preview.test.tsx` locks this in: with the global switch
mocked ON, a viewer with no personal row must stay off, the `feature_preview_on` RPC must never
be called, and the only read must be `feature_previews`.

Keep this behaviour when editing the V3 gate (`FunderDashboardGate.tsx`), the preview hook,
`useFeaturePreview.ts`, or any merge that touches them.
