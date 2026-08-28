# Fix the eye toggle on the Partner Portfolio wallet card

## Diagnosis

In `src/components/supporter/portfolio/PartnerPortfolioWalletCard.tsx`:

1. **The amount auto-hides 2 seconds after every tap** (lines 63–70). The moment you tap the eye to reveal the amount, a `setTimeout(2000)` fires and hides it again almost immediately — so it *feels* like the eye hides the amount instead of revealing it.
2. **The amount starts hidden** (`useState(false)`, line 60), so the card opens masked with `UGX ••••••` even though the eye affordance suggests the balance is the primary content.

The icon mapping itself (Eye when hidden, EyeOff when visible) is conventional; the 2-second auto-hide is what makes it behave "vice versa".

## Fix

Single file: `src/components/supporter/portfolio/PartnerPortfolioWalletCard.tsx`

- Default the amount to **visible** (`useState(true)`).
- **Remove the 2-second auto-hide timer** entirely (`hideTimeoutRef` and its `useEffect`) — the amount stays in whatever state the user chooses until they tap the eye again.
- Keep the existing toggle, icons, and `aria-label`/`aria-pressed` semantics (Eye = click to show, EyeOff = click to hide).

No data, hooks, or backend changes. UI-only.
