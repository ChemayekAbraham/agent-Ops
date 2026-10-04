---
name: Careers / Job Applications
description: Public /careers job application form + priority panel on Company Staff dashboard
type: feature
---
Public `/careers` page (src/pages/Careers.tsx) lets anyone apply for jobs (categories: developer [100+], sales [1000+], marketing, operations, other). WhatsApp number and email fields are visually highlighted. Linked from Agent Menu Drawer "More" section under "Internship Program" via "Apply for a Job" -> /careers.

Data goes to `job_applications` table (anon INSERT allowed via RLS; staff roles manager/super_admin/coo/hr/cto/operations/ceo can SELECT + UPDATE). Fields: full_name, whatsapp_number, email, category, role_interest, experience_level, portfolio_url, location, cover_note, status (new/contacted), contacted_by, contacted_at.

Surfaced as a priority panel (JobApplicationsPanel) at the top of the Company Staff dashboard (/admin/users). Staff contact via WhatsApp (wa.me link) or email (mailto cc info@welile.com). New-count priority badge.

Applicant status workflow (pipeline): new -> contacted -> interviewing -> hired (+ rejected). Each card has a dropdown to change status (sets contacted_by/contacted_at when moving off "new"). Panel has status pipeline filter tabs with per-status counts, a category filter, and sort options (newest, oldest, name A-Z, pipeline stage). Status is stored in the free-text job_applications.status column (no enum/schema change).

Auto-reply email: on submit (when applicant provided an email) Careers.tsx invokes `send-transactional-email` with template `job-application-received` (transactional-email-templates/job-application-received.tsx). Sent from `Welile <info@welile.com>` (default From for non-partnership templates). Best-effort, idempotency key `job-application-received-<application_id>`; never blocks the success screen. WhatsApp contact buttons on staff cards open wa.me with local 07XX numbers normalized to 256 + a prefilled greeting.

Communication log: new `job_application_communications` table (application_id FK -> job_applications ON DELETE CASCADE, channel whatsapp|email CHECK, message text, logged_by uuid, created_at; same 7 staff roles for select/insert/update/delete via RLS). `ApplicantCommsLog` component per card: contact buttons (WhatsApp/email) auto-record a log entry on click; a "Log (n)" toggle reveals a note textarea ("Log WhatsApp note"/"Log email note") + timestamped history (channel badge, message, delete). First logged contact auto-bumps status new -> contacted via onFirstContact. Phone normalization/validation lives in src/lib/whatsapp.ts (normalizeWa, isValidWaNumber, waLink).

Share & UTM click analytics: The Company Staff page (`src/pages/admin/Users.tsx`) header has a `ShareCareersLink` button (native share on mobile; otherwise a dialog with copy + one-tap share to WhatsApp/Facebook/X/LinkedIn/Telegram/Email). Every shared link points to `/careers` tagged `utm_medium=share&utm_campaign=careers` with a per-platform `utm_source` (whatsapp, facebook, twitter, linkedin, telegram, email, copy, native_share). Careers.tsx reads UTM params on mount, logs one anonymous click per session to `career_link_clicks` (id, utm_source/medium/campaign, referrer, landing_path, created_at; anon INSERT, staff SELECT via has_role — same 7 staff roles), and stamps `utm_source/medium/campaign` onto the `job_applications` row on submit. `CareersAnalyticsPanel` (top of Users page) aggregates clicks vs sign-ups per source with conversion %, so staff see which platform drives sign-ups.
