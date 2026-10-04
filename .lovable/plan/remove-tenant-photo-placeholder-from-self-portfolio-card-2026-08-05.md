# Remove tenant photo placeholder from Self Portfolio card

## What we will do
Remove the privacy-blurred tenant photo placeholder from the bottom-left corner of each Self Portfolio funding card, since the selected image should no longer be rendered.

## Scope
- Edit exactly one file: `src/components/partner/SelfPortfolioFundingCard.tsx`.

## Steps
1. Delete the entire placeholder block (lines 344-360): the absolute-positioned container, the privacy comment, the inner wrapper, and the `<img>` element.
2. Remove the now-unused import `tenantPhotoPlaceholder` at line 11.
3. Trim the component header comment (lines 49-54) so it no longer claims the avatar is blurred; keep the remaining privacy notes about first-name-only and no contact details.

## Out of scope
- No changes to data fetching, privacy rules, or other cards.
- No replacement image or icon.
