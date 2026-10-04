# Redesign the Auth page as a tabbed card

Goal: give `/auth` the look of the reference component (a centered card with Sign In / Sign Up tabs, social buttons at the top, an "or" divider, then the fields) while keeping every existing flow, validation, and piece of copy working exactly as today.

## What stays exactly the same

- Phone-first sign-in (country code + phone + password), one-time SMS code sign-in, email sign-in path, forgot password / forgot phone reset steps, OTP verification, signup with role pre-selection, referral and recruitment-campaign banners, archived-account support, OAuth error and environment hints, SEO head tags.
- All hooks and handlers (`useAuthForm`, `useOtpVerification`, `useAuth`, submit wrappers, device trust, attribution) are untouched.
- Existing Google and Apple sign-in buttons are reused. No `react-icons` install — the project already has proper brand-coloured buttons, and GitHub/LinkedIn logins do not exist in this backend so they are not added.

## What changes (presentation only)

1. Wrap the current column in a real card surface: `bg-card`, `border`, `rounded-2xl`, soft shadow, padding — the logo and welcome copy stay above the card.
2. Add a Tabs control at the top of the card with two triggers, Sign In and Sign Up, using the existing `@/components/ui/tabs` (already installed, so no new dependencies).
   - The tab value is bound to the existing `isSignUp` state, so switching tabs uses the same state the rest of the page already reads. Deep links such as `?signup=1`, `?become=agent`, and referral links keep landing on the right tab.
   - The tabs are hidden while a reset flow (forgot password / forgot phone) or the inline role selector is showing, so those screens stay full-focus as they are now.
3. Move the social buttons to the top of the Sign In and Sign Up panels, followed by an "or" divider, then the credential fields — matching the reference order.
4. Restyle inputs, labels, and buttons toward the reference: `rounded-lg`, lighter shadow, consistent label weight. Field heights stay large (touch targets stay at least 56px tall) because the app is used on low-end phones, and `font-size: 16px` is kept to stop iOS zoom.
5. Keep the footer cross-link ("Don't have an account? Sign Up" / "Already have an account? Sign In") but wire it to the same tab state so it and the tabs never disagree.

## Missing fields added

- Sign Up gains an explicit **Full name** label/field styling parity check (the field exists; it gets the same treatment as the reference "Name" field).
- Sign Up gains a **Confirm password** field surfaced consistently with the strength indicator (currently conditional) so the reference layout has both password rows.
- Sign In keeps **Remember this device** and **Forgot password** on one row under the password field.

Nothing is added that has no backend behind it.

## Technical notes

- One file changes: `src/pages/Auth.tsx`. No new npm packages: `@radix-ui/react-tabs`, `@radix-ui/react-slot`, and `class-variance-authority` are already dependencies, and `src/components/ui/tabs.tsx` / `label.tsx` already exist.
- No new `components/ui/auth-tabs-card.tsx` file — dropping the reference component in would duplicate the page and break the 1,388 lines of live auth logic. The reference is used as the visual target only.
- No hardcoded colour utilities; only semantic tokens (`bg-card`, `text-foreground`, `border-input`, `bg-muted`).
- The role-picker cards currently use emoji icons, which conflicts with the project's no-emoji rule. If you want, I can swap them for lucide icons in the same pass — say so and it goes in; otherwise they are left untouched.
