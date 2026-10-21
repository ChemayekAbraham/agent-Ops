# 244a. Messages for Lovable (Luca) and the Supabase team, PDPO cutover (2026-10-17)

Drafts only, not sent. Appendix to doc 244. No keys, tokens or passwords in either message. Facts were read from the source and the `origin/lovable` checkout on 2026-10-17.

## A. Reply to Luca (Lovable support), same thread

**Subject: Re: Full database dump and moving to our own Supabase project: urgent questions before cutover tonight**

Hi Luca,

Thanks again for the walkthrough. We are cutting over to our own Supabase project (`byrzshwlentqvktcksem`) in the next few hours. The database, 205k storage files and all 405 edge functions are already copied. Before we link and disconnect Lovable Cloud we need to know what happens to the services our edge functions reach **through Lovable's gateways**. Project `43e6c2e1-18a6-4503-badb-5bb6c23491cc`.

Our functions call these Lovable-hosted endpoints, using `LOVABLE_API_KEY` and per-connector keys:
- `connector-gateway.lovable.dev/google_mail` (our deposit intake reads a Gmail inbox through it, every minute; money-critical)
- `connector-gateway.lovable.dev/twilio` (SMS and OTP: password reset, payout OTPs; money-critical)
- `ai.gateway.lovable.dev` (payout-proof and ID image checks, receipt scanning)
- `connector-gateway.lovable.dev` for Google Drive, Google Search Console, Semrush and Inngest (not money-critical)

1. **After we disconnect Cloud and link our own Supabase project, do `LOVABLE_API_KEY` and the connector keys keep working for edge functions running on our project?** If yes, how do we obtain the values (they are not visible to us today), and do they stay valid permanently?
2. If **no**, what is the supported way to keep these connectors, or the official way to move them to our own credentials? We can switch Gmail to Google's API directly and Twilio to our own Twilio account, but we need to know whether the gateway keys die at disconnect or at some later point, so we can order the work.
3. **Edge functions after linking:** does Lovable deploy functions to our Supabase project on each publish? Would it overwrite the 405 we already deployed, and which side is the source of truth?
4. **Secrets:** do Lovable-managed secrets carry over to our project, or must we set them in the Supabase dashboard? Are the Cloud secrets deleted when we disconnect?
5. **Cron and extensions:** does Lovable touch `pg_cron` jobs or extensions (`pg_net`, `pgmq`, `supabase_vault`) on our project after linking? We recreate 221 cron jobs ourselves and do not want them removed.
6. **Rollback:** after disconnecting, is the Cloud database kept intact (apart from the export files), and for how long? Can we re-link to Cloud if we find a problem?
7. **Auth:** we carry over `auth.users` and `auth.identities` (97,510 users, password hashes). Is there anything in the Lovable-managed auth setup (redirect URLs, providers, email templates, SMS/OTP hooks) we must recreate by hand?

Questions 1 and 2 decide whether we can switch tonight; if you can only answer those two quickly, please do. We will not disconnect Cloud until they are clear.

Thanks,
Josh

## B. Brief for the Supabase team

**Subject: Migration into our own project `byrzshwlentqvktcksem`: what we are moving and where we want your guidance**

**Who and why.** We run Welile, a rent-financing platform in Uganda, and its backend has lived on a Lovable Cloud-managed Supabase database. A data-protection requirement (PDPO) obliges us to hold the data in our own account. Region has been approved by our DPO. We are cutting over within hours and would value a review of the points below. Target project: `byrzshwlentqvktcksem`.

**What we are moving (measured on the source, 2026-10-17)**
- Postgres 17.6, **7.0 GB**, 898 tables in `public`, about 2,900 functions, RLS throughout.
- Extensions in use: pg_cron, pg_net, pg_stat_statements, pg_trgm, pgcrypto, **pgmq**, **postgis**, supabase_vault, uuid-ossp.
- **Auth:** 97,510 users with password hashes (`auth.users`, `auth.identities`), password and phone/OTP sign-in.
- **Storage:** 32 buckets, about 205k objects, 15.5 GB (one bucket has 195k images). Already copied through the Storage API, policies restored.
- **Edge functions:** 405 deployed; roughly 60 secrets to be set by hand.
- **pg_cron:** 221 jobs (212 active), calling edge functions through `pg_net`; 3 run every few seconds, 4 every minute. Created inactive on the target and switched on at cutover.

**How we are restoring.** Not a whole-dump restore over Supabase's schemas: `public` schema, then data with `session_replication_role=replica` (so history is not re-triggered; this is a ledger system), then post-data; `auth` as data only; `storage.buckets` only with objects uploaded via API; cron recreated from the dump's `cron.job` rows with the project ref and anon key rewritten.

**Where we would like your guidance**
1. **Sizing:** compute add-on and connection pooler settings for this workload (7 GB, ledger writes, 97k users, jobs every few seconds). What would you start with?
2. **Auth restore:** any known problems restoring `auth.users` / `auth.identities` data-only with password hashes into a project on your current GoTrue version (new columns, `instance_id`, identities `email` generated column, MFA tables)? Any recommended order?
3. **pg_cron / pg_net at this rate:** any limits on `net.http_post` throughput or the `net._http_response` table we should plan for?
4. **Edge function deploys:** we deployed 405 with `supabase functions deploy --use-api --jobs 10`; one function (an 82 KB bundle) returned a transient `500 Function deploy failed due to an internal error` and succeeded on retry. Any bundle-size or concurrency limits, and a recommended method for deploying this many?
5. **Database-level settings:** some of our functions read `current_setting('app.settings.service_role_key')`, which a one-database `pg_dump` does not carry. We are moving them to `vault`. Is that the approach you recommend?
6. **Storage:** throughput limits or best practice for a bucket of 195k small objects (we copy with signed URLs and `x-upsert`).
7. **Backups and PITR:** which plan and add-ons give point-in-time recovery for a ledger database, and is it in the same region as the project?
8. **Cutover support:** can someone be on standby during our window (early morning, East Africa Time, 2026-10-17) in case the restore or the `auth` load hits a platform-side issue?

**Not asking you for:** Gmail, Twilio or AI connectors. Those were provided to us by Lovable's gateway and we are handling them separately.

Thank you; happy to share the restore runbook and the exact commands.
Josh Wanda, Welile

## C. Reply to Lovable support's answers (drafted 2026-10-17, not sent)

**Subject: Re: Full database dump and moving to our own Supabase project: follow-ups before we disconnect**

Hi team,

Thank you, this is very clear, and the correction in point 5 changes our plan. Status: the final export is downloaded and checked, and the restore into `byrzshwlentqvktcksem` is under way (data loaded, indexes building). Six follow-ups, in order of importance:

1. **Connector keys at first deploy.** Please confirm exactly which secrets Lovable copies into our Supabase project: we need `LOVABLE_API_KEY`, `GOOGLE_MAIL_API_KEY`, `GOOGLE_DRIVE_API_KEY`, `GOOGLE_API_KEY`, and also the other connector keys our functions use (`TWILIO_API_KEY`, `SEMRUSH_API_KEY`, `INNGEST_API_KEY`, `LINKEDIN_API_KEY`; our SMS/OTP sending goes through the Twilio connector). Does the copy happen at link time, or only on the first edit that touches an edge function? If it needs an edit, what is the smallest safe edit you recommend, given that we must restore `config.toml` first?
2. **config.toml.** We have saved ours (109 functions with `verify_jwt = false`) and will restore it right after linking and before any other edit. Please confirm Lovable will not reset it again on later edits or publishes, and that a redeploy of all functions from our restored file gives the same `verify_jwt` behaviour we had on Cloud.
3. **Auth email hook.** Our `auth-email-hook` function verifies Lovable-signed webhooks (`@lovable.dev/webhooks-js`, `x-lovable-signature` headers), enqueues into our `auth_emails` queue, and our own function `process-email-queue` delivers through our Mailgun account. Since Cloud's built-in auth email does not carry over: what will call this hook on our own project? Supabase Auth's Send Email hook signs differently, so this function would reject it. Is there a Lovable-supported way to keep it working, or should we switch Supabase Auth to custom SMTP (Mailgun) in the dashboard and disable the hook?
4. **Order of disconnect and link.** Since disconnecting Cloud cannot be undone, can we link our Supabase project first, while Cloud is still connected, verify everything, and only then disconnect? If linking requires disconnecting first, please confirm that, and whether anything besides `config.toml` is written or reset in our project at link time.
5. **Safety net.** After disconnect the Cloud database is paused, not deleted. For how long is it retained, and is there any support path to recover data (for example Storage objects) if we missed something? We have copied all 205k storage files and hold the final database export, but we want to know what exists beyond that.

6. **Google and Apple sign-in.** Our app signs in with Google and Apple through the Lovable OAuth broker (`@lovable.dev/cloud-auth-js`, `lovable.auth.signInWithOAuth`). 1,516 of our users have no password and rely on it. After we link our own Supabase project, does the managed broker keep working for it, with Google and Apple enabled for us? If not, we will configure the Google and Apple providers on our own project with our own OAuth credentials and call Supabase directly; please confirm that is the supported route and whether the redirect allow-list is still involved.

We will not disconnect until our restore is verified against the frozen source. A reply on points 1, 3 and 4 before about 06:00 East Africa Time would help us most.

Thanks,
Josh
