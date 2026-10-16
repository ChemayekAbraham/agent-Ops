# 244. PDPO migration: second Lovable -> Supabase Postgres dump (running log, 2026-10-16)

**Status: STARTED, NOTHING RUN YET.** This is a running log. Every step taken, command run and decision made is appended below with its result. Nothing here has touched the source or the target yet.

## Context (recovered from the repo; the session that started this was cleared)
- Source: Lovable Cloud database, ref `wirntoujqoyjobfhyelc` (Lovable project `43e6c2e1-18a6-4503-badb-5bb6c23491cc`). Read-only for us.
- Target: `byrzshwlentqvktcksem` (our own Supabase account). Restored once already from an earlier Lovable dump (doc 237). 32 storage buckets and 89 `storage.objects` policies are in place; the storage file copy (about 15.5 GB, 205k objects) was written but not run.
- Procedure: `docs/PDPO_RESTORE_RUNBOOK_2026-10-14.md` (draft). Related: doc 237, doc 224 (full-table backup), doc 05 (disaster recovery).
- Runbook rules that apply to this dump: never restore a full dump over Supabase (split by schema); `auth` data only; only `storage.buckets`, not `storage.objects`; rewrite cron commands that mention the source ref; load with `session_replication_role=replica` so the ledger is not re-posted; do not disconnect Cloud until the target is verified; credentials never in chat, git or shell history; the DPO has not approved the target region, so no real data until they do.

## Basis for today: Lovable support reply (Luca, Wed 2026-10-14 09:55, pasted by Josh 2026-10-16)
Josh decided today's work follows this reply. What it says:
1. **Full dump, self-serve.** More -> Cloud -> Overview -> Advanced settings -> Export project data -> Export on the Database card -> **Live** environment -> Start export. Lovable emails when ready; the file lands in the project's Cloud storage; download from More -> Cloud -> Storage. It is a full-database `pg_dump` with no schema filters: schema, functions, triggers, RLS, data, `auth.users` and `auth.identities` (with password hashes), and the storage metadata tables. `pg_cron` definitions *should* be included: check `cron.job` after the rehearsal restore and recreate any missing.
2. **Consistency / write freeze.** The dump is one consistent snapshot, so writes during export do not corrupt it, but writes after the export starts are not in it. For the cutover: pause the app, scheduled jobs and webhooks, then request the final export.
3. **Storage files.** Download per bucket from More -> Cloud -> Storage, upload to the matching bucket on the target.
4. **Secrets** cannot be exported; re-enter them on the target.
5. **Switch-over.** After everything is copied and verified: disconnect Lovable Cloud (download the export first, exports in Cloud storage are deleted with it), connect our Supabase account in Lovable, select `byrzshwlentqvktcksem`. From then on the app reads and writes only the target. Walkthrough: https://docs.lovable.dev/tips-tricks/external-deployment-hosting

How it lines up with the runbook (`PDPO_RESTORE_RUNBOOK_2026-10-14.md`): the reply matches it. Points that still need care and are not changed by the reply: restore by schema, not the whole dump over Supabase's own schemas; `auth` as data only; `storage.objects` is metadata, so files go through the Storage API; rewrite cron commands containing the source ref; the Live export is production data (personal data plus password hashes), so keep it off the repo, on an encrypted disk.

## Open questions (to fill in)
- Purpose of this dump: fresh rehearsal / final cutover with write freeze / redo of a failed restore? **[unanswered]**
- Does the target currently hold real data, and has the DPO approved the region? **[unanswered]**

## Log
| When (2026-10-16) | Step | Result |
|---|---|---|
| (start) | Log opened. Repo docs reviewed to recover context. No commands run against source or target. | n/a |
| 2026-10-16 | Josh pasted Luca's 10-14 reply as the basis for today's work; recorded above. Next step is Josh's UI action: start the Live database export. | pending |
