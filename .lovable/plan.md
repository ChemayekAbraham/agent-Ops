# Agent verification KYC redesign

## Scope
The requested GitHub commit `66401ccc97` is already an ancestor of the current workspace. Redesign only the agent verification page; preserve all existing data, verification rules, actions, applicability redirects and enforcement. Leave Agent Ops, dashboard banners and blocked-action dialogs unchanged.

## Experience
- First-time introduction with requirements, five-minute estimate and privacy note.
- Seven-step mobile wizard: Contact, Where you stay, Live location, Identity document, Selfie/passport photo, Next of kin, Review and submit.
- Resume at the first unfinished checklist step; completed steps remain accessible. Sticky Back/Continue controls and a compact progress bar.
- KYC document framing/tips and face guide, preserving existing photo capture and parent-ID approval flows.
- Review summaries with Edit links, confirmed contact badges, masked NIN and photo thumbnail. Missing submission requirements appear immediately in a visible dialog with step links.
- Dedicated in-review, verified and action-needed screens; verified edits retain the existing confirmation.

## Technical details
Use the existing hook and checklist helpers without editing them. Keep local wizard navigation separate from server-owned completion. Preserve code challenges when navigating between steps and keep current save handlers. Record the presentation boundary in the existing architecture notes.

## Verification
Run focused existing verification tests and new navigation/action regression tests; rely on the automatic compiler rather than running a separate typecheck. Check layouts at 360px, 375px and desktop, including the global small-screen padding override. Live signed-in end-to-end verification is unavailable with this project's externally managed Supabase; report that limitation separately from isolated checks. No deployment or publishing.