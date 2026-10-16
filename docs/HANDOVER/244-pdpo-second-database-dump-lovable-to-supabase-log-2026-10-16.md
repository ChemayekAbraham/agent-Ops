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
- Purpose of this dump: **ANSWERED by Josh 2026-10-16: FINAL CUTOVER.** Write freeze applies.
- DPO region: **ANSWERED by Josh 2026-10-16: approved, on condition the data is kept safe.** (G1 met; the condition means dump on encrypted disk, no credentials in git/chat, rehearsal copies deleted, who held the dump logged.)
- Rehearsal: **ANSWERED by Josh: successful** (G2 met per Josh; no result file in the repo, so the baseline comparison at cutover is the real check).
- Target edge functions: **not deployed yet** (G3 open). Order decided by Josh: **move storage files first.**

## Final cutover plan (set 2026-10-16)
**Gates that must be true before the freeze starts** (any unknown blocks the freeze):
- G1. DPO has approved the target region for real data (runbook rule 0.1). **[unanswered]**
- G2. A rehearsal restore has passed the runbook section 3 verification gate. Doc 237 says the target was restored from an earlier Lovable dump, but no verification result is recorded in the repo. **[unknown: confirm or rehearse]**
- G3. Target edge functions deployed and secrets re-entered (secrets cannot be exported); target cron jobs rewritten to the target ref and left inactive until verification. **[unknown]**
- G4. Storage file copy plan ready (about 15.5 GB, 205k objects, doc 237; `storage-migration-export` is not deployed yet). **[open]**
- G5. Rollback is the untouched Lovable Cloud database: do not disconnect Cloud until the target is verified and the final export is downloaded.

**Sequence**
1. Announce the freeze window. Pause the app, scheduled jobs and webhooks on the source (done by Josh/Lovable; our `query_database` is SELECT-only and the runbook forbids production DDL from here). Inbound money feeds to note: IFTTT deposit intake, Gmail poller, SMS/mobile-money callbacks, pg_cron jobs (219). Anything arriving in the window must be replayed or reconciled after switch-over.
2. Record the source baseline (counts, ledger/wallet control totals, `auth.users`, `storage.objects`) after the freeze and before the export.
3. Josh starts the Live export (Luca's steps), downloads it, records size and SHA-256.
4. Restore by schema per the runbook (public schema, data under `session_replication_role=replica`, post-data; `auth` data only; `storage.buckets` only; cron rewritten).
5. Copy storage files; compare counts and bytes per bucket.
6. Verification gate: counts equal baseline, ledger/wallet totals match to the shilling, test sign-in with an existing password, cron count explained.
7. Link Lovable to `byrzshwlentqvktcksem`, then disconnect Cloud (final export already downloaded), enable target cron, re-enable webhooks pointing at the target, lift the freeze.
8. Post-cutover: replay/reconcile freeze-window inflows, watch for failures, document results here.

## Log
| When (2026-10-16) | Step | Result |
|---|---|---|
| (start) | Log opened. Repo docs reviewed to recover context. No commands run against source or target. | n/a |
| 2026-10-16 | Josh pasted Luca's 10-14 reply as the basis for today's work; recorded above. Next step is Josh's UI action: start the Live database export. | pending |
| 2026-10-16 | Josh confirmed this is the FINAL CUTOVER. Cutover plan and gates G1-G5 recorded above. Freeze not started. | gates open |
| 2026-10-16 | Josh: DPO approved (conditional on data safety), rehearsal successful, target edge functions not deployed, storage files move first. | recorded |
| 2026-10-16 | Read-only check of `C:\Users\USER\pdpo-rehearsal\logs\storage_*.done/.failed`: a storage copy was already run 2026-10-15 11:16 to 2026-10-16 00:54 across 23 buckets, **0 failed lines in every bucket**. Done counts: house-images 195,650; payment-proofs 5,619; identity-verification 666; partner-agreements 632; avatars 533; finops-reports 521; lc-letters 487; resumes 315; requisition-attachments 123; landlord-agreements 104; cash-deposit-receipts 89; reviews 84; merchandise 24; service-centre-photos 21; tenant-ids 13; business-advance-documents 10; budget-documents 7; task-evidence 7; email-assets 4; concern-attachments 3; food-meal-images 2; hr-documents 1; agent-receipts 1 (about 204.9k files, in line with the 204,190 `storage.objects` baseline of 10-14). Not yet done: per-bucket count and byte comparison against the source, and an incremental pass for files added after 10-16 00:54. A probe of the source function URL was blocked by the permission classifier and not retried, so whether `storage-migration-export` is still deployed on the source is unconfirmed. | copy done, unverified |
| 2026-10-16 | Josh ran `storage_copy.mjs list` on the 22 small buckets (source function is live, login works). Source counts vs copy-log "done" counts: **12 buckets match** (agent-receipts 1, budget-documents 7, business-advance-documents 10, concern-attachments 3, email-assets 4, hr-documents 1, merchandise 24, resumes 315, reviews 84, service-centre-photos 21, task-evidence 7, tenant-ids 13). **10 buckets have newer source files not yet copied, 303 files in total:** payment-proofs 5,798 vs 5,619 (+179), identity-verification 713 vs 666 (+47), requisition-attachments 163 vs 123 (+40), partner-agreements 642 vs 632 (+10), finops-reports 528 vs 521 (+7), avatars 538 vs 533 (+5), cash-deposit-receipts 94 vs 89 (+5), lc-letters 492 vs 487 (+5), food-meal-images 5 vs 2 (+3), landlord-agreements 106 vs 104 (+2). Source MB: payment-proofs 5,608.7; lc-letters 1,079.8; partner-agreements 970.9; identity-verification 665.7; avatars 421.8; landlord-agreements 272.5; resumes 217.2; requisition-attachments 91.7. `house-images` not yet counted. Target-side count (SQL on storage.objects) not yet run, so "done" means logged, not verified on target. | 303 files to catch up |
| 2026-10-16 | Target count run through the Supabase connector (read-only `select` on `storage.objects` of `byrzshwlentqvktcksem`). **Target file counts equal the copy-log "done" counts in all 23 buckets**, so the logs are trustworthy; total 204,917 files. The 12 buckets with no missing source files also match the source in MB (e.g. resumes 217.2, reviews 32.7, business-advance-documents 26.5). Target MB for the 10 behind buckets: payment-proofs 5,457.3 (source 5,608.7), lc-letters 1,068.5 (1,079.8), partner-agreements 944.6 (970.9), identity-verification 651.4 (665.7), avatars 413.5 (421.8), landlord-agreements 264.5 (272.5), requisition-attachments 70.1 (91.7). `house-images` on target: 195,650 files, 4,771.9 MB; source not yet counted. 9 of the 32 target buckets hold no objects. | catch-up copy still needed |

