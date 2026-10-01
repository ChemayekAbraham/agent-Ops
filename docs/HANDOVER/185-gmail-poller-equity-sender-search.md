# 185 — Gmail poller: sender-based search for Equity alerts

**BUILT 2026-10-01, edge function `gmail-poll-transactions` NOT yet deployed. Two emails still to rescan.**

## Problem
Bayo Mercy's UGX 37,000,000 send to Nabaggala Catherine (Equity ref X9BE68340FD44,
09:57:29 UTC, Gmail id `1a0f73c62319c014`) and another Equity alert at 08:34:09 UTC
(`1a0f7372b34243b7`, to WELILETECHNOLOGIES@gmail.com) were in the inbox
(weliletenants@gmail.com) but never ingested. No Equity row since 2026-09-30 09:51 UTC.
Not the cutoff: a debug rescan (bypasses the cutoff) over 09:30-10:30 and 08:20-08:50
returned 0 messages, while a control window (10:40-10:50) returned its 3. The poller's
broad keyword `GMAIL_QUERY` simply did not list these two. Why is unknown.

## Fix
After the keyword listing, a second listing `from:equitybank.co.ke` (`newer_than:2d`, or
the rescan window) is merged by id. Failure of this extra search is logged and ignored.
Dedup by gmail_message_id / TID / dedup_hash is unchanged.

## After deploy (order matters)
1. Insert a `rejected` merchant_desk_external_funding row for the 37M email's gmail row
   BEFORE it can be suggested, or BAITA is credited twice (manual credit
   `EQMANUAL20261001MERCY37M` already exists). The row id is only known after ingest, so
   ingest in debug first, or ingest then insert immediately (the job runs every 15 min).
2. Rescan with `only_message_ids` = both ids, window 2026-10-01 08:00-10:30 UTC.
3. Check the 08:34 email's content before anything auto-acts on it.
Normal polling will not ingest them (older than cutoff - 10 min); only a rescan does.
architecture-map.html not updated: no flow changed.
