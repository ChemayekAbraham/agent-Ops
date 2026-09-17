# National ID group: see who shares your ID, and unlink them

Add a button on the agent dashboard quick-action grid ("My National ID") that opens a sheet showing everyone attached to the same National ID, with the ID number masked everywhere.

## What the user sees

**Button:** a new tile beside Share Landlord / Invite & Earn / All Menu, labelled **My National ID**, with a shield icon. Tapping opens a bottom sheet.

**If the person is the owner of the ID:**
- The masked ID (e.g. `CM0******9AHJ`) and a line saying how many people are attached.
- One row per attached person showing their photo, name, phone number and email.
- Each row has a **Remove from my ID** action. Confirming asks for a short written reason, then unlinks that person immediately.

**If the person is only attached to someone else's ID:**
- The masked ID, plus a single card naming the owner: their name and phone number only. No email, no photo, no other members.

**If nobody else shares the ID:** a calm "Only you are using this National ID" state.

**When someone is removed:** they get an SMS telling them they were removed from that National ID by its owner, and the next time they open the app a dialog tells them the same thing, which they must acknowledge.

## Technical notes

**Migration (one file)**

- `national_id_group_view()` — SECURITY DEFINER, returns JSON for the caller only:
  - resolves the caller's ID group from `profiles.national_id` / `profiles.linked_national_id` using `normalize_national_id_fuzzy`;
  - owner = earliest-created profile holding that `national_id` (same FIFO rule as `duplicate_national_id_owner`);
  - `masked_nin` computed server-side (first 3 + last 4 kept); the raw NIN is never returned;
  - `is_owner` true → `members[]` with `full_name`, `phone`, `email`, `avatar_url`;
  - `is_owner` false → `owner` with `full_name` and `phone` only, and an empty `members[]`.
- `national_id_unlink_member(p_member_id uuid, p_reason text)` — SECURITY DEFINER, owner-only, requires a 10+ character reason. Clears the member's `linked_national_id` / `linked_national_id_request_id`, expires any related `national_id_link_requests` row, writes a `system_events` entry, inserts an unlink notice, and returns the member's phone plus masked NIN for the SMS.
- New table `national_id_unlink_notices` (id, user_id, nin_masked, owner_name, reason, created_at, acknowledged_at) with RLS: a user reads and acknowledges only their own rows; `GRANT` to authenticated and service_role per the standard block.
- `national_id_unlink_ack(p_id uuid)` marks a notice acknowledged.

**Edge function `national-id-unlink`** (new, JWT-verified in code via `adminClient.auth.getUser(token)`): validates the caller, calls `national_id_unlink_member`, then sends the SMS through the existing `_shared/sendSmsMultiProvider.ts` (Yoola primary, unchanged). Deployed on its own.

**Frontend**

- `src/hooks/useNationalIdGroup.ts` — query for `national_id_group_view`, mutation invoking the edge function, query + acknowledge mutation for pending unlink notices. `supabase.rpc` bound as in `useNationalIdLink.ts`.
- `src/components/national-id/NationalIdGroupSheet.tsx` — the sheet, owner and member variants, remove confirmation with reason box.
- `src/components/national-id/NationalIdUnlinkNoticeDialog.tsx` — the in-app dialog, mounted where the app already mounts global dialogs, shown when an unacknowledged notice exists.
- `src/components/dashboards/AgentDashboard.tsx` — one extra entry in the existing quick-action array plus the sheet state; no other change to that file.
- Masking is applied in the UI too, so a masked value stays masked even if the payload ever changes.
