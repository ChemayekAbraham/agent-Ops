-- READ-ONLY preview for 2026-11-10_cfo_routed_receipts.sql. Changes nothing.
with s(wallet_leg, orig_group, amount) as (values
  ('c5c1ace9-0648-49d5-a825-69ef95fdcd00'::uuid, '7f476485-9be6-4b89-b5bf-25e9754c146c'::uuid, 1000000::numeric),
  ('f85e8298-ec36-42fc-a751-fa4009ffa3aa'::uuid, 'af98a061-d7c0-46f5-bea2-427251928570'::uuid, 100000::numeric),
  ('43ac81b2-453f-4234-a637-43693569ce5a'::uuid, '1aa1acff-abc6-4d1d-97fa-93756848930e'::uuid, 1200000::numeric),
  ('063a738e-8846-46ca-9bf3-e85a5731290d'::uuid, '6ffe5d06-a4ad-4280-ae16-0197fad69b90'::uuid, 1000000::numeric),
  ('e1e01a7d-4f2b-4526-abd9-b255eceb8606'::uuid, 'ac5901b0-77c2-4c07-bc68-152c3cbd8b52'::uuid, 2000000::numeric),
  ('854a9bb4-5c03-4514-984a-b612e1022116'::uuid, '7ec08e0f-4860-450e-aa8c-be5e59a1a2e3'::uuid, 100000::numeric),
  ('bb2875ec-c353-42fe-bd90-e130e0c6499c'::uuid, '59574ac2-f37c-45de-aac6-124e25950531'::uuid, 1000000::numeric),
  ('9829c4e0-c301-48da-a5a2-8e04963557c7'::uuid, 'cf865665-4716-45a1-ad15-50aff04df7b9'::uuid, 1000000::numeric),
  ('061a48a2-782f-4dd3-b5f7-3d500f63608b'::uuid, 'e9e80382-97e4-4479-a022-4bfcc9ce2d8e'::uuid, 2000000::numeric),
  ('b941754a-1152-40ca-93ad-3f6235d05e68'::uuid, 'd201c3d5-67c8-4484-b589-485339c6a08b'::uuid, 100000::numeric),
  ('5303943c-b940-4a8e-aef6-23efdf4f58e1'::uuid, 'c6eb5b53-7f41-4f98-8cad-fabf771958b8'::uuid, 4000000::numeric),
  ('b50a4629-4bad-4128-810b-22cad4717ac5'::uuid, '0a811d4f-c425-4c0e-9b45-bf0185231cd5'::uuid, 220000::numeric),
  ('25a25885-ee2b-47b3-b1be-73182f93961e'::uuid, 'c0bbd734-08e8-41c1-9c47-b21528c3c629'::uuid, 1000000::numeric)
),
c as (select s.*, w.amount credit_amount,
        (w.transaction_group_id = s.orig_group and w.source_table = 'cfo_direct_credit' and w.ledger_scope = 'wallet' and w.wallet_bucket = 'float' and w.direction = 'cash_in') wallet_ok,
        (select count(*) from public.general_ledger p where p.transaction_group_id = s.orig_group and p.ledger_scope = 'platform' and p.category = 'agent_float_deposit' and p.direction = 'cash_out' and p.amount = w.amount) platform_ok,
        exists (select 1 from public.email_credit_idempotency ec join public.gmail_transactions gt on gt.id = ec.gmail_transaction_id
                 where ec.reference_id = w.reference_id and ec.operation = 'credit' and gt.direction = 'in' and abs(gt.amount - w.amount) <= 1) receipt_ok,
        exists (select 1 from public.user_roles ur where ur.user_id = w.user_id and ur.role = 'agent') is_agent
      from s left join public.general_ledger w on w.id = s.wallet_leg)
select count(*) n, sum(amount) amount,
       count(*) filter (where not coalesce(wallet_ok,false) or platform_ok <> 1 or not receipt_ok or is_agent or amount > credit_amount) failing,
       (select count(*) from public.accounting_correction_register where batch = 'acct_corr_202611_cfo_routed') already_posted
from c;
