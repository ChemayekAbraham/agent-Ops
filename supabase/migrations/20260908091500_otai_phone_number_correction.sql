-- A second wrong manual_route mapping, independent of the name mapping
-- fixed in 20260907185700_otai_deposit_name_correction_v2.sql: Otai's real
-- MTN phone (confirmed across 5 separate historical receipts, and via the
-- duplicate-receipt content recovered from gmail_dedup_audit for the
-- 2026-09-07 transaction) was manually routed to Sir Ian Martin
-- (3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0) on 2026-09-01, instead of to
-- Otai's actual profile (aad13004-b80d-4611-b982-bac335c9dc9e, the one with
-- the real rent plan). Correct it, and backfill the counterparty on the
-- 2026-09-07 gmail_transactions row with the phone number that was present
-- in the duplicate receipt MTN sent but the poller discarded on TID
-- collision (see the enrich-on-duplicate fix in
-- supabase/functions/gmail-poll-transactions/index.ts).

delete from user_deposit_numbers
where id = 'f2fff71b-3df1-4bfd-abcf-bb80199897f4'
  and phone_last9 = '773900400'
  and user_id = '3d78f1f8-f690-4fe8-bb2e-202f3ef2ecb0';

insert into user_deposit_numbers (user_id, phone_last9, source, linked_gmail_transaction_id)
values (
  'aad13004-b80d-4611-b982-bac335c9dc9e',
  '773900400',
  'manual_route',
  'a1c5fb79-5c94-42de-a8b7-6d0aa9914182'
)
on conflict (user_id, phone_last9) do nothing;

update gmail_transactions
set counterparty = '256773900400', counterparty_name = 'ABRAHAM SAMWUEL OTAI'
where id = '4301961e-311d-4a95-9031-286778cd5f32';
