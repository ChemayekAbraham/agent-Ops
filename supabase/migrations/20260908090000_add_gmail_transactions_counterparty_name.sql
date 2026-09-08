-- MTN's "(NAME) 256XXXXXXXXX" receipt shape carries both a name and a phone;
-- gmail_transactions.counterparty only has room for one value (the phone,
-- since that's what the exact-match pipeline keys on). Add a column to keep
-- the name too, so it survives for the MTN name-match fallback and for any
-- later reconciliation/backfill, instead of being derived-then-discarded
-- in memory every time.
alter table gmail_transactions add column if not exists counterparty_name text;
