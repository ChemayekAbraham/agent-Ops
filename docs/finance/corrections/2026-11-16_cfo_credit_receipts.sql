-- CFO DIRECT CREDITS BOOKED AGAINST LEGACY ADJUSTMENTS — batch acct_corr_202611_cfo_credits. DRAFT, not approved.
--
-- ACCOUNTING RECORDS ONLY. NO MONEY MOVEMENT. Platform-scope journals only: no wallet leg; no wallet, receipt, deposit
-- or standing-order record changes; nothing is deleted. Runs AFTER migration 20261125160000.
--
-- CFO decision 16 Nov 2026 (investigate, then fix). CFO direct credits whose company-side leg was the default balance
-- correction (system_balance_correction -> Legacy Opening Balance Adjustments E3), dated on each credit's own date and
-- tagged to the credit's wallet leg (general_ledger / leg id):
--   cash    - 107 credits, UGX 137,088,344: an incoming email/SMS receipt of the same amount, used once and not linked to a
--             deposit request: money received on the company's line -> DR A1 wallet_correction_reclass_a1 / CR E3
--             wallet_correction_reclass_e3 (excluded from Money In: the money was already received);
--   expense - 71 standing-order payouts (operating expenses: office rent, food, transport, stationery, airtime),
--             UGX 10,860,000 -> DR X1 wallet_correction_reclass_x1 / CR E3 wallet_correction_reclass_e3.
-- NOT in this batch (CFO review): 26 manual credits without a receipt (38,686,755, incl. 8 "Manager Wallet Credit"
-- 27,659,000) and 23 credits whose receipt was also used by another credit or a deposit request (31,463,000; 6 of them,
-- 10,363,000, also credited through an approved deposit). Lunch allowances (220, 801,000) were already reclassified on
-- 28 Oct 2026. Forward: cfo-direct-credit books such receipts as cash and standing orders use their expense category.
-- Rollback: the same groups with directions swapped (see the end of this file).
begin isolation level repeatable read;

create temp table _expected (cash_n int, cash_amount numeric, expense_n int, expense_amount numeric) on commit drop;
insert into _expected values (107, 137088344, 71, 10860000);

create temp table _c (leg uuid primary key, kind text not null check (kind in ('cash', 'expense')), amount numeric not null) on commit drop;
insert into _c (leg, kind, amount) values
  ('3293beb7-c03e-4d9a-a0ec-caa2653d393a', 'cash', 80000),
  ('d0e69d87-e066-48dd-b905-f4564b203848', 'cash', 10000),
  ('577fa113-8b96-4bca-89c9-6855d6604482', 'cash', 3000000),
  ('52b5d7c7-b2c1-4660-82a0-b7fc7550f337', 'cash', 1600000),
  ('5cbef39b-f18d-4eb7-ab53-24cd41070bb6', 'cash', 1200000),
  ('47a253db-086f-418f-b181-2c47edd20365', 'cash', 500000),
  ('882dfabe-334d-465e-896f-bbe2321387a2', 'cash', 110000),
  ('3d568c6d-2c2b-406f-88f9-7ead64993742', 'cash', 300000),
  ('c39c5ceb-5df2-4246-92d6-308b2f34dd0e', 'cash', 2000000),
  ('aa3388f8-d9a0-4828-a92c-2f9feef04a5b', 'cash', 1500000),
  ('541d3b57-4183-44c9-be69-2c58e7a71942', 'cash', 1500000),
  ('ee6cfa44-855d-4eee-98e8-5ce48ce5db6a', 'cash', 4900000),
  ('2baa2323-cb29-41da-8307-7f205a5eb5c2', 'cash', 4000000),
  ('8a7803dd-fb6c-41f3-9067-a013cffeae1a', 'cash', 100000),
  ('d3af6e0c-0b9c-466c-a8c8-0de6b760d3e2', 'cash', 5000000),
  ('865312ac-9008-4508-a2ba-d8800a1a8c62', 'cash', 2000000),
  ('85b6f3cc-413f-4a89-a7bd-5b9831d7d021', 'cash', 1000000),
  ('1fbbc7c5-9293-4f57-809b-f63bd7130c1b', 'cash', 1000000),
  ('3fe92ca0-1d7b-4e21-9c21-0025ddbed5a2', 'cash', 45000),
  ('f04c0edf-bcba-48f4-ab3e-99e4c731e241', 'cash', 100000),
  ('05ddac56-362e-4fe5-b341-d5ab4e86decc', 'cash', 100000),
  ('fadcb3eb-a6a0-4449-ab0e-3f473a5a20e7', 'cash', 400000),
  ('8e4cb20a-577d-4fa3-bcf8-ddfb025ad904', 'cash', 1500000),
  ('0e719b95-4e38-4693-869d-06549b4da3d6', 'cash', 200000),
  ('bd628970-f640-4b68-9a22-396b30bc3424', 'cash', 100000),
  ('0d3441dd-2cbb-4fe4-b110-df90b0648df2', 'cash', 2000000),
  ('49125ae0-8a56-4d72-bb63-3ce5e05f678a', 'cash', 5000000),
  ('b514c4a2-db0f-448f-bcde-86807ed1bb1e', 'cash', 230000),
  ('dfa4b3a5-9ec7-4d32-935c-bc2c62c801a0', 'cash', 10000),
  ('b584a848-21d7-4699-8376-f3aa0a37b394', 'cash', 2000000),
  ('707396b5-ca20-452a-bc71-8280cd415c66', 'cash', 195000),
  ('b1a207f3-438a-4e68-b1ef-1825b5f0ac90', 'cash', 2000000),
  ('f7b482ca-60ed-4f2c-a306-94276edfdfa3', 'cash', 88320),
  ('ff9394da-d9c4-4f85-aa77-0b26596235fd', 'cash', 1500000),
  ('460f2bfd-29bc-4b13-9fff-911e905296fe', 'cash', 1000000),
  ('2ec064d7-e48c-476f-b542-1455c5cce9b7', 'cash', 124000),
  ('ccc699bf-e8e0-4be6-acea-e26209fb2359', 'cash', 1000000),
  ('cc33f50a-b301-4dc0-a84a-ccfa6ccba631', 'cash', 500000),
  ('0bbea98f-2a32-4289-9fc5-23b21b7cf84b', 'cash', 600000),
  ('ce3ec9a4-ebc4-4723-b4a6-46f863ef92e8', 'cash', 200000),
  ('3348a2fa-8263-4cb4-a400-00696a31db39', 'cash', 15000),
  ('35356378-49a1-4915-a8ca-3c20d4c8b366', 'cash', 1500000),
  ('8f41349d-e35f-4717-a3d9-f29be31ff861', 'cash', 450000),
  ('96a88030-acf3-4b94-aa40-82d304f308f4', 'cash', 5000000),
  ('18abbc15-f1ab-4ab2-ad66-2057de889984', 'cash', 100000),
  ('e6203cd2-63b6-4b74-adcb-de000f77daa8', 'cash', 1000000),
  ('5a7af094-9e1b-4f92-bd32-99f3499d0563', 'cash', 4000000),
  ('729ace76-1cd2-44dd-ada9-1bff79b6fe03', 'cash', 1000000),
  ('3fcf5179-d65d-4528-b386-e3841258a35d', 'cash', 670000),
  ('fade6b71-8c64-4bc8-a9c8-84dae025a0da', 'cash', 100000),
  ('1282f95c-af42-4160-9f2e-934183f5cf2a', 'cash', 150000),
  ('87af0f45-5ea3-49a9-bf26-54235abef38c', 'cash', 5000000),
  ('7bbd5394-4601-4706-8fc1-1b6ff19c480f', 'cash', 1000000),
  ('f8845fbd-3cfa-40cd-be0f-befd14c3530c', 'cash', 100000),
  ('cb56081f-4102-48fd-8e9f-c0697153c1c9', 'cash', 2000000),
  ('5ff2c1c1-2b7a-4116-abb2-13db4390eed1', 'cash', 100000),
  ('d174b80e-22b3-455a-afe1-73608838b68e', 'cash', 5000000),
  ('4dfab888-ea40-4d4d-ae9f-e7449023ca7f', 'cash', 50000),
  ('411f7e56-7002-4b89-821b-5bd5c7ef05df', 'cash', 300000),
  ('f198baad-19bb-4e3e-92e4-b4277d701f98', 'cash', 3000000),
  ('d455705b-7493-49f5-9e95-24e4c0e190ad', 'cash', 3000000),
  ('40edb8e1-d412-492e-be42-598573abec0e', 'cash', 100000),
  ('2781da1e-b688-400d-9115-74063f12dc17', 'cash', 400000),
  ('69f22821-13f9-40fe-a9cb-79fc66047b18', 'cash', 160000),
  ('4edb0cd2-d9f4-430b-8f49-49ccc354f8d3', 'cash', 44000),
  ('bba1f3bb-2d81-4c3a-87db-3d097a25b134', 'cash', 150000),
  ('ecb42ae5-e9fb-414f-8fe3-82b00cc84c25', 'cash', 100000),
  ('9d0a69fd-9d2e-4edd-8c1a-cb5365293fca', 'cash', 400000),
  ('ab9b58b7-ccc5-42fb-92cf-444ab41c08fd', 'cash', 2000000),
  ('ecdbeba6-174c-4a65-8db9-5a3b7da7c611', 'cash', 1000000),
  ('fc8c110a-776c-41e0-859b-1ae697f1038c', 'cash', 5000000),
  ('faade88d-5cff-47fd-a263-8270bf190df6', 'cash', 300000),
  ('5c542089-715e-4e0f-9de7-a079731e92b5', 'cash', 5000000),
  ('70e3052b-ec7a-46b6-a765-c9b24c42d496', 'cash', 2000000),
  ('af29fc84-a51f-4fbf-9693-d1f6b887a6ff', 'cash', 2000000),
  ('18e2133f-d315-4b27-b91b-a72187b62e17', 'cash', 1000000),
  ('c4add78c-c113-490b-862b-44081cb27fb9', 'cash', 50000),
  ('fcac8fc8-0d05-41ed-8d95-542e89f99381', 'cash', 1240000),
  ('b4cfa3fd-d03c-40b3-9b94-d1dcd3c4989e', 'cash', 200000),
  ('aa608226-c933-43bb-a64c-51dd2cf07575', 'cash', 2000000),
  ('044939cf-cd6c-48fb-ae8f-28ea62decfef', 'cash', 20000),
  ('4746b138-19c4-46a5-8dcb-a3fc74154a47', 'cash', 200000),
  ('83058d02-9951-4990-9907-e9cb6dfa172c', 'cash', 3000000),
  ('33c725f3-6e86-43bf-b638-6495fdf3e6a3', 'cash', 1000000),
  ('73356481-9d3c-4be9-ab49-9c142c03320c', 'cash', 100000),
  ('e09f13ba-d607-4904-94f5-a9a42dd6b30a', 'cash', 5000000),
  ('1e0ce062-deb5-4a7e-b9ef-0572139c8220', 'cash', 5000000),
  ('2e2f0664-099c-4f01-abea-6fe39e540a0e', 'cash', 5000000),
  ('82244f1c-5261-4707-a80b-448c1b5aa357', 'cash', 50000),
  ('b4a27f03-1aa3-4123-bf61-6a45b1842339', 'cash', 150000),
  ('b1433fe4-bde8-4c66-8986-18ee1c585e59', 'cash', 500000),
  ('1964e60d-52e9-4666-ab0e-25b2780eb60a', 'cash', 2500000),
  ('cb064c8c-9346-453d-aca4-93f5bb275d8f', 'cash', 400000),
  ('62304df2-0f1b-471f-b187-154c0e5d1bed', 'cash', 2903040),
  ('46e843ca-499e-462a-b86d-574af6d3c9df', 'cash', 1600000),
  ('cd496f6f-ffba-4325-abb7-2a0c06dc0cb0', 'cash', 300000),
  ('e5136187-2298-4da9-9313-9778b8a85955', 'cash', 105984),
  ('36b396bd-97dc-476c-a8d8-d60d946ef6be', 'cash', 200000),
  ('f2a5c818-e77d-4c28-9f05-a2a96ec748b7', 'cash', 946000),
  ('df555c61-1d3e-4b00-b1a5-05c4b29c5773', 'cash', 80000),
  ('e1dd74df-8896-4612-aa8a-e1e4e74b190f', 'cash', 1000),
  ('1e3def1a-c4a2-434b-8c0a-8ac3df7dedbd', 'cash', 150000),
  ('635332a4-a528-4f26-a08d-6ed6775a41b6', 'cash', 400000),
  ('bb14bdea-baf4-4ad6-9578-f74c83ab8dad', 'cash', 960000),
  ('b7040029-8981-43e2-9822-40f221a46d72', 'cash', 1000),
  ('a1f957d4-604e-4d1c-a98d-0b6cbfd9af90', 'cash', 150000),
  ('5f106e84-bafc-4b97-bfdd-5e31095b855b', 'cash', 1000000),
  ('eb189306-7370-4277-9b6f-87cbb70bee9e', 'expense', 2000000),
  ('424a225a-e31c-4bb3-8eff-372b40860f6d', 'expense', 30000),
  ('721386b0-e134-41d7-8f4b-9283868d9a9f', 'expense', 100000),
  ('752eba55-5362-4a5c-8493-5fae8e38d92d', 'expense', 100000),
  ('229983c1-e2c5-410d-a9ba-5eb9de672747', 'expense', 50000),
  ('84725c94-f788-420e-87bf-ec8188d296fe', 'expense', 30000),
  ('7207586d-4eb7-4eb4-b9fe-40f7b8a5614f', 'expense', 100000),
  ('b1c51254-44eb-4ce8-99d5-8117ce2684bd', 'expense', 48000),
  ('512fe19a-f0b8-4bfd-a459-a82dcfe39713', 'expense', 60000),
  ('9bb38c37-23d8-42f6-8db3-3f73c67819a4', 'expense', 100000),
  ('ce283a9e-2726-439c-b153-37ef758e5d99', 'expense', 100000),
  ('64ce8c28-8bb1-4a29-ac3d-f3eda4b697c3', 'expense', 100000),
  ('80b0b33c-1ed1-4ccb-af52-9211f36df0be', 'expense', 100000),
  ('02f66069-429d-4b7d-a769-593d3517d7e6', 'expense', 40000),
  ('b30a01b6-e5d6-4f82-bdb3-fcaeece91163', 'expense', 70000),
  ('1a8f153e-ac49-4233-a68d-ebf0f473ff92', 'expense', 25000),
  ('ce28bc0b-0840-4e16-99f1-1dae001a27ca', 'expense', 100000),
  ('73c001b6-c4bc-4cfd-8b97-43df1e4e9367', 'expense', 100000),
  ('dcdc17b4-7f48-4c32-8419-72f22f8e6460', 'expense', 100000),
  ('ebe1a4e3-ff1e-48f8-b24f-e8bd70a4ca2f', 'expense', 100000),
  ('1a6e60ec-a749-437f-b15a-20b54f9023f3', 'expense', 100000),
  ('c37b6374-e046-421f-9e8e-083926ec900b', 'expense', 100000),
  ('00b23835-0d2d-4ed3-8c23-f8db0858d7bd', 'expense', 700000),
  ('74c9388f-d3b2-48e4-b090-348bfb6e87ac', 'expense', 100000),
  ('b3459306-4414-4f07-a741-edbfd0a2f3e3', 'expense', 2000000),
  ('cb2f558b-d639-4933-a688-647625a3028f', 'expense', 20000),
  ('4f5122ee-ddb0-4d7f-89b8-d98cf601aaf3', 'expense', 100000),
  ('c7142847-a8e8-45e9-ba01-86ed27f09b7c', 'expense', 100000),
  ('fae5a59e-544a-4ecc-95b7-9c9a7247f885', 'expense', 100000),
  ('02e85bbe-c1b3-486e-8025-ce1320b5f766', 'expense', 90000),
  ('16ebcc8d-5c0e-4d5a-b985-db3518051799', 'expense', 100000),
  ('b7e0e3c4-d376-4758-a591-a2ce5441f5db', 'expense', 100000),
  ('f6c717d8-6f9b-47ea-a5c1-3c7c6f05473f', 'expense', 100000),
  ('519d4ef9-766d-4728-b6e0-5bf058c7066e', 'expense', 100000),
  ('aaadd04a-9cf5-4673-a3fe-c4ed86ad823d', 'expense', 100000),
  ('708fbd46-0286-4bdb-bada-1662f252d163', 'expense', 100000),
  ('afbf2069-f423-4c9e-879c-87b357273526', 'expense', 100000),
  ('11875320-6514-403a-8fe3-d3f183dd8fbe', 'expense', 25000),
  ('e55e152a-acea-4a86-bfde-04f8cc3bc00f', 'expense', 100000),
  ('2e50f92d-482b-451d-a7fb-0f781d9eaee6', 'expense', 100000),
  ('8871e9fa-ab2f-4669-9ac5-f4220516177a', 'expense', 100000),
  ('b8f2d5eb-0daf-4c7d-9a9d-69be20835b49', 'expense', 100000),
  ('6cf8ca89-3d23-420c-8c2c-308469977bee', 'expense', 30000),
  ('76892838-e487-4daa-9bb6-b476646686b0', 'expense', 100000),
  ('f6bc4771-3da7-4910-8392-25f74d76c88e', 'expense', 100000),
  ('2590d781-e260-4667-b4db-e1b051d95050', 'expense', 30000),
  ('4bc3b5b4-a0ea-4115-b7d1-925ef15ff5e3', 'expense', 100000),
  ('c2541bf8-3ffa-48ed-a415-434ad3efd9b0', 'expense', 100000),
  ('d36b3bc2-6a90-4b38-983e-698bf9e20755', 'expense', 100000),
  ('6989e7a4-d018-4715-9acb-4fd5b6149c59', 'expense', 100000),
  ('ad59f7c6-54e6-4664-96ce-91b7c145334f', 'expense', 100000),
  ('9aae0695-3fc5-44e3-a149-5686590553e8', 'expense', 20000),
  ('fbdff18f-371d-4f2c-b8c3-53e151f78904', 'expense', 100000),
  ('d20d1190-655f-4907-b2b1-e4ef77312195', 'expense', 100000),
  ('f5ed32da-8039-49cd-b26a-6d1844499459', 'expense', 100000),
  ('0fd14091-7cc5-4ef1-9555-b90b15b05671', 'expense', 100000),
  ('c2bdfe40-0d7b-43dd-ac5c-cfe55cfde2dc', 'expense', 100000),
  ('9e0f4545-cbe3-42fa-9a1c-2b943694d43d', 'expense', 25000),
  ('fb0127f3-8480-4558-aa3b-135c3eaf095f', 'expense', 100000),
  ('1ff9fe1f-323a-48e7-a00c-083200638885', 'expense', 100000),
  ('5d319e60-2496-4058-b621-a265b8e25ab1', 'expense', 100000),
  ('5270df41-2066-4194-8f16-d9e70c4e871b', 'expense', 30000),
  ('7e52e6ac-c4dd-4bc1-a2fd-30c1a0f97733', 'expense', 100000),
  ('791777dc-87ec-4dd8-b366-aabc7fe91e1c', 'expense', 40000),
  ('758c8292-ef7d-4e89-bd07-9302af4dbcc5', 'expense', 30000),
  ('5f860067-fa6c-4a69-8cb1-d93bc175bcce', 'expense', 700000),
  ('023f4bc7-5585-4ccb-ab76-4fd877c2a4d9', 'expense', 25000),
  ('2a5e24ad-e211-4080-833b-fd3de511582c', 'expense', 42000),
  ('4adb421f-dfd1-4b45-a2e1-7bea8206b46d', 'expense', 100000),
  ('617954d8-9edb-48a3-bd80-5da99de2c2af', 'expense', 100000),
  ('3bcd8f10-34bc-4b5a-a830-3d49d4340dfc', 'expense', 100000)
;

do $corr$
declare
  c_batch constant text := 'acct_corr_202611_cfo_credits';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  r record; e record; v_n int; v_x numeric; v_grp uuid;
  s_wallet_legs bigint; s_wallet_sum numeric;
begin
  if not exists (select 1 from public.fin_cash_flow_map where account_code = 'E3' and category = 'wallet_correction_reclass_e3') then
    raise exception 'STOP: migration 20261125160000 is not installed';
  end if;
  if exists (select 1 from public.accounting_correction_register where batch = c_batch) then
    raise exception 'STOP: batch % is already posted', c_batch;
  end if;
  select * into e from _expected;
  if (select count(*) from _c where kind = 'cash') <> e.cash_n or (select coalesce(sum(amount),0) from _c where kind = 'cash') <> e.cash_amount
     or (select count(*) from _c where kind = 'expense') <> e.expense_n or (select coalesce(sum(amount),0) from _c where kind = 'expense') <> e.expense_amount then
    raise exception 'STOP: input does not match the approved totals';
  end if;

  -- 1. Every credit still matches the evidence: a production wallet credit from the CFO tool whose only platform leg is
  --    the admin-correction balance correction of the same amount; for cash, still one receipt, not linked to a deposit.
  for r in select c.*, g.id gid, g.amount gamt, g.direction, g.classification, g.source_table, g.transaction_group_id grp,
                  (select count(*) from public.general_ledger p where p.transaction_group_id = g.transaction_group_id and p.ledger_scope = 'platform') n_plat,
                  (select count(*) from public.general_ledger p where p.transaction_group_id = g.transaction_group_id and p.ledger_scope = 'platform'
                     and p.category = 'system_balance_correction' and p.classification = 'admin_correction' and p.amount = g.amount) n_sbc
           from _c c left join public.general_ledger g on g.id = c.leg loop
    if r.gid is null or r.gamt <> r.amount or r.direction <> 'cash_in' or r.classification <> 'production'
       or r.source_table <> 'cfo_direct_credit' or r.n_plat <> 1 or r.n_sbc <> 1 then
      raise exception 'STOP: credit % no longer matches the evidence', r.leg;
    end if;
    if r.kind = 'cash' and not exists (
         select 1 from public.general_ledger w join public.email_credit_idempotency x on x.reference_id = w.reference_id
           join public.gmail_transactions t on t.id = x.gmail_transaction_id
          where w.id = r.leg and t.direction = 'in' and abs(t.amount - r.amount) <= 1 and t.linked_deposit_request_id is null
            and (select count(*) from public.email_credit_idempotency x2 where x2.gmail_transaction_id = x.gmail_transaction_id) = 1) then
      raise exception 'STOP: credit % no longer has a single unlinked inbound receipt', r.leg;
    end if;
  end loop;

  select count(*), coalesce(sum(amount), 0) into s_wallet_legs, s_wallet_sum from public.general_ledger where ledger_scope = 'wallet';

  -- 2. One platform group per credit, on the credit's own date.
  for r in select c.*, g.transaction_date td, g.transaction_group_id grp from _c c join public.general_ledger g on g.id = c.leg order by g.transaction_date, c.leg loop
    v_grp := public.create_ledger_transaction(jsonb_build_array(
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amount,
        'category', case when r.kind = 'cash' then 'wallet_correction_reclass_a1' else 'wallet_correction_reclass_x1' end,
        'source_table', 'general_ledger', 'source_id', r.leg, 'reference_id', r.grp::text, 'currency', 'UGX', 'classification', 'production', 'transaction_date', r.td,
        'description', case when r.kind = 'cash'
          then format('Correction (accounting only, no money moved): CFO credit of an incoming receipt (UGX %s) was money received on the company''s line; recorded as cash instead of a legacy adjustment', r.amount)
          else format('Correction (accounting only, no money moved): standing-order payout (UGX %s) is an operating expense, not a legacy adjustment', r.amount) end),
      jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'wallet_correction_reclass_e3',
        'source_table', 'general_ledger', 'source_id', r.leg, 'reference_id', r.grp::text, 'currency', 'UGX', 'classification', 'production', 'transaction_date', r.td,
        'description', 'Correction (accounting only, no money moved): taken out of Legacy Opening Balance Adjustments')),
      c_batch || ':' || r.leg::text, false);
    if r.kind = 'cash' then
      insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item)
      values (v_grp, 'Reclassification of a receipt already credited to the customer (accounting only): not new money', r.kind);
    end if;
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, original_group_id,
      correction_group_id, amount, before_value, after_value, detail, created_by)
    values (c_batch, r.kind, case when r.kind = 'cash' then 'cfo_credit_receipt_to_cash' else 'standing_order_to_expense' end,
      'general_ledger', r.leg, r.grp, v_grp, r.amount, r.amount, 0, '{}'::jsonb, c_cfo);
  end loop;

  -- 3. Checks.
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.accounting_correction_register where batch = c_batch;
  if v_n <> e.cash_n + e.expense_n or v_x <> e.cash_amount + e.expense_amount then raise exception 'STOP: posted % / %', v_n, v_x; end if;
  if exists (select 1 from public.general_ledger g where g.idempotency_key like c_batch || ':%' and g.ledger_scope <> 'platform') then
    raise exception 'STOP: a correction leg is not platform-scope';
  end if;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.general_ledger where ledger_scope = 'wallet';
  if v_n <> s_wallet_legs or v_x <> s_wallet_sum then raise exception 'STOP: a wallet-scope ledger leg was written'; end if;

  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
  values (c_cfo, 'accounting_correction_batch_posted', 'cfo_credit_receipts', 'accounting_correction_register', c_batch,
    'CFO direct credits booked against legacy adjustments: receipts to cash, standing orders to expense (accounting only)',
    jsonb_build_object('cash', e.cash_n, 'cash_amount', e.cash_amount, 'expense', e.expense_n, 'expense_amount', e.expense_amount));
  raise notice 'batch % posted: cash % / UGX %, expense % / UGX %', c_batch, e.cash_n, e.cash_amount, e.expense_n, e.expense_amount;
end $corr$;

commit;

-- ROLLBACK (only on CFO instruction): for each register row of this batch, post the same legs with directions swapped,
-- idempotency key acct_corr_202611_cfo_credits:rb:<register id>, dated today, and set rolled_back_at.
