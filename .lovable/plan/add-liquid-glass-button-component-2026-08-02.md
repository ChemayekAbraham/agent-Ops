# Add Liquid Glass button component

Add the pasted component as a new file at `src/components/ui/liquid-glass-button.tsx`. Dependencies (`@radix-ui/react-slot`, `class-variance-authority`) are already installed — nothing to install.

## What gets added

- `LiquidButton` — transparent button with a glass distortion effect (SVG turbulence/displacement filter), size variants up to `xxl`.
- `GlassFilter` — the inline SVG filter that powers the glass distortion.
- `MetalButton` — brushed-metal button with 6 color variants (default, primary, success, error, gold, bronze), press/hover states and a shine sweep.

## Notes on the paste

The pasted snippet arrived with all JSX markup stripped out (empty returns, broken generic type params, `export` before declaration). It will be reconstructed into working TSX with the same variants, class strings, styles and behaviour.

Two deliberate deviations:

1. **No `Button` re-export.** The paste also redefines a `Button` + `buttonVariants`, which would duplicate/conflict with the existing `src/components/ui/button.tsx` used across the app. The new file will export only `LiquidButton`, `liquidbuttonVariants`, `GlassFilter` and `MetalButton`.
2. **Tailwind v3 compatibility.** The snippet uses Tailwind v4-only utilities (`bg-linear-to-t`, `inset-shadow-2xs`). Those live in the discarded `cool` variant, so nothing v4-specific ends up in the file; `LiquidButton`/`MetalButton` classes are all v3-valid.

Hardcoded hex colors in `MetalButton` are kept as-is since the metal gradients are the component's identity, not themeable surfaces.

## Scope

One new file only. No existing component, page or dashboard is changed — nothing is wired into the tenant dashboard or the selected "Find a House Nearby" button unless you ask for that next.
