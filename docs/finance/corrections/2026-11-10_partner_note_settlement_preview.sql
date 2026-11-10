-- READ-ONLY preview for 2026-11-10_partner_note_settlement.sql (batch acct_corr_202611_notes). Changes nothing.
-- Run through the read-only wrapper. Works before the migration is applied (computes the settlement rule inline).
with c(note_id, portfolio_id, amount) as (values
  ('9846e755-8913-44c7-8494-42ae2c2672b0'::uuid, '53936a44-129c-4b89-b2e6-2a25144772bf'::uuid, 100000),  -- WIP2608138580
  ('f108d61e-e866-4e19-a7fb-1368d4e7cf08'::uuid, '5be6c1fc-b723-4ccc-9494-ec28b130baba'::uuid, 700000),  -- WIP2608217026
  ('f61526fa-6eed-459d-bc1d-aad6bf3f8496'::uuid, 'b2c75b5e-3907-495c-bee6-2d46ebd1cb44'::uuid, 1000000),  -- WIP2608282334
  ('675ad493-0c34-4be0-bb03-862ae1968618'::uuid, 'e8edd433-7146-4f9d-a838-78ba3f3ee34a'::uuid, 1000000),  -- WIP2608314519
  ('323d082a-e806-4967-b59f-291a2069c4f7'::uuid, 'ee5aa7c0-e17d-4a06-b0f4-a8b1dbe39a4b'::uuid, 1000000),  -- WIP2609018385
  ('aae85151-bae8-42bd-af2d-bcc3de03f653'::uuid, '804bfa39-e154-4a4c-b106-09c8a70318dd'::uuid, 100000),  -- WIP2609034022
  ('0cd7f5db-b4d9-4353-a0fc-18b7c8cfd3e6'::uuid, '543fb7ae-a24e-401b-a796-af3785b137ea'::uuid, 100000),  -- WIP2609036205
  ('4088c724-1db8-4f05-a6f0-6f8da176264b'::uuid, '47a3000b-533b-400e-9f8b-0dfc0fdb8106'::uuid, 20000000),  -- WIP2609086527
  ('7a169c20-c688-4034-9d45-021426f9118c'::uuid, '4e7578c0-4774-4db8-b515-58596c23f1c7'::uuid, 3000000),  -- WIP2609087491
  ('b32c1962-600e-47dd-908a-9efe7d5f0a44'::uuid, '488f484d-c20b-4eb9-895a-7306b9228d21'::uuid, 100000),  -- WIP2609102684
  ('96263e2f-e4fe-40d3-a160-83f139f4ff8c'::uuid, 'fd90844a-d2ac-4a2b-b385-6b16b2ddecc2'::uuid, 8450000),  -- WIP2609113831
  ('35658dd4-d451-404a-b815-395a4cd05679'::uuid, '870086a5-b5ba-47e3-bf64-48a841033079'::uuid, 1000000),  -- WIP2609116417
  ('cb64acf0-3cda-49e0-94be-2ad8f16c378f'::uuid, '51ef0edf-1b80-4373-845a-b8894b4985e5'::uuid, 7000000),  -- WIP2609118730
  ('0a9648e6-d9f4-4e37-ba7c-f2fd58e1afb3'::uuid, 'b667aee7-71c1-4ecd-a889-2d3ae3b675d7'::uuid, 50000),  -- WIP2609148426
  ('e93d7e5b-8c8f-4d31-99aa-a06b5c2c598c'::uuid, '1be38ffb-0d37-4df0-958d-ff3a7181b430'::uuid, 500000),  -- WIP2609152104
  ('07da7383-1db1-499f-b212-3e900ce36d4e'::uuid, 'e3c16283-4f35-4acd-95f2-cd8ebe4506b5'::uuid, 500000),  -- WIP2609176859
  ('4b7622df-1867-4628-90ca-86d428f49038'::uuid, 'de83d131-5d92-453f-b841-31f5bd5b0543'::uuid, 1500000),  -- WIP2609196534
  ('ac9b8895-d251-4e05-b6d7-4307b90892da'::uuid, '7a3ba728-ac14-487a-b4e8-08b2a45ff174'::uuid, 2000000),  -- WIP2609215031
  ('5b5fb3f0-986e-46f0-a242-bd7648ace5fe'::uuid, 'add806c9-233d-41ba-bbc1-4298450a7d1b'::uuid, 200000),  -- WIP2609249118
  ('fe475bbb-9bf4-424c-a067-f09061dce501'::uuid, '75feca24-0f54-485b-8616-133a5e08e951'::uuid, 1000000),  -- WIP2609281124
  ('4936108d-b4f2-4df1-885b-b9047373abd7'::uuid, '6a0d64fc-38b6-461e-93eb-dbcc5bf132e8'::uuid, 4000000),  -- WIP2609291530
  ('4a33db9d-a62d-4cf5-9725-3a8296313ee2'::uuid, '6cd9e6f9-7813-4cd1-9495-6383f0fba3fb'::uuid, 4000000),  -- WIP2609293841
  ('29d7ba8e-c082-452a-a50a-d81540153ef0'::uuid, 'b225a7f7-09e4-4aed-a6af-85de64ea4c75'::uuid, 100000),  -- WIP2609299650
  ('2c141a0d-0f28-45bb-9c35-b27dbc8551b3'::uuid, '6715622e-f480-4990-9b99-a1911b1ee498'::uuid, 50000),  -- WIP2609301909
  ('1d99734c-53fa-4830-b6f2-33768ed44bc0'::uuid, '8f0c6b71-d94d-48aa-a999-e6052704f768'::uuid, 200000),  -- WIP2609304246
  ('f252e525-d0eb-4494-9828-7fe7e5413e9e'::uuid, '9a3166f5-043e-4d47-8ebc-f6ad20b1f9da'::uuid, 100000),  -- WIP2610012230
  ('ea948ba8-6ccb-4cd6-8e65-3c35fa55edd2'::uuid, '2ec4718d-e101-483c-a786-bcadee6b9ff7'::uuid, 670000),  -- WIP2610014734
  ('c4c7d9f4-799f-4d46-b241-a1a8c9c5bd8a'::uuid, '0df5b5cc-43e0-4e45-9f79-1d99987adc95'::uuid, 1340000),  -- WIP2610052526
  ('c5075445-0c82-4b85-b3a1-c963694c7c30'::uuid, 'fdc8f3f0-b89b-4135-9f67-ef25ea89179e'::uuid, 1000000),  -- WIP2610121701
  ('38266f70-6bb1-46cc-a755-45e4ec678104'::uuid, 'c79c6867-6f01-46bc-a484-360b4261772f'::uuid, 220000),  -- WIP2610123829
  ('ba1e76ef-1f28-4d31-af66-27c5c62397a5'::uuid, 'd75370f6-6524-4be3-b228-9999bc9a3a93'::uuid, 5000000),  -- WIP2610124276
  ('0466b8ad-82d8-4941-87ed-1b1f4caa9044'::uuid, '004f73c2-8946-426c-b081-97f0cf47ee40'::uuid, 100000),  -- WIP2610126385
  ('e2c7685a-5268-46b8-b550-59839f24edb9'::uuid, '54f1fa4b-5098-49f3-8599-446095dcb413'::uuid, 1700000),  -- WIP2610126571
  ('b1a1b5e1-5459-4676-a1a5-ff30ab6fe71e'::uuid, '16a69875-507f-4ded-98ec-b6a9ee743e87'::uuid, 2000000),  -- WIP2610129344
  ('0f470988-dfde-41a6-b678-030165b4275f'::uuid, '8de71962-594f-4141-ae41-71b3f2e63fe4'::uuid, 55000000),  -- WIP2610131758
  ('e502c5b5-7caa-4db7-90fe-e22761808e42'::uuid, '94c4748a-609e-45bb-86a6-4f1f5ef3724b'::uuid, 850000),  -- WIP2610133586
  ('b2a7ec44-16a8-4684-9e69-7222fb51d11c'::uuid, '5a341a1b-dd7e-42db-8cdc-93dff52ff70d'::uuid, 3000000),  -- WIP2610135228
  ('a231fb32-644e-406b-9a02-a712a89d6297'::uuid, 'e68b2a42-1e3a-46dc-8a9e-919c39d5c8b8'::uuid, 1400000),  -- WIP2610143020
  ('ecbe15d9-3ef3-4f21-a7ae-9ff06d496bb6'::uuid, '0b8a5b89-1da3-4b61-9447-ede78767a408'::uuid, 670000),  -- WIP2610144930
  ('d5363bf5-6002-4789-a9b8-5cb9f91caefc'::uuid, 'aec615b1-a1e2-4f55-acb1-894961ed98a6'::uuid, 100000),  -- WIP2610145385
  ('0aa803ac-8343-4fbd-9203-7853b2d81ad4'::uuid, 'b50ad7c3-6b9f-46fd-a711-0d0c0b48026c'::uuid, 200000),  -- WIP2610156370
  ('d8a12338-7f7f-4de2-ace5-56852c95c20d'::uuid, 'f728046b-758c-425d-846d-e8a4908d9fcf'::uuid, 500000),  -- WIP2610157620
  ('7c8a1867-127a-4e6a-877c-fe3dfcd6b6bb'::uuid, 'b40b5227-ed6a-49e2-ab26-d39ef72854af'::uuid, 250000),  -- WIP2610163675
  ('3b5d43a7-62a4-4673-a506-bfb09b1f2f01'::uuid, '7acfc284-28fd-4b06-8bcb-08c461e4ac4e'::uuid, 700000),  -- WIP2610193712
  ('d6ed0634-92ee-489a-a722-945f537a383a'::uuid, '6a2d56a8-2e3a-42ed-936b-3660550005a8'::uuid, 1000000),  -- WIP2610193740
  ('49845a69-486b-4d2b-aeb4-a5b825aac15d'::uuid, '2e0a33e4-31d8-4fb3-b985-d8d51187b8c4'::uuid, 250000),  -- WIP2610202147
  ('87b32d08-a5fb-4e6d-83fd-0eb454555208'::uuid, '3f52543c-b16a-4795-a975-b2cfa11e5be5'::uuid, 350000),  -- WIP2610202707
  ('2cf0e3a7-fb2e-469d-b9f5-d53bee6dad42'::uuid, '134793c6-00fc-4dff-9956-82ff793c85d8'::uuid, 500000),  -- WIP2610206273
  ('f3565a2d-f717-4c68-aaf2-2afd1082e0a3'::uuid, '58c6b627-bf91-43db-af95-7ccbdfc98a40'::uuid, 500000),  -- WIP2610209754
  ('f3c27a33-d10d-4f6c-89b8-ef189eaa154b'::uuid, 'aca7dbf4-b8f3-4c34-8aed-7f898c8f3adb'::uuid, 2000000),  -- WIP2610211174
  ('56650b81-37ab-49a8-910c-e36c67bf93ad'::uuid, '9059f1d5-d88b-42c5-9681-b8c80a7c9efd'::uuid, 400000),  -- WIP2610217508
  ('065c6e59-a73c-43be-853d-449317230ad8'::uuid, 'd19386d1-75cf-41c7-a28f-eb5780ce6042'::uuid, 10000000),  -- WIP2610221716
  ('e0ad10c5-1392-4b37-aabb-b319778abdb8'::uuid, '1a06f1f2-6075-448f-a673-590cc4ba837a'::uuid, 1000000),  -- WIP2610228711
  ('12dcb6f6-19b5-4337-8dc9-b260abb75000'::uuid, '378bad35-d162-4563-b5a6-0b3f8ff9d456'::uuid, 4000000),  -- WIP2610269952
  ('8659e0aa-397f-4c02-9233-ea82ac781cbb'::uuid, '497e9fb6-3254-42ce-adb0-851d80a0b64b'::uuid, 300000),  -- WIP2610282878
  ('3971e298-cf93-4383-9798-8aa8c612be84'::uuid, '6dd1e2c6-d493-4a49-b854-f86a06ff956d'::uuid, 70000),  -- WIP2610292507
  ('99b3768a-5323-421a-aacf-73015ef27965'::uuid, 'bd5b8510-e699-42fc-b0fb-72f5c117bd19'::uuid, 5000000),  -- WIP2610299408
  ('88b89f74-40b4-4dcb-a0e6-5c566202821b'::uuid, '56887204-c2dd-4386-8c34-e7ea5a802521'::uuid, 46000000),  -- WIP2611035055
  ('3a8da2d9-b2b2-458d-9945-66008f50dc86'::uuid, '97a04c7e-0cdd-4e1e-8d92-c94d80547425'::uuid, 100000000),  -- WIP2611038450
  ('51ff9478-0906-4acf-8441-ce5279d552df'::uuid, '41769185-4aa6-469b-a9e3-d9321d9b0239'::uuid, 400000),  -- WIP2611038718
  ('f3dabf7c-76da-43b3-b2e8-d5da4343ceaa'::uuid, '9927452e-e72c-4939-99ce-b0b265a43663'::uuid, 40000000),  -- WIP2611049880
  ('4d1f8793-4f8d-48d0-ba02-c61723db47c8'::uuid, '47bfafbc-82a7-4409-85dc-9f2a304690e0'::uuid, 300000),  -- WIP2611093311
  ('4b304432-460d-4fef-b5db-fea9a6e043cd'::uuid, '17162392-0b38-429a-a922-fd4ef1d0ee07'::uuid, 5700000),  -- WIP2611096496
  ('4c7eafb8-b530-4610-8eaa-e1c0984bdb5e'::uuid, '56f2e8f7-2e5d-428c-966c-6621c9727a8b'::uuid, 100000),  -- WIP2611098087
  ('408b2c1b-848c-45eb-85d0-adce11c32cd1'::uuid, 'fa5e5365-8649-4034-8931-591b3c6376f3'::uuid, 2000000),  -- WIP2611098820
  ('b35dfb8d-4479-40ff-96c6-48eeb55b3a56'::uuid, 'afb746d7-5a59-4b02-bf06-35b41858e426'::uuid, 100000),  -- WPF-5143
  ('a5f7d33e-5992-4470-ae27-1ad325c91f34'::uuid, 'bcbf7f60-1a1c-4c80-8718-e71bcf242773'::uuid, 85000)  -- WPF-9626
),
a7 as (select source_id note_id, sum(case when direction = 'cash_in' then amount else -amount end) net
       from public.general_ledger where category = 'partner_receivable_created' and ledger_scope = 'bridge' group by 1),
fi as (select note_id, sum(amount) amt from public.commission_fund_ins
       where note_id is not null and coalesce(status, '') <> 'reversed' group by 1),
n1 as (select 'N1' item, c.note_id, c.amount, coalesce(a7.net, 0) a7_now, least(coalesce(a7.net, 0), c.amount) release,
              coalesce(n.status = 'activated' and n.amount = c.amount and coalesce(n.total_collected, 0) = 0
                and p.investor_id = n.partner_user_id and p.investment_amount = c.amount and p.status = 'active'
                and coalesce(a7.net, 0) = c.amount, false) checks_ok
       from c left join public.promissory_notes n on n.id = c.note_id left join public.investor_portfolios p on p.id = c.portfolio_id
       left join a7 on a7.note_id = c.note_id),
n2 as (select 'N2' item, n.id note_id, n.amount, coalesce(a7.net, 0) a7_now,
              greatest(coalesce(a7.net, 0) - greatest(n.amount - least(n.amount, greatest(coalesce(n.total_collected, 0), coalesce(fi.amt, 0))), 0), 0) release,
              true checks_ok
       from public.promissory_notes n join fi on fi.note_id = n.id left join a7 on a7.note_id = n.id
       where n.id not in (select note_id from c))
select item, count(*) filter (where release > 0) notes, round(sum(release)) amount, count(*) filter (where not checks_ok) failing_checks
from (select * from n1 union all select * from n2) x group by 1 order by 1;
