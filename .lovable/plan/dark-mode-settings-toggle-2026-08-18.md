# Dark mode + settings toggle

## Feasibility: high — most of the wiring already exists

Confirmed already in place:
- `tailwind.config.ts` has `darkMode: ["class"]`.
- `src/critical.css` defines a full `.dark` token block (background, card, primary, border, chart colours, glass, sidebar) alongside `:root`.
- `next-themes` is installed and `<ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>` already wraps the app in `src/App.tsx`.
- `src/components/ThemeToggle.tsx` exists (Light / Dark / System dropdown) and is already mounted in Settings → "Look" tab under a "Dark / Light" row, plus several marketplace pages.

So dark mode technically switches today. What's missing is a clean toggle UX and, mainly, screens that ignore the tokens.

The real work: 104 component files use hardcoded colours that don't flip with the theme — 699 `text-white`, 331 `bg-white`, 72 `bg-black`, plus `text-gray-*`, `bg-slate-*` and literal hexes (`#9234EA`, `#6c11d4`, `#25D366`). On those screens dark mode currently produces white-on-white or black-on-black patches.

## What I'll build

### 1. Toggle UX in Settings (small)
- Replace the dropdown row in Settings → Look with an explicit, labelled control: a Light / Dark segmented switch (System as a third option) showing the active mode, sun/moon icon, and a one-line description.
- Enable `enableSystem` and keep `defaultTheme="system"` only if you want OS-following; otherwise default light. Persistence is automatic via next-themes `localStorage` (`theme` key).
- Add a small no-flash inline script + `suppressHydrationWarning` so the saved theme is applied before first paint (avoids a white flash on reload in dark mode).
- Update the `<meta name="theme-color">` handling so the mobile browser chrome matches the chosen theme rather than the OS preference.

### 2. Token cleanup, phased by screen priority
Convert hardcoded utilities to semantic tokens (`bg-background`, `bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`/`text-primary-foreground`, `text-success`, `bg-brand`-style tokens for the purple/WhatsApp-green hexes; new tokens added to `:root` + `.dark` where none exist).

- Phase A — shared shells and primitives: app headers/nav, sheets/dialog wrappers, `elevated-card`/`glass-card` consumers, wallet cards, KPI cards.
- Phase B — the dashboards you use daily: Partner/Funder, Agent, Tenant.
- Phase C — ops/exec dashboards: CFO, FinOps, Partner Ops, Tenant Ops, HR/Recruitment.
- Phase D — marketing/marketplace and long-tail pages.

Intentional exceptions kept as fixed colours: gradient hero cards that are brand-purple by design (e.g. the partner portfolio wallet card), PDF/print and share-image renderers (Canvas/PDF output must stay light), and status badges that already have `.dark` overrides in `index.css`.

### 3. Verification
- Per phase, screenshot the touched screens in both themes headlessly and fix contrast issues.
- Typecheck after each phase.

## Scope notes
- No backend, ledger, RLS or business-logic changes. Presentation only.
- Theme preference stays device-local (localStorage); no DB column unless you want it synced across devices — say so and I'll add it to profile preferences.
- Recommend doing Phase 1 + Phase A/B first so dark mode is genuinely usable on your main screens, then Phase C/D as follow-ups.
