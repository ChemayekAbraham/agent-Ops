-- Manual intake of two MTN self-payments by a tenant, lost to the MTN SMS feed outage.
--
-- Payer: Esther Akia (+256777344174), a tenant with an active Rent Plan whose agent
-- is JACOB MUNABI (+256705827282). She pays UGX 4,800 a day to till 090777 and her
-- earlier payments of 12 to 16 Oct were settled automatically. She has no agent
-- activity of her own, so these are rent payments and not float top-ups.
--   TID 44312406584  UGX 4,800  2026-10-17 21:05:04 EAT
--   TID 44338833455  UGX 4,800  2026-10-18 20:17:30 EAT
-- Read from payer-side SMS screenshots. The date to TID pairing was inferred from
-- TID order and should be confirmed. Neither TID is in gmail_transactions,
-- deposit_requests or ledger_reconciled_tids.
--
-- Inserts PENDING deposit requests only and moves no money. When a manager
-- approves each one, approve-deposit credits her wallet and settle_tenant_rent_from_deposit
-- reduces the Rent Plan and pays the agent commission. No TID registration is
-- needed because tenants do not use TID-backed float. Check both TIDs on the MTN
-- till 090777 statement before approving.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'mtn', t.tid, t.purpose,
  'Manual intake 2026-10-18: MTN SMS feed outage, payer-side SMS. Verify TID on till 090777 statement before approving.'
FROM (VALUES
  ('26af5642-7432-4994-82af-aabc9bc85770'::uuid, '777344174', '44312406584', 4800::numeric, 'personal_rent_repayment'::public.deposit_purpose),
  ('26af5642-7432-4994-82af-aabc9bc85770'::uuid, '777344174', '44338833455', 4800::numeric, 'personal_rent_repayment'::public.deposit_purpose)
) AS t(user_id, phone_last9, tid, amount, purpose)
JOIN public.profiles p
  ON p.id = t.user_id
 AND right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 9) = t.phone_last9
WHERE NOT EXISTS (
        SELECT 1 FROM public.deposit_requests d
         WHERE regexp_replace(lower(btrim(d.transaction_id)), '^tid', '') = t.tid
           AND d.status NOT IN ('rejected', 'cancelled', 'failed')
      )
  AND NOT EXISTS (
        SELECT 1 FROM public.ledger_reconciled_tids l
         WHERE l.tid_normalized = t.tid
      );
