# 143 — Financial Ops payout-destination queue is auto-approved every 10 minutes

**Date:** 2026-09-28 · **Instructed by:** Josh Wanda ("whoever is on waiting, on phone verification on Financial Ops create a cron job to run every 10 minutes it should verify automatically")
**Migration:** `supabase/migrations/20260928090000_finops_auto_approve_waiting_payout_destinations.sql`
**Status: LIVE 2026-09-28.** Josh applied it by hand; the cron is jobid 41752. The first run, at 09:30 UTC, succeeded: it verified all 6 queued rows, wrote 6 audit rows, and left the queue at 0. Claude had been blocked from applying it itself by Claude Code's auto-mode safety check, because it removes a verification control.
**Follows:** doc 136 (auto-verify rules plus a 10-minute rules sweep) and doc 137 (one-off bulk approval of 62 rows). This change makes doc 137's approval permanent.

## What changes

`finops_auto_approve_waiting_payout_destinations()` is SECURITY DEFINER, and anon/authenticated cannot execute it. Each run does two things:
1. It runs `auto_verify_waiting_payout_destinations(NULL)`, the doc-136 rules. That keeps their side effect: when the name matches, the account takes the name printed on the National ID.
2. It sets every row still in the Financial Ops queue to `verified`. The filter is the same one `finops_payout_verification_counts.waiting` uses:
   - `status = 'waiting'`,
   - ID photo and selfie on file,
   - not a portfolio funder,
   - not in `mv_identity_double_users`.

   Each row gets an `audit_logs` row, `payout_destination_queue_auto_approved`. Its `old_values` holds the prior status, reason, `decided_by` and `decided_at`.

It returns `{rule_verified, queue_verified, duplicate_id_rejected}`.

The cron job `finops-auto-approve-waiting-payout-destinations` runs `*/10`. It **replaces** `auto-verify-waiting-payout-destinations`, since step 1 already covers that job.

## What stays controlled

- **National IDs used on another account.** `trg_auto_reject_duplicate_national_id` fires on the UPDATE and rejects these rows instead of verifying them.
- **Rows without an ID photo and selfie** (about 2,700 platform-wide). They never reach the queue and are not touched.
- **Wallet withdrawals.** `enforce_withdrawal_payout_account_lock` means they still pay only to `profiles.mobile_money_number`. Changing that number goes through the Financial Ops number-change queue.

## Shared National ID with owner consent (follow-up migration `20260928180000`)

Josh: a National ID already used on another account must **not** be rejected if the owner has consented.

- **Rejection already honours consent.** `duplicate_national_id_owner()` skips any account paired with the user through `national_id_link_requests` in `owner_approved` or `active`, so `trg_auto_reject_duplicate_national_id` doesn't fire for them. On 2026-09-28, no destination was rejected for a duplicate ID.
- **The gap was this cron's queue filter.** It excluded everyone in `mv_identity_double_users`, which ignores consent. A consented user's destinations would have stayed `waiting` forever. When checked, one consented user was in the view with 0 waiting destinations.
- **The follow-up migration** lets a double through when its first account is linked to it by a consented request. `identity_double_submission()` and the view are unchanged, because other gates read them.
- **The Financial Ops count still shows these rows under "double", not "waiting".** That's a count and UI matter, left to Gemini.

## Risk accepted

With this live, **any** number added in **anyone's** name is verified within 10 minutes of the ID and selfie being on file. There is no call, SMS code, name match or face check. That includes destinations a person rejected that come back as "Resubmitted after rejection". Josh approved this knowing the tradeoff.

## Queue at the time of writing

The queue held 6 waiting rows, all from one account and all created 2026-09-13. Each is a number registered in someone else's name, and none was confirmed by SMS code. That same account is also on the unresolved cross-user duplicate TID 151772293728. The first run will verify all 6. To list them, look at the audit rows after the first run.

## Verify after applying

```sql
select jobname, schedule, active from cron.job where jobname like '%payout-destinations%';
-- expect only finops-auto-approve-waiting-payout-destinations
select public.finops_auto_approve_waiting_payout_destinations();
select count(*) from audit_logs where action_type = 'payout_destination_queue_auto_approved';
```

## Turn off / reverse

```sql
select cron.unschedule('finops-auto-approve-waiting-payout-destinations');
select cron.schedule('auto-verify-waiting-payout-destinations', '*/10 * * * *',
  $$SELECT public.auto_verify_waiting_payout_destinations(NULL)$$);
```

To reverse individual approvals, restore them from the audit rows the same way as doc 137, using `action_type = 'payout_destination_queue_auto_approved'`. Only do this on instruction, because it re-blocks those destinations.
