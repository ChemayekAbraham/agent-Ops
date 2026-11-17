# 269. Expired ID-link request re-opened for Daisy Liz Nakiboneka (2026-11-13)

**Status: DONE.** Applied 2026-11-13 12:35 UTC (production version `20261113123501`). The CTO confirmed the link on 2026-11-15 11:34 UTC; it is `active`, the gate passes, and the 50,000 withdrawal is completed. CTO asked for it (option 2).

## What happened
- Daisy's UGX 50,000 withdrawal (`d0ac131b-981e-4fce-b6a3-ebf67aadfc23`, requested 8 Nov) is invisible to merchant desks: both claim attempts failed with `id_not_verified`.
- She has no ID of her own; she is linked to NSUBUGA Lawrence George's National ID. The holder approved the link by SMS code on 29 Oct.
- Nobody on staff confirmed it. After 7 days `national_id_link_expire_stale()` set it to `expired` (5 Nov 08:00). `withdrawal_user_id_verified__impl` only accepts an **active** link, and `national_id_link_staff_confirm` only accepts `owner_approved`, so it could not be completed.
- "Review" on Withdrawals waiting on ID verification opens Verify Payout Numbers, whose default Waiting filter needs ID photo + selfie. She has neither, so she looked absent.

## Change
Migration `20261113110000_reopen_expired_id_link_daisy_nakiboneka.sql` moves request `ce43daa8-ad61-42d2-b0f6-e05f2ca9afae` from `expired` to `owner_approved` with a fresh 7-day `expires_at`, only if it is still expired, holder-approved and never staff-decided. Writes one `audit_logs` row. It does not activate the link and does not touch the withdrawal or any money. Rollback: `supabase/rollbacks/20261113110000_reopen_expired_id_link_daisy_nakiboneka.rollback.sql`.

## After applying
1. FinOps opens Verify Payout Numbers; the request appears in the ID-link staff queue (`NationalIdLinkStaffQueue`).
2. Confirm it (reason of 10+ characters). `national_id_link_staff_confirm` makes the link `active` and auto-verifies her payout number.
3. The gate then passes and the 50,000 is claimable by desks again. Check her wallet still backs the hold (withdrawable was 508.88) before expecting payment.
4. Confirm within 7 days or it expires again.

## Not fixed (open, separate work)
- The expiry job also expires holder-approved requests that staff never looked at.
- Linked-ID people with no photos do not show in the default Waiting list, and Review lands on a list they are not in.
