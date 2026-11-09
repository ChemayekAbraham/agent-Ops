# Runbook: bulk contact backfills and note links after the switch-on

Applies from the first Partner Returns switch-on until `note_grace_days` (30 by default) have passed.

## Why

At the switch-on, every promissory note written before the cut-off (pending, activated or fulfilled) gets a window that stays open for at least `note_grace_days`, or until the note's due date if that is later. Linking such a note to a person takes that person's Returns rate lock (`partner_rate_lock`, 256 shared buckets) until the transaction commits. A profile phone or email backfill can link notes too, because it proves a contact.

A single statement that links many people holds most of the buckets. In a test, linking 1,000 people held 249 of the 256 buckets. While it runs, opening a portfolio for anyone in a held bucket waits, and that includes brand-new partners. The gate stops waiting after 3 seconds and refuses the portfolio with a retryable error (SQLSTATE 55P03, "try again in a minute"). Nothing hangs, but those portfolios are refused until the bulk change commits.

## Rule

During the first `note_grace_days` after the switch-on:

1. Run profile phone/email backfills and bulk note links in batches of **25 people or fewer**, with one transaction per batch. Commit each batch before you start the next.
2. Run them only **outside the payout windows** (UTC):
   - 06:00 to 09:30
   - 15:00 to 16:10
   - 20:50 to 21:15
   - 23:50 to 00:15
   - 01:30 to 01:50
3. Run one bulk job at a time. Two bulk rate-deciding transactions running together can deadlock, and Postgres then rolls one of them back.
4. If staff report "The portfolio was not saved: this partner's Returns rate is being updated by another change right now", check whether a bulk job is running. Let it finish, or stop it, and then ask them to retry.

After `note_grace_days`, notes written before the cut-off that have passed their due date no longer take the lock when linked. This rule then applies only to notes whose windows are still open.
