-- Manual assignment of one Airtel payment that arrived but could not be matched to an account.
--
-- TID 159383609108, UGX 13,000, received 2026-10-20 23:51 EAT on Airtel from 0701073163
-- (reference APCUG219845279877120). No profile has that sender number, so the Gmail row
-- stayed unmatched. The payer confirmed it is for NAGASHA MELLON (+256792790529), an agent
-- with 28 Rent Plans and no Rent Plan of her own, topping up operational float.
--
-- Inserts ONE PENDING deposit request and moves no money. Run 20261021040100 next to
-- register the TID as finance-verified, then approve.
--
-- Idempotent. One statement, no apostrophes or semicolons in comments.

INSERT INTO public.deposit_requests (
  user_id, amount, status, provider, transaction_id, deposit_purpose, notes
)
SELECT
  t.user_id, t.amount, 'pending', 'airtel', 'TID' || t.tid, t.purpose,
  'Manual intake 2026-10-21: Airtel payment from 0701073163 with no matching profile, assigned by the payer to this account. Gmail receipt 18c20768.'
FROM (VALUES
  ('34f9591f-47fb-4d51-9104-9d821247ebb6'::uuid, '792790529', '159383609108', 13000::numeric, 'operational_float'::public.deposit_purpose)
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
