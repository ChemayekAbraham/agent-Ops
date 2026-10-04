# Slow down the three-dot screen loader

## Why it spins so fast
The loader's speed is set by one CSS variable in `src/index.css` (`.three-body`):

- `--uib-speed: 0.8s` — the dot wobble cycle
- the whole group rotates in `--uib-speed * 2.5` = **2s per full turn**

At 0.8s the three dots wobble roughly 75 times a minute and the ring makes 30 turns a minute, which reads as frantic — especially on full-screen loaders where it is the only thing moving. Nothing in the React component drives the timing, so it is a pure styling value.

## The change
1. In `src/index.css`, raise the default `--uib-speed` from `0.8s` to `1.4s` (ring turn becomes 3.5s). Calmer, still clearly alive.
2. Add an optional `speed` prop to `src/components/common/ThreeBodyLoader.tsx` that writes `--uib-speed` inline, same pattern as the existing `size` prop, so a specific loader can be tuned without touching global CSS. Default: unset (inherits the CSS default).
3. Respect reduced motion: inside an `@media (prefers-reduced-motion: reduce)` block, slow the animations further (e.g. `--uib-speed: 2.4s`) rather than removing them, so the loader still signals activity.

No changes to loader placement, `ScreenLoader`, or any app logic.

## Technical notes
- Files touched: `src/index.css` (the `.three-body` block near the end), `src/components/common/ThreeBodyLoader.tsx`.
- Timing stays derived from the single `--uib-speed` variable, so all three dot animations and the ring rotation remain in proportion.
