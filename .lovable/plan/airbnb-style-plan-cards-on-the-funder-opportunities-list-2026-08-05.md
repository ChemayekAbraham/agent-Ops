# Airbnb-style plan cards on the funder opportunities list

Restyle each fundable tenant plan card in `src/components/partner/SelfPortfolioFundingCard.tsx` to read like an Airbnb listing card. No changes to data, RPCs, selection rules, affordability logic, or wording of the financial gates.

## What the user sees

Today each plan is a dense text card: small blurred avatar, four grey label/value tiles, then footnotes. It reads like a spreadsheet row.

New layout, per plan:

```text
+--------------------------------------+
|  [house photo, 4:3, rounded]         |
|  (badge: Funded by you / On hold)    |
|                       (select circle)|
|  [small blurred tenant avatar chip]  |
|            . . . .  (photo dots)     |
+--------------------------------------+
 Kyomukama Grace              200,000
 Makindye Division, Kampala · single-room
 Landlord: Landlord
 UGX 9,200 daily · 30 days · ends 4 Sept
 (red line only when unaffordable)
```

- **Photo hero**: uses the existing `house_image_urls` field. First image fills a 4:3 rounded-2xl top block; if there are several, small dots sit at the bottom of the image like the reference. When there is no image, a soft muted placeholder with a home glyph keeps the card shape.
- **Overlays on the photo**: status pill top-left ("Funded by you", "On hold" when another partner is confirming), and the selection control moves to a round top-right control in the same spot Airbnb puts the heart. It keeps the current checkbox behaviour and disabled rules exactly.
- **Blurred tenant avatar** becomes a small rounded chip resting on the bottom-left of the photo (the reference's host badge), preserving the blur-until-funded privacy rule and the lock glyph.
- **Text block below the photo**: name on the left with the rent amount aligned right on the same line (bold, the Airbnb price position), then location · house category, then landlord, then one condensed metrics line — daily repayment · term · end date · cadence. The four grey tiles are removed in favour of this quieter single line.
- Selected state stays a primary ring plus a faint primary tint on the whole card.
- The unaffordable and held-by-other explanations keep their exact current text and destructive/muted styling, sitting under the text block.

Everything above the list (available-to-fund card, returns-this-cycle card, "Select what I can afford" row) and the sticky bottom summary bar keep their current structure and copy; only spacing/radius are nudged to match the new card rhythm.

## Technical notes

Single file edited: `src/components/partner/SelfPortfolioFundingCard.tsx`, JSX and classes only.

- `FundablePlan.house_image_urls` is already selected by `partner_self_list_fundable_plans` and currently unused in this component — it becomes the hero image source. No RPC or view change.
- Card stays `role="button"` with the same `onClick` / `onKeyDown` opening `SelfPortfolioPlanDetailSheet`; the overlay select control keeps `e.stopPropagation()`.
- `toggle`, `remaining`, `overBudget`, `unaffordable`, `heldByOther`, `isFunded`, `openDeploy` and all balance maths are untouched.
- Semantic tokens only — no hardcoded colours. Photo overlays use `bg-background/80` pills and `text-foreground`, matching existing patterns.
- Images keep `loading="lazy"`; the hero uses `object-cover` with a fixed aspect ratio so lists do not shift.

## Out of scope

No logic, balance, ledger, funding-gate, detail-sheet or deploy-dialog changes.
