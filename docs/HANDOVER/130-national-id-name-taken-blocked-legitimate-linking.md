# 130 — `national_id_name_taken` blocked the entire ID-linking flow

**Fixed and applied live 2026-09-24.** Before touching `IdentityPhotoCapture.tsx`'s
`nameTaken`/`handleSave` gate or `national_id_name_taken()` again — the entire
"link this account to someone else's National ID" flow
([[project_subagent_withdraws_via_parent_linked_national_id]]) was unreachable via the UI
whenever the requester correctly typed the name exactly as printed on the ID they were
borrowing/linking to, which is required by definition.

## What was happening

Reported live: an operator trying to register a sub-agent (Shafeeq Ssenabulya's own real
National ID, `CM057538794671`) hit a hard red "THIS NAME IS ALREADY TAKEN — enter your own
real names" box and the Continue button stayed disabled no matter what.

Two independent checks exist in `IdentityPhotoCapture.tsx`:
1. A **live pre-submit check** (`national_id_name_taken` RPC, debounced on typing) that only
   compares the typed name against `profiles.national_id_name`/`full_name` of every OTHER
   account that has a National ID on file — it never looked at the NIN also being typed.
   `nameTaken` state from this check both (a) disables the Continue button (line ~1883:
   `disabled={... || nameTaken}`) and (b) short-circuits `handleSave()` with an early
   `return` (line ~1179) before it ever calls the real submit RPC.
2. The **actual submit** (`submit_national_id_details` RPC) which correctly checks the NIN
   first via `duplicate_national_id_owner()` — if the NIN exactly matches an existing
   account's NIN, it returns `duplicate: true` and routes into the proper
   "request to link, pending the holder's approval" flow instead of a hard refusal.

Since check #1 gates the button and the submit handler both, check #2 was never reached in
the exact case it was designed to be reached — typing a real person's real name AND their
real NIN to link to their existing account. Every legitimate linking attempt died here
before submission was possible.

## Fix

`national_id_name_taken(p_name, p_user_id, p_nin)` now takes an optional `p_nin` and only
flags a collision when the matching name-holder's National ID does **not** match the NIN
being typed (fuzzy-normalized via `normalize_national_id_fuzzy()`, the same comparison
`submit_national_id_details()` already uses for its own duplicate-NIN check) — i.e. the
same-NIN linking case is no longer treated as a name collision at all, and falls through to
the submit RPC's correct link-offer path. Backward compatible: `p_nin` defaults to `NULL`,
which preserves the old (name-only) behavior for any caller that doesn't pass it.

`IdentityPhotoCapture.tsx` now passes `p_nin: form.nin || null` on the live check and added
`form.nin` to that effect's dependency array, so it re-evaluates as the NIN field is typed.

Verified live against the real case:
```sql
select national_id_name_taken('SHAFEEQ SSENABULYA', NULL, 'CM057538794671'); -- taken: false (was true)
select national_id_name_taken('SHAFEEQ SSENABULYA', NULL, 'CM999999999999'); -- taken: true  (genuine collision, unchanged)
select national_id_name_taken('SHAFEEQ SSENABULYA', NULL, NULL);             -- taken: true  (old callers, unchanged)
```

Applied directly to production (`mcp__lovable__query_database`) and recorded in migration
`20260924181000_national_id_name_taken_respects_matching_nin.sql` — this function was not
previously tracked in `supabase/migrations/` at all
([[project_repo_migrations_diverge_from_production]]).

## Not touched

The genuine name-theft case (same name, genuinely different/made-up NIN) still hard-blocks
exactly as before — only the same-NIN linking case changed. Did not touch
`submit_national_id_details()` itself; its duplicate-NIN handling was already correct, it
just could never be reached from the UI for this scenario.
