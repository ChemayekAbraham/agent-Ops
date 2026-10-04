# Runbook: MoMo feed silent (> 2 hours)

**Alert:** No MTN MoMo / Airtel Money receipt email has been ingested into
`gmail_transactions` for more than 2 hours.

**Impact:** Agent float deposits will NOT auto-credit to wallets. Deposit
requests stay pending until FinOps links them manually.

## The pipeline

1. Customer pays the Welile merchant code.
2. MTN/Airtel sends an SMS to the merchant SIM phone.
3. IFTTT (or an SMS-forwarder app) on that phone emails the SMS to the Welile Gmail inbox.
4. `gmail-poll-transactions` edge function polls Gmail every 2 minutes and inserts a `gmail_transactions` row.
5. TID (or phone) match approves the matching `deposit_requests` row.
6. Ledger legs post and `apply_wallet_movement` credits the wallet.

Silence for > 2h almost always means step 2 or 3 broke — not the poller.

## Triage steps

1. **Check the poller first.** FinOps → Email Transactions. If `gmail_poll_state.last_status`
   is not `ok`, or a `gmail_auth_failure` alert exists, reconnect the Google Mail
   connector in Workspace → Connectors (scope `gmail.readonly`).
2. **Check the merchant phone.** Is it powered on, charged and on data?
   Battery optimisation frequently kills the IFTTT / forwarder app.
3. **Check IFTTT web → Applet Activity log** for skipped or errored runs
   (free-tier applet run limits, or a blocked Google sign-in).
4. **Check Gmail Spam / Promotions** for `action@ifttt.com` mail.
5. **Check Google security alerts** in the Welile inbox for blocked sign-ins.

## Recovery while the feed is down

- Agents can use **Deposit → Paste from SMS** to submit the raw SMS body with the TID.
- FinOps can use **Deposit Bridge Health → Bulk recovery** to credit missing TIDs.
  Duplicate protection prevents a TID from being credited twice when the
  email eventually arrives.

## Permanent fix

Install the Deposit Bridge SMS forwarder on the merchant phone so the SMS is
POSTed (HMAC-signed) straight to the backend, removing the IFTTT + Gmail hop.
