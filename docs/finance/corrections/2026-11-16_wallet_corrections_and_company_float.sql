-- WALLET CORRECTIONS AND COMPANY FLOAT (items 4 and 5) — batch acct_corr_202611_wallet_l1. DRAFT, not approved.
--
-- ACCOUNTING RECORDS ONLY. NO MONEY MOVEMENT. Platform-scope journals only: no wallet leg; no wallet, deposit,
-- portfolio, correction or payout record changes; nothing is deleted. Runs AFTER migration 20261125110000.
--
-- CFO decisions 16 Nov 2026:
--   Item 4 — the CFO wallet debits of May–Aug 2026 were valid. The migration brings every withdrawable/locked wallet
--   correction into the statements (counterpart: Legacy Opening Balance Adjustments E3). This batch (part W) moves the
--   137 CFO debits that reversed an earlier credit to that credit's own account(s), in proportion to how the credit
--   was booked (W: 137 debits, UGX 239,348,299):
--     DR E3 wallet_correction_reclass_e3 / CR (or DR) the original accounts wallet_correction_reclass_<account>
--   dated on the debit's own date, tagged to the debit (general_ledger / its leg id).
--   Item 5 — Partner top-ups paid from company float with no Supporter custody receipt (float-origin trace of
--   16 Nov 2026; M1/K1 already covered 621.7M; "ambiguous" replays, 19.9M, are held for review). Part F, per traced
--   source (F: 250 groups, UGX 451,086,202):
--     mobile-money float received on the company line (UGX 278,870,860), as batch M1:
--       DR A1 verified_bank_cash_recognised / DR A8 agent_float_deposit / CR L1 cash_custody_payable / CR A2 agent_float_cash_offset
--     merchant / CFO / other company float (UGX 172,215,342): company float used; the Supporter's cash stays with the agent:
--       DR A8 agent_float_deposit / CR L1 cash_custody_payable
--   dated on the top-up's own date, tagged to the top-up's wallet leg (general_ledger / leg id); the mobile-money
--   groups are excluded from Money In (not new money).
-- Rollback: the same groups with directions swapped (see the end of this file).
begin isolation level repeatable read;

create temp table _expected (w_n int, w_amount numeric, f_n int, f_amount numeric) on commit drop;
insert into _expected values (137, 239348299, 250, 451086202);

-- W: CFO debit leg, amount, legs [[account, direction, amount], ...]
create temp table _w (leg uuid primary key, amount numeric not null, legs jsonb not null) on commit drop;
insert into _w (leg, amount, legs) values
  ('f6b80930-e64a-4c87-b21a-3adf8efe1c57', 800000, '[["E3", "cash_in", 800000], ["X1", "cash_out", 800000]]'::jsonb),
  ('458d48f4-248f-43ab-bbdd-0b4ea8c5fda5', 150000, '[["E3", "cash_in", 150000], ["X1", "cash_out", 150000]]'::jsonb),
  ('4e26648a-c046-457f-b4d5-4037ff45cb4c', 150000, '[["E3", "cash_in", 150000], ["X3", "cash_out", 150000]]'::jsonb),
  ('5c4c8790-d7b4-4917-b3f0-698fcee97898', 20000, '[["E3", "cash_in", 20000], ["X3", "cash_out", 20000]]'::jsonb),
  ('753eeb39-1642-4e8e-8b10-96328279ea3f', 10000, '[["E3", "cash_in", 10000], ["X3", "cash_out", 10000]]'::jsonb),
  ('502b5d6f-ad0c-4f1d-8ad0-db05d6e5c5e7', 150000, '[["E3", "cash_in", 150000], ["X1", "cash_out", 150000]]'::jsonb),
  ('81b66e47-b7aa-454d-924a-b0038983c5c0', 20000, '[["E3", "cash_in", 20000], ["X3", "cash_out", 20000]]'::jsonb),
  ('40508d9f-04f4-47b5-bbd7-c0d78a499c72', 5000, '[["E3", "cash_in", 5000], ["X3", "cash_out", 5000]]'::jsonb),
  ('d48ee179-2274-47af-adce-dbe9bc92b16d', 100000, '[["E3", "cash_in", 100000], ["X1", "cash_out", 100000]]'::jsonb),
  ('dc5f92c5-7718-4527-8279-2ef52f3d5447', 15000, '[["E3", "cash_in", 15000], ["A1", "cash_out", 15000]]'::jsonb),
  ('105f9041-f7a7-4e07-a1b8-347748c85161', 9638400, '[["E3", "cash_in", 9638400], ["X2", "cash_out", 9638400]]'::jsonb),
  ('c5fafdce-75a9-487d-9873-0afcac2115c1', 3937500, '[["E3", "cash_in", 3937500], ["X2", "cash_out", 3937500]]'::jsonb),
  ('9f714b56-b843-4247-ad2e-cb41a12de9c5', 750000, '[["E3", "cash_in", 750000], ["X2", "cash_out", 750000]]'::jsonb),
  ('2f9c28ca-a472-4e69-8136-8b4ed57cd3db', 500000, '[["E3", "cash_in", 500000], ["X2", "cash_out", 500000]]'::jsonb),
  ('26c68a65-74de-444b-9a48-91493259148e', 424000, '[["E3", "cash_in", 424000], ["X2", "cash_out", 424000]]'::jsonb),
  ('efd8c1f0-703f-429d-ab37-aeb5957aa20c', 400000, '[["E3", "cash_in", 400000], ["X2", "cash_out", 400000]]'::jsonb),
  ('e43f9efd-8b31-4626-839a-e1a96ad37e54', 300000, '[["E3", "cash_in", 300000], ["X2", "cash_out", 300000]]'::jsonb),
  ('655dd06a-68a2-4ea1-a798-0aadd2681538', 600000, '[["E3", "cash_in", 600000], ["X2", "cash_out", 600000]]'::jsonb),
  ('5bd41a90-418d-4f05-b382-e0b5c840eefe', 22000, '[["E3", "cash_in", 22000], ["A1", "cash_out", 22000]]'::jsonb),
  ('0a6e2386-4cc6-4c89-8c9e-ca263ad343e6', 285000, '[["E3", "cash_in", 285000], ["X3", "cash_out", 285000]]'::jsonb),
  ('e05dabc8-b562-4f25-8963-1018d3391d64', 45000, '[["E3", "cash_in", 45000], ["X3", "cash_out", 45000]]'::jsonb),
  ('1444a101-284e-4ea3-b98f-e3989c681779', 15000, '[["E3", "cash_in", 15000], ["X2", "cash_out", 15000]]'::jsonb),
  ('e7db7ce4-932d-4ea5-8acd-42f8a2488aa0', 20000, '[["E3", "cash_in", 20000], ["X3", "cash_out", 20000]]'::jsonb),
  ('30aa9a55-eea8-436a-8f38-1b37befe3eff', 590500, '[["E3", "cash_in", 590500], ["X3", "cash_out", 590500]]'::jsonb),
  ('ae6ba38b-eb1d-4e72-bc6a-be477d0cc926', 400000, '[["E3", "cash_in", 400000], ["X3", "cash_out", 400000]]'::jsonb),
  ('a85a93ae-5ebb-4ebc-aa4b-540fac01e16f', 50000, '[["E3", "cash_in", 50000], ["X3", "cash_out", 50000]]'::jsonb),
  ('1b206177-b68f-49c9-a66f-2105ae0dfa30', 50000, '[["E3", "cash_in", 50000], ["X3", "cash_out", 50000]]'::jsonb),
  ('c2f8f447-7ea4-4650-adc1-0bf9a0ee85d2', 500000, '[["E3", "cash_in", 500000], ["X1", "cash_out", 500000]]'::jsonb),
  ('a2c497dd-6872-4b1a-834b-133120664fdd', 280000, '[["E3", "cash_in", 280000], ["A1", "cash_out", 280000]]'::jsonb),
  ('ba6c113f-292a-4465-be27-27889ee9e76c', 230000, '[["E3", "cash_in", 230000], ["A1", "cash_out", 230000]]'::jsonb),
  ('ec2ad3b6-34fb-4af2-a507-6ce83e844eb5', 4000000, '[["E3", "cash_in", 4000000], ["A1", "cash_out", 4000000]]'::jsonb),
  ('b3023804-672f-4e95-aa0a-aff22c10ab49', 2000000, '[["E3", "cash_in", 2000000], ["X3", "cash_out", 2000000]]'::jsonb),
  ('077058dd-672d-4915-aad2-275470e38197', 1000000, '[["E3", "cash_in", 1000000], ["A2", "cash_in", 1000000], ["X4", "cash_out", 2000000]]'::jsonb),
  ('6c0be795-0bfa-46af-a64e-3e85e5c83491', 10000000, '[["E3", "cash_in", 10000000], ["A1", "cash_out", 10000000]]'::jsonb),
  ('b7ea7130-8117-4bd0-a9c1-d5fdd1c7a73d', 360000, '[["E3", "cash_in", 360000], ["X3", "cash_out", 360000]]'::jsonb),
  ('4fcbbce7-e997-408f-9a02-cd680b9e80c1', 45000, '[["E3", "cash_in", 45000], ["X3", "cash_out", 45000]]'::jsonb),
  ('be1e5d19-f426-4efe-8d1b-226d7abb667a', 20000, '[["E3", "cash_in", 20000], ["X3", "cash_out", 20000]]'::jsonb),
  ('b696d9d2-5f8b-4ba7-833e-75d7f0bdf770', 55000, '[["E3", "cash_in", 55000], ["X3", "cash_out", 55000]]'::jsonb),
  ('2423e9c3-4672-48df-b864-201a14232f0d', 1000000, '[["E3", "cash_in", 1000000], ["X2", "cash_out", 1000000]]'::jsonb),
  ('57d65520-baa3-446b-9711-7676652d45fe', 2400000, '[["E3", "cash_in", 2400000], ["X2", "cash_out", 2400000]]'::jsonb),
  ('b20e1202-c3ce-46f0-8b25-8504b12bcad6', 150000, '[["E3", "cash_in", 150000], ["X3", "cash_out", 150000]]'::jsonb),
  ('fa0c3195-8f1e-4f18-9073-d89b32df48a5', 500000, '[["E3", "cash_in", 500000], ["X3", "cash_out", 500000]]'::jsonb),
  ('735c1dbf-84c2-4315-abcc-2029bebb4ea3', 1300000, '[["E3", "cash_in", 1300000], ["X3", "cash_out", 1300000]]'::jsonb),
  ('de4ef5d1-b4a2-4695-80e9-7608a7e64ae3', 1300000, '[["E3", "cash_in", 1300000], ["X3", "cash_out", 1300000]]'::jsonb),
  ('a4d1fc68-625f-4265-925f-298f17d6e887', 500000, '[["E3", "cash_in", 500000], ["X3", "cash_out", 500000]]'::jsonb),
  ('92db891e-901a-4d37-a3f6-64b423d3a212', 500000, '[["E3", "cash_in", 500000], ["X3", "cash_out", 500000]]'::jsonb),
  ('87499016-bbaa-4b36-8244-5c01f1c209f4', 2000000, '[["E3", "cash_in", 2000000], ["A1", "cash_out", 2000000]]'::jsonb),
  ('718e861d-1dcb-4c9d-a884-1506c97d3c0d', 300000, '[["E3", "cash_in", 300000], ["X3", "cash_out", 300000]]'::jsonb),
  ('2dff539b-2c63-40b9-b358-3a70a1064004', 50000000, '[["E3", "cash_in", 50000000], ["A2", "cash_in", 50000000], ["X4", "cash_out", 100000000]]'::jsonb),
  ('46fd662c-a318-4512-92c6-352c0d0bda84', 10000000, '[["E3", "cash_in", 10000000], ["X3", "cash_out", 10000000]]'::jsonb),
  ('23e401b6-cb6e-4efb-9eb3-cb84838c6ccb', 69000, '[["E3", "cash_in", 69000], ["X1", "cash_out", 69000]]'::jsonb),
  ('a4103bac-1971-45d9-8a4a-9dbad88d72d6', 500000, '[["E3", "cash_in", 500000], ["X3", "cash_out", 500000]]'::jsonb),
  ('1db7b223-46a5-4e5a-9589-f209c6da0294', 620000, '[["E3", "cash_in", 620000], ["X3", "cash_out", 620000]]'::jsonb),
  ('6da92fad-4531-447a-afa1-227a0033a625', 30000, '[["E3", "cash_in", 30000], ["A1", "cash_out", 30000]]'::jsonb),
  ('dd1734e0-033b-440a-8f32-85f1e98d33b2', 50000000, '[["E3", "cash_in", 50000000], ["X3", "cash_out", 50000000]]'::jsonb),
  ('d23feace-3c0e-4d7a-80c6-80d9b3356454', 48000, '[["E3", "cash_in", 48000], ["X2", "cash_out", 48000]]'::jsonb),
  ('623725f1-aedd-4098-937c-7a19f966ecf9', 100000, '[["E3", "cash_in", 100000], ["A2", "cash_in", 100000], ["X4", "cash_out", 200000]]'::jsonb),
  ('96472469-dbc7-4530-af7d-1b1eccc7fb49', 80000, '[["E3", "cash_in", 80000], ["X3", "cash_out", 80000]]'::jsonb),
  ('21272fe1-cb80-4d60-869a-a67817cf8caf', 180000, '[["E3", "cash_in", 180000], ["X3", "cash_out", 180000]]'::jsonb),
  ('0d05040b-d02e-41ba-a389-e49b00ad5731', 85000, '[["E3", "cash_in", 85000], ["X1", "cash_out", 85000]]'::jsonb),
  ('dfe6cbcd-746b-470c-8877-3b42c59c02ef', 235000, '[["E3", "cash_in", 235000], ["X3", "cash_out", 235000]]'::jsonb),
  ('ce2d6eea-97de-4b86-b207-4cfd3a57197d', 60000, '[["E3", "cash_in", 60000], ["X3", "cash_out", 60000]]'::jsonb),
  ('8329c334-a2e0-4cbc-b729-608e1994f9a2', 2000000, '[["E3", "cash_in", 2000000], ["X3", "cash_out", 2000000]]'::jsonb),
  ('93953d15-c6f6-4c2f-baef-00c15a469d76', 1100000, '[["E3", "cash_in", 1100000], ["X3", "cash_out", 1100000]]'::jsonb),
  ('f451f5ff-420b-46e4-994d-83e95f9c229d', 520000, '[["E3", "cash_in", 520000], ["X3", "cash_out", 520000]]'::jsonb),
  ('e5dfe9e6-2aa7-461c-ab1b-d6cd03a0e2cf', 140000, '[["E3", "cash_in", 140000], ["X1", "cash_out", 140000]]'::jsonb),
  ('512fe666-8ecb-4e56-90bd-dc75e4574ea9', 30000, '[["E3", "cash_in", 30000], ["X3", "cash_out", 30000]]'::jsonb),
  ('a42343ae-2f5e-4612-95fa-e018cf621e89', 48000, '[["E3", "cash_in", 48000], ["X2", "cash_out", 48000]]'::jsonb),
  ('24587bd4-990f-4c41-8666-49b84e442e3b', 650000, '[["E3", "cash_in", 650000], ["X3", "cash_out", 650000]]'::jsonb),
  ('748564e3-e189-4308-bcb8-34ff7ef29d4b', 100000, '[["E3", "cash_in", 100000], ["X3", "cash_out", 100000]]'::jsonb),
  ('396b605b-c032-4e84-91b3-75817a966f47', 50000, '[["E3", "cash_in", 50000], ["X1", "cash_out", 50000]]'::jsonb),
  ('9b29c7f3-8d89-4541-8852-85e4ce9e525a', 18900, '[["E3", "cash_in", 18900], ["X1", "cash_out", 18900]]'::jsonb),
  ('44922787-b3e5-4fd5-bd28-bec870fc6136', 500, '[["E3", "cash_in", 500], ["X1", "cash_out", 500]]'::jsonb),
  ('5b59b519-4cf9-4348-a833-4a2363cc3230', 500, '[["E3", "cash_in", 500], ["X1", "cash_out", 500]]'::jsonb),
  ('eef5136c-3287-47b2-9e68-1cde1e289380', 5000, '[["E3", "cash_in", 5000], ["X3", "cash_out", 5000]]'::jsonb),
  ('d3b07910-f1dd-4b84-b80b-ea70ba60f762', 500, '[["E3", "cash_in", 500], ["X1", "cash_out", 500]]'::jsonb),
  ('47d7abd8-9021-413d-8ab1-97027a86e672', 500, '[["E3", "cash_in", 500], ["X1", "cash_out", 500]]'::jsonb),
  ('5d4fd0b5-bf70-47fd-9756-2fc20daeeeea', 305000, '[["E3", "cash_in", 305000], ["X3", "cash_out", 305000]]'::jsonb),
  ('c90f53f9-68a2-4ed3-9616-6539be1fe6da', 1000, '[["E3", "cash_in", 1000], ["X1", "cash_out", 1000]]'::jsonb),
  ('afb0b7cf-1b3d-4e2f-a19d-5525d39a5a32', 350000, '[["E3", "cash_in", 350000], ["X1", "cash_out", 350000]]'::jsonb),
  ('0b67f9d2-8fee-4370-9d86-8999ec641d62', 1000, '[["E3", "cash_in", 1000], ["X1", "cash_out", 1000]]'::jsonb),
  ('69c9a7fd-bf23-4a27-aa7b-ef0bf1cef341', 1500000, '[["E3", "cash_in", 1500000], ["X1", "cash_out", 1500000]]'::jsonb),
  ('07828ede-0244-4585-9e1e-94d102bfe4c4', 4000000, '[["E3", "cash_in", 4000000], ["X3", "cash_out", 4000000]]'::jsonb),
  ('7bad0d16-d86b-4833-8053-7c48d4db395e', 200000, '[["E3", "cash_in", 200000], ["X3", "cash_out", 200000]]'::jsonb),
  ('32930143-44ae-47c0-b122-991abcdeeb33', 100000, '[["E3", "cash_in", 100000], ["X3", "cash_out", 100000]]'::jsonb),
  ('2a17b24d-b4dd-480c-bd8f-0a145445269a', 60000, '[["E3", "cash_in", 60000], ["X3", "cash_out", 60000]]'::jsonb),
  ('150033b5-9b6b-4a5c-8445-4504f7a00c54', 110000, '[["E3", "cash_in", 110000], ["X3", "cash_out", 110000]]'::jsonb),
  ('7515b1d7-f2a2-4f5b-8a2f-0850309fa845', 400000, '[["E3", "cash_in", 400000], ["X1", "cash_out", 400000]]'::jsonb),
  ('c0c9cf94-d1c8-4425-83b2-c2798a0f153d', 550000, '[["E3", "cash_in", 550000], ["X1", "cash_out", 550000]]'::jsonb),
  ('e9977e28-710f-499b-8116-71aa775c8729', 600000, '[["E3", "cash_in", 600000], ["X1", "cash_out", 600000]]'::jsonb),
  ('5739f236-0c2a-49f4-a53f-329765f6020b', 800000, '[["E3", "cash_in", 800000], ["X1", "cash_out", 800000]]'::jsonb),
  ('56474351-4035-40e6-8d9c-b482e1a6ccfb', 1000000, '[["E3", "cash_in", 1000000], ["X1", "cash_out", 1000000]]'::jsonb),
  ('1af6feb6-f5e1-41fe-bd84-a0d5ba51fc5b', 1200000, '[["E3", "cash_in", 1200000], ["X1", "cash_out", 1200000]]'::jsonb),
  ('d0f72d22-53dd-4690-984c-322dc2b168cf', 2000000, '[["E3", "cash_in", 2000000], ["X1", "cash_out", 2000000]]'::jsonb),
  ('3c2d6310-afad-48cb-9a1a-db90936c469a', 600000, '[["E3", "cash_in", 600000], ["X1", "cash_out", 600000]]'::jsonb),
  ('d32bcdb7-e484-45d0-bc81-80934d8476c0', 2000000, '[["E3", "cash_in", 2000000], ["X1", "cash_out", 2000000]]'::jsonb),
  ('6fa6e968-5a5d-4ebf-82d0-d7c546e0f024', 100000, '[["E3", "cash_in", 100000], ["X1", "cash_out", 100000]]'::jsonb),
  ('b0490c96-09e9-4721-b1e1-f94e8f78dd5d', 500000, '[["E3", "cash_in", 500000], ["X1", "cash_out", 500000]]'::jsonb),
  ('c14634ff-b3cd-4000-8da7-f5e124311366', 600000, '[["E3", "cash_in", 600000], ["X1", "cash_out", 600000]]'::jsonb),
  ('00084d55-493a-479d-9248-7b53b886fc76', 150000, '[["E3", "cash_in", 150000], ["X1", "cash_out", 150000]]'::jsonb),
  ('284636b8-ad20-40dc-9489-81fe61ffee67', 2000000, '[["E3", "cash_in", 2000000], ["X3", "cash_out", 2000000]]'::jsonb),
  ('bcbedbce-1151-4cdc-8af8-d57fdc0ece98', 600000, '[["E3", "cash_in", 600000], ["X1", "cash_out", 600000]]'::jsonb),
  ('16b37241-39f3-407b-b7f6-7db97276e1f7', 4999999, '[["E3", "cash_in", 4999999], ["X3", "cash_out", 4999999]]'::jsonb),
  ('98ee7cfc-77ee-4d18-b570-1aeb19848c0f', 10000, '[["E3", "cash_in", 10000], ["A2", "cash_in", 10000], ["X4", "cash_out", 20000]]'::jsonb),
  ('6adef2e7-db00-4cf5-bdc8-bc740d732660', 40000, '[["E3", "cash_in", 40000], ["X3", "cash_out", 40000]]'::jsonb),
  ('742fc5e8-7f48-479a-b0b6-b85aeceee423', 3000000, '[["E3", "cash_in", 3000000], ["X2", "cash_out", 3000000]]'::jsonb),
  ('cba0261b-b3ad-4974-8133-140c7efcc253', 1200000, '[["E3", "cash_in", 1200000], ["A10", "cash_out", 1200000]]'::jsonb),
  ('5d5b18b5-0e18-4940-ab9c-ba5e4c151895', 209500, '[["E3", "cash_in", 209500], ["X3", "cash_out", 209500]]'::jsonb),
  ('5f179abf-dd12-4f1c-b0d8-c02512d6a756', 5000000, '[["E3", "cash_in", 5000000], ["X3", "cash_out", 5000000]]'::jsonb),
  ('e132c164-0e20-4f9e-ac48-7c941a1771ab', 500000, '[["E3", "cash_in", 500000], ["X3", "cash_out", 500000]]'::jsonb),
  ('8e699b66-f55c-4959-97d3-e16048ab3ed1', 500, '[["E3", "cash_in", 500], ["X1", "cash_out", 500]]'::jsonb),
  ('d29c8c4d-16fe-4155-ab84-4e7a2a5657a2', 80000, '[["E3", "cash_in", 80000], ["X3", "cash_out", 80000]]'::jsonb),
  ('a066cccc-94cd-4568-aa2d-a536917ea0bb', 500000, '[["E3", "cash_in", 500000], ["A10", "cash_out", 500000]]'::jsonb),
  ('99d1aa7e-cc26-4cf1-9c2f-f1fbfe1230b7', 3000000, '[["E3", "cash_in", 3000000], ["X3", "cash_out", 3000000]]'::jsonb),
  ('04d97c6c-7da0-4c85-9704-f1b3373c8684', 200000, '[["E3", "cash_in", 200000], ["X3", "cash_out", 200000]]'::jsonb),
  ('e726c276-5384-41a7-8a44-31896a7885af', 2000000, '[["E3", "cash_in", 2000000], ["X3", "cash_out", 2000000]]'::jsonb),
  ('724f2be9-b8a6-4c37-aa52-f4620e4c29a7', 100000, '[["E3", "cash_in", 100000], ["L6", "cash_out", 100000]]'::jsonb),
  ('0938d071-7f2c-4e24-a076-7ebfa944459a', 420000, '[["E3", "cash_in", 420000], ["X3", "cash_out", 420000]]'::jsonb),
  ('a25e1327-bb17-405a-8387-e78d931499b6', 1000000, '[["E3", "cash_in", 1000000], ["X3", "cash_out", 1000000]]'::jsonb),
  ('5911c2c9-4550-440c-bbcd-53b5b2b507fe', 2500000, '[["E3", "cash_in", 2500000], ["X1", "cash_out", 2500000]]'::jsonb),
  ('bd800fc2-6e1a-4f35-9190-4c9331611315', 30000, '[["E3", "cash_in", 30000], ["X3", "cash_out", 30000]]'::jsonb),
  ('3eccbfb1-713b-4195-ac4e-92bbb0bfb386', 20000000, '[["E3", "cash_in", 20000000], ["X1", "cash_out", 20000000]]'::jsonb),
  ('63573764-e6fa-4a42-aa6d-bc3e51a0e4ba', 1200000, '[["E3", "cash_in", 1200000], ["A1", "cash_out", 1200000]]'::jsonb),
  ('cc7f1037-b319-4ba1-9f52-37c92c1a2add', 300000, '[["E3", "cash_in", 300000], ["X3", "cash_out", 300000]]'::jsonb),
  ('8ac8b609-1f79-4ec6-9949-bbf588bc74e6', 1680000, '[["E3", "cash_in", 1680000], ["A1", "cash_out", 1680000]]'::jsonb),
  ('73a4e61e-2c54-4c69-88dc-270aa3cabd92', 440000, '[["E3", "cash_in", 440000], ["A10", "cash_out", 440000]]'::jsonb),
  ('ef589774-e177-4194-820a-2fc373e15230', 75000, '[["E3", "cash_in", 75000], ["X3", "cash_out", 75000]]'::jsonb),
  ('57615350-a853-47a3-920b-e39a2cf9324b', 985000, '[["E3", "cash_in", 985000], ["X3", "cash_out", 985000]]'::jsonb),
  ('d99a9cd8-0ce5-4909-a966-ead890ce03f6', 40000, '[["E3", "cash_in", 40000], ["X3", "cash_out", 40000]]'::jsonb),
  ('3def5913-4f5c-4839-913a-ce77b3feac90', 50000, '[["E3", "cash_in", 50000], ["A1", "cash_out", 50000]]'::jsonb),
  ('9a6e975f-045a-4cee-8bce-8f88971eef8d', 2500000, '[["E3", "cash_in", 2500000], ["X1", "cash_out", 2500000]]'::jsonb),
  ('84b3bb11-67ed-49f1-b021-8ba68d37464a', 500000, '[["E3", "cash_in", 500000], ["X3", "cash_out", 500000]]'::jsonb),
  ('fc82f58e-7821-40b0-a816-fb86f06d9d80', 150000, '[["E3", "cash_in", 150000], ["X1", "cash_out", 150000]]'::jsonb),
  ('4864c5e2-805c-4f72-9ba8-d7bcfc82ab89', 205000, '[["E3", "cash_in", 205000], ["X1", "cash_out", 205000]]'::jsonb),
  ('4f7cbd2a-2288-41a3-b957-d4b094a8929c', 400000, '[["E3", "cash_in", 400000], ["A10", "cash_out", 400000]]'::jsonb),
  ('848b451b-b5bc-4218-bb35-6c80563b9473', 1000000, '[["E3", "cash_in", 1000000], ["A2", "cash_in", 1000000], ["X4", "cash_out", 2000000]]'::jsonb),
  ('f62716da-f784-418b-9b73-dacae07d8de3', 748000, '[["E3", "cash_in", 748000], ["X1", "cash_out", 748000]]'::jsonb)
;

-- F: Partner top-up wallet leg, kind (momo | float), deposit (momo only), amount, traced source classes
create temp table _f (payment_leg uuid not null, kind text not null, deposit_id uuid, amount numeric not null, classes text) on commit drop;
create unique index on _f (payment_leg, kind, coalesce(deposit_id::text, ''));
insert into _f (payment_leg, kind, deposit_id, amount, classes) values
  ('10bc794d-b9aa-4e0a-8664-076b77552fd4', 'momo', '3130fdf4-f963-49f3-836c-94a974fd608c', 150000, 'B-momo'),
  ('f03f8b71-7629-4fd1-9e18-59ce5e68e9ac', 'momo', '6c8c71ff-57bb-491f-9f56-7f9ea219987d', 100000, 'B-momo'),
  ('f7c0e20c-5197-4938-b6e0-9d412d404977', 'float', null, 2000000, 'B-cfo'),
  ('b058534d-073e-4fb9-b274-92aa9dec7cbe', 'momo', '328f77d0-99dd-447b-95c1-06e11edb5e00', 700000, 'B-momo'),
  ('75dc0c41-d4f1-4d4f-994a-4268b4b34ffb', 'float', null, 517000, 'B-cfo'),
  ('e3c91f0c-7b9a-4a5c-a638-962d9789067e', 'float', null, 88800, 'B-cfo'),
  ('a2e77da3-f35b-428d-baaa-9149d4e6d5cb', 'float', null, 3000000, 'B-cfo'),
  ('f4715ba4-2c0b-450b-a3b2-952eb761eb57', 'float', null, 2000000, 'B-cfo'),
  ('e6099666-9af3-4db7-8f19-d553f3761a47', 'float', null, 2000000, 'B-cfo'),
  ('3344f1e9-d7c5-4d13-b799-750471a55804', 'momo', 'ac384153-6943-4410-90b8-a015050b3d33', 450000, 'B-momo'),
  ('8da4767c-a736-4cbe-b1cb-bcaba59cb29a', 'float', null, 200000, 'B-cfo'),
  ('7fdc2d8d-dd8d-40a6-bca6-1f3d634d5a8a', 'momo', '65943331-3cb0-4b58-b290-5df45e0f368e', 1100000, 'B-momo'),
  ('52981ec7-fd7f-4c55-ad63-2363890e1ab3', 'float', null, 1142000, 'B-merchant'),
  ('52981ec7-fd7f-4c55-ad63-2363890e1ab3', 'momo', '8f1b72fd-1316-42e2-b830-1a0181e022db', 358000, 'B-momo'),
  ('28362df7-b20e-4f43-a600-1d170ff09af2', 'float', null, 3000000, 'B-cfo'),
  ('04388d40-6e36-43b7-9970-a83924186f28', 'momo', 'ec96dca6-cdb1-4f9d-a0ff-be46e478fe92', 1000000, 'B-momo'),
  ('a203a095-e743-45b8-b593-5589e6d667d4', 'float', null, 155000, 'B-cfo'),
  ('b6fc0cd4-9873-4d22-bee0-4fe5aef95871', 'float', null, 3700000, 'B-cfo'),
  ('1a96e388-deb2-4106-ae32-eadb2da4df07', 'float', null, 2500000, 'B-cfo'),
  ('3dfc5187-3f91-4eae-8449-01103fad5fcb', 'momo', '9e98d5b9-96af-4575-a754-5d853dc09a6e', 600000, 'B-momo'),
  ('cefdcdd1-a986-47f9-b224-cf740d619785', 'float', null, 500000, 'B-cfo'),
  ('098bb7ec-b8b2-4941-b9ab-a0e777ceaf0c', 'float', null, 2000000, 'B-cfo+B-other'),
  ('8f054667-e60a-4fbc-b795-cc6482731e88', 'float', null, 1947380, 'B-merchant'),
  ('8f054667-e60a-4fbc-b795-cc6482731e88', 'momo', 'ca1b5ab5-401b-4150-94db-30205e026728', 52620, 'B-momo'),
  ('fb58b2eb-5bdd-4a53-a5e9-4ec47229b178', 'float', null, 5000000, 'B-merchant'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', 'f30596b8-1e87-4ad8-8dae-2ef58a63901d', 5000000, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', 'e8bcd3f5-32eb-426b-a009-54971b6045e9', 5000000, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', 'e4c30440-fd6a-46ea-a906-baf4f29c5073', 5000000, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', 'b9cd7065-140f-435b-9ac5-3bd2475ea8dc', 3638420, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'float', null, 2941620, 'B-merchant'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', 'f0545eaf-48d5-439d-9afe-bbdbd0a5be87', 2000000, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', 'f810f82c-bd55-4fdd-af9b-7916e5fe6602', 1500000, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', '792cdbb0-af52-4674-a872-8c9e981b6d45', 1100000, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', '62558b7b-8a2e-4aa6-a61e-b5f0c9837b4d', 1000000, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', '98bec4cf-d9ed-44e2-bb12-1ebf2cbfb277', 1000000, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', 'd768d95d-b742-4777-85bb-6123cbbc5b29', 700000, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', '983fd663-fbb7-4e4d-9da6-9a72f3acbe12', 600000, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', 'b2ec85e0-cb72-4a9a-b162-fa1d7a65aef4', 250000, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', 'a0a29b6c-d88b-4c9a-a238-e2fa98cdc837', 201960, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', '789a31e5-2eb1-4480-848c-8e6c3f67cdd9', 50000, 'B-momo'),
  ('82a4fdfd-69d0-4a78-bc1d-59dd01bd5778', 'momo', '13acb818-eaf4-406f-be63-21e64d12eea1', 18000, 'B-momo'),
  ('c5b43a22-d39a-425c-9c10-65c3a264537a', 'momo', 'b9cd7065-140f-435b-9ac5-3bd2475ea8dc', 1211580, 'B-momo'),
  ('c5b43a22-d39a-425c-9c10-65c3a264537a', 'momo', 'df2f9e75-8de5-4b3f-8498-88cfd5eec8fc', 100000, 'B-momo'),
  ('4497f09b-a508-47dc-827e-541a2b17d437', 'momo', '4f4ed1b7-cba5-45de-b9ab-dfe3cb5d5f7f', 2600000, 'B-momo'),
  ('a3ecea50-fd87-4396-a03a-b4e22e60db31', 'float', null, 1500000, 'B-cfo'),
  ('cca433b9-a5e3-404d-b8bb-726aced688cc', 'momo', '1179f9be-2bac-41b0-85b3-ab6aad39cb07', 3500000, 'B-momo'),
  ('899a9930-6e25-4bd3-9b40-a35b6d6ee408', 'momo', '87ebe666-eb1c-47f6-a4f5-70c7bc59aa00', 100000, 'B-momo'),
  ('0a2bc07b-efd7-44ab-9a0e-0fdb3b776640', 'momo', '9124c51f-49a0-4634-a45c-a2edc82332a8', 5000000, 'B-momo'),
  ('0a2bc07b-efd7-44ab-9a0e-0fdb3b776640', 'float', null, 4391800, 'B-merchant'),
  ('0a2bc07b-efd7-44ab-9a0e-0fdb3b776640', 'momo', '1c6aac71-d27f-470e-91a1-45efacf7516b', 608200, 'B-momo'),
  ('5f5d1c42-4684-4223-b074-e3942e97d7da', 'momo', '6cb4b5fa-285d-4928-9211-a8da3bf420d6', 3000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '52f66946-0867-42de-a0d9-a72588a0c061', 5000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '8a552842-b7d5-404e-ab43-a5194de84a24', 5000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', 'ef45bd9c-8778-483b-ab0f-3392e58dd738', 5000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '7550ebde-a3ff-4407-a9f2-010a56c67040', 5000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', 'b6dd35c2-d9f9-42f7-ae79-0645d2088808', 5000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '37c11857-79dd-40bb-988b-f9c709f9d490', 5000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '66589c96-1e23-4365-90ff-aa01a96d83e2', 5000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'float', null, 9000000, 'B-merchant'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '1c71bbe3-501c-49f6-895b-2e748f61954b', 3000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '0dd0c328-9667-4a46-b331-9f58c0426ce5', 2758200, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', 'cb983fc7-0101-497d-9ed6-fe9bced87fc9', 2200000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '6e0ba940-307f-4637-a6a8-d543372b4c40', 2000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '8cdb2d33-2be8-4617-8c2c-f03535295d19', 2000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '16573034-5e38-47d9-bace-2006e232fe82', 1500000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', 'c7b46ec0-5988-407e-b7fb-537cb93a212a', 1000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '43a31796-b44e-472c-9566-feb4346d3fd8', 1000000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', 'c1462608-e236-428a-8ec3-b53193a32b14', 300000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '69a525a1-2c37-4e37-a7f0-5d25e6b9a60d', 100000, 'B-momo'),
  ('4fff3d3f-57c2-4220-b2bf-9f68ada8f8ef', 'momo', '1c6aac71-d27f-470e-91a1-45efacf7516b', 41800, 'B-momo'),
  ('6ef7b79c-8599-4fe2-821a-fa21db4fb075', 'float', null, 500000, 'B-merchant'),
  ('c9c7e3fb-bcb9-4100-963b-92f45908a8d8', 'momo', '435721f1-3743-4bc7-a8fc-4d92c1746e14', 500000, 'B-momo'),
  ('c9c7e3fb-bcb9-4100-963b-92f45908a8d8', 'momo', 'db1109ce-c143-4694-a6c8-9e0c97f21b44', 500000, 'B-momo'),
  ('d59a1527-5b85-4c80-a030-f76326496105', 'float', null, 1100000, 'B-merchant'),
  ('ba33e951-16b3-461b-9c45-dd8d76594afe', 'momo', '5fd5f0ac-7cc4-4be5-bcd0-104eca670d01', 1000000, 'B-momo'),
  ('a3a44c5c-7fe2-4cd5-b655-6b580d5dc307', 'momo', 'e3149db4-3be1-4104-aa92-4fbb92e07aab', 2000000, 'B-momo'),
  ('b816c3a5-3f5e-4b03-813a-a934dc960840', 'float', null, 2000000, 'B-merchant'),
  ('0f684f4c-821a-4e87-a4ba-e1dc48431829', 'float', null, 100000, 'B-merchant'),
  ('7842317e-7f5e-4dae-b97f-1c6aa2079fc7', 'float', null, 40000, 'B-cfo'),
  ('85f471bd-daa7-48df-b06a-ea6f74d99de8', 'float', null, 20000, 'B-cfo'),
  ('fc418038-d416-4c56-b7ef-7aceb2ec616f', 'float', null, 180000, 'B-cfo'),
  ('78306640-26b3-4aa3-8714-60f71ecff916', 'momo', '1d160e1d-706d-4558-8e01-8e0db7231ecb', 100000, 'B-momo'),
  ('3ef20590-1afa-4d25-8b80-6d2ba3f661fe', 'momo', '37aae1e1-8ccc-421b-8143-8014293a591b', 1434646, 'B-momo'),
  ('3ef20590-1afa-4d25-8b80-6d2ba3f661fe', 'float', null, 2065354, 'B-merchant'),
  ('06484a0d-4316-4815-b3e5-4fad0025bfe6', 'momo', '37aae1e1-8ccc-421b-8143-8014293a591b', 850000, 'B-momo'),
  ('4eb2190a-e771-44c1-b613-2ae1a4236d78', 'float', null, 560000, 'B-cfo'),
  ('e44b8033-b9de-4d13-b706-1bf205a2826c', 'float', null, 2700000, 'B-cfo'),
  ('c2eb1c73-921d-4435-9b0f-75b819bc37e6', 'momo', '865e35fe-0998-4c08-8712-141fa294084b', 5000000, 'B-momo'),
  ('c2eb1c73-921d-4435-9b0f-75b819bc37e6', 'float', null, 2784646, 'B-merchant'),
  ('c2eb1c73-921d-4435-9b0f-75b819bc37e6', 'momo', '37aae1e1-8ccc-421b-8143-8014293a591b', 2215354, 'B-momo'),
  ('f9e181b4-e881-42b6-93f4-da4a99fcea88', 'momo', 'ea2a06c8-68e1-4a88-866a-e5cfe5ac4185', 5000000, 'B-momo'),
  ('f9e181b4-e881-42b6-93f4-da4a99fcea88', 'momo', '50f6489c-dece-4840-9570-f8129713d02a', 4000000, 'B-momo'),
  ('268e5cb2-670e-4dad-8955-22d15a85d305', 'momo', '37aae1e1-8ccc-421b-8143-8014293a591b', 500000, 'B-momo'),
  ('1c3cf5f1-21ca-48eb-9ddf-b9b0f59cdd48', 'float', null, 842354, 'B-merchant'),
  ('d6b01483-3c8f-446f-a13c-4e4d2f1ba5fd', 'momo', 'f450ac60-acc7-47be-98e8-90bf24e8b1b7', 550000, 'B-momo'),
  ('dd73636d-0765-482c-ab8b-dc363aaa06c0', 'momo', 'be462bc6-9160-4e96-af10-be65d7f6f91d', 500000, 'B-momo'),
  ('dd671276-88a6-4c72-8ec8-7cedfa078534', 'momo', '04146310-ba2d-4499-96af-ebebe1ffeff6', 5000000, 'B-momo'),
  ('9073a4a5-0785-4106-bc07-9b175226d4dd', 'float', null, 15000, 'B-merchant'),
  ('542fae7e-ee65-48be-ac52-924aa0f76b29', 'float', null, 550000, 'B-cfo'),
  ('f0037d36-a0d3-4749-afb8-f9ec48ada066', 'momo', '1eab84a5-6616-4776-aa1e-362f24aa83fe', 3000000, 'B-momo'),
  ('43e5db5d-988d-49a1-8bee-efd509063728', 'float', null, 400000, 'B-cfo'),
  ('4f79ab78-4cac-4fe7-97fe-fe268f30a139', 'float', null, 26411420, 'B-merchant'),
  ('4f79ab78-4cac-4fe7-97fe-fe268f30a139', 'momo', '335e2022-5206-4c5f-bd7d-0c0550390e7e', 5000000, 'B-momo'),
  ('75e0058f-c7b9-4756-afa0-15a1423912d4', 'float', null, 402000, 'B-cfo'),
  ('0cadf722-173d-4469-a888-55451f2419d2', 'float', null, 500000, 'B-merchant'),
  ('e468b474-7368-4d51-b982-a564f73b8dbb', 'momo', 'b3b25bbd-3a3f-4cb6-af27-80c70a899d81', 1000000, 'B-momo'),
  ('f713ac09-30f9-4550-84d4-2c83f34634eb', 'float', null, 107539, 'B-merchant'),
  ('de74031e-29a5-4419-bbab-2f73440dca9a', 'float', null, 1000000, 'B-cfo'),
  ('a05d06d8-0055-49c4-8357-928219c5bf7e', 'float', null, 500000, 'B-cfo'),
  ('c675af6e-569e-4464-a4ce-3e7d2a2700c8', 'momo', '034d6e65-3af9-442b-b407-13ade6f879f1', 200000, 'B-momo'),
  ('afe68a60-0ac4-4bd0-aa89-8caafea1c014', 'momo', '034d6e65-3af9-442b-b407-13ade6f879f1', 3214, 'B-momo'),
  ('eed5e5dd-22e1-46a6-849a-8f365134a6b0', 'float', null, 10000000, 'B-merchant'),
  ('5722f2c8-9de5-4712-9047-94d1fe8c8402', 'momo', '5ab2c1ca-7c70-49bd-bd0a-5811be28fb4d', 250000, 'B-momo'),
  ('03b492ea-6b2a-4498-9a3d-6ca03f822b17', 'float', null, 2500000, 'B-merchant'),
  ('c8d3910c-0cc5-44c5-b144-c9d7979f87ad', 'float', null, 4600000, 'B-merchant'),
  ('c8d3910c-0cc5-44c5-b144-c9d7979f87ad', 'momo', 'bef1faf4-03e1-4a8e-8751-e2f0d4fc769e', 1400000, 'B-momo'),
  ('d3ee851f-f301-4e32-8fc7-fc20b943a085', 'float', null, 700000, 'B-merchant'),
  ('89ced7e0-8ba7-4c16-a698-d8b8620c28a6', 'float', null, 50000, 'B-momo'),
  ('cfab91c0-ab75-4d74-b33a-7bb36f185fbf', 'momo', '9f395c0d-91f9-42ab-b375-8e4bd731d9e6', 50000, 'B-momo'),
  ('06b13983-6d32-4bb6-9e5b-9d6d3812039f', 'momo', '88e81d55-f88f-4549-9573-7d223867cefc', 286000, 'B-momo'),
  ('06b13983-6d32-4bb6-9e5b-9d6d3812039f', 'float', null, 14000, 'B-cfo'),
  ('b07e6d2b-4089-44be-8bd7-8b16fdfcd978', 'momo', '669d021a-74f8-4163-ac60-4fbd453de9c0', 4000000, 'B-momo'),
  ('6da29830-1f0f-4e23-aead-144add7bb89f', 'momo', 'd8a12574-e58d-45ed-bedd-7ca87d95dbb1', 3000000, 'B-momo'),
  ('d95ddae3-96cc-4e6d-9d1a-53c1d76bea29', 'momo', '315ff7a4-c28c-494e-8b7c-8eadcb780e55', 1000000, 'B-momo'),
  ('22c969c7-7ba0-43a6-862a-77c893d04e13', 'float', null, 8634490, 'B-merchant'),
  ('22c969c7-7ba0-43a6-862a-77c893d04e13', 'momo', '5eb24351-8784-4656-973b-0b3dd4e7a05d', 5000000, 'B-momo'),
  ('16c690d4-18dc-46fa-8207-80e5d052daa1', 'float', null, 1000000, 'B-merchant'),
  ('47eee81f-2bda-4149-9346-e0df4ed58c68', 'float', null, 2000000, 'B-cfo'),
  ('a8520d59-46a5-4e5a-94bb-18a729bd7847', 'momo', 'a46a3e6a-5c61-4d71-a331-ce92702129ac', 3251433, 'B-momo'),
  ('a8520d59-46a5-4e5a-94bb-18a729bd7847', 'momo', 'af19ea57-087c-4a5d-a8b1-5a6ea834828d', 1774580, 'B-momo'),
  ('a8520d59-46a5-4e5a-94bb-18a729bd7847', 'momo', '6fc66272-90e8-479d-9a74-a79639ebf307', 2000, 'B-momo'),
  ('afb9ce34-d2e5-48bc-829c-7679076b78cf', 'momo', 'a46a3e6a-5c61-4d71-a331-ce92702129ac', 1200000, 'B-momo'),
  ('81d68ab7-2bb1-4c2e-ab18-6ae1d691dee8', 'float', null, 10000, 'B-other'),
  ('e7570eff-e792-416c-aa72-c4c2c44d4b4b', 'float', null, 600000, 'B-cfo'),
  ('7c4782be-4a5c-4324-872a-fb4a712f485a', 'float', null, 1000000, 'B-merchant'),
  ('01f597ae-6281-412e-b9c5-e7b3fdc8a83f', 'float', null, 159899, 'B-merchant'),
  ('1f2e89da-645f-4f84-9d37-bf2719993873', 'float', null, 500000, 'B-merchant'),
  ('30f465e9-18a2-4e0b-9d4b-31e6f1ac8269', 'float', null, 200000, 'B-cfo'),
  ('994285c8-da8c-4e07-b08e-0960e06aec60', 'float', null, 200000, 'B-cfo'),
  ('c109ba5f-65e9-4efa-a1a8-c218a02e77df', 'momo', 'dc341377-2059-4e30-94c1-db8f011190d6', 100000, 'B-momo'),
  ('907e2576-6cc6-44cf-9688-b0c0751b332b', 'momo', '56baa306-53e1-4838-8460-729930bce1fb', 51000, 'B-momo'),
  ('907e2576-6cc6-44cf-9688-b0c0751b332b', 'float', null, 49000, 'B-cfo'),
  ('b3806a3c-9277-4a5b-a67f-c167f7c94a7b', 'float', null, 2000000, 'B-merchant'),
  ('d776b07a-c3c6-464d-b766-ba04a4c84a9f', 'float', null, 8417613, 'B-merchant'),
  ('f793bf55-7065-4bd4-97af-4c2226410917', 'momo', '9fc1ce97-1a75-4ea0-aff2-1b9c3b1f74c5', 1851433, 'B-momo'),
  ('f793bf55-7065-4bd4-97af-4c2226410917', 'momo', '9d182e07-f85f-4bf9-8768-fa0f58649377', 148567, 'B-momo'),
  ('bbf1d727-9fe4-409c-85ee-01f8729b50c4', 'momo', '2cb70695-14fe-4885-9e44-ac2dc5f1698d', 5000000, 'B-momo'),
  ('bbf1d727-9fe4-409c-85ee-01f8729b50c4', 'float', null, 8000000, 'B-cfo+B-merchant'),
  ('106ebbd3-0a36-43be-86f9-c5cce0941cc6', 'float', null, 100000, 'B-cfo'),
  ('a5dcdbb1-dc5f-4157-bdf2-1f33e1059f80', 'momo', '17f3cc71-be0f-461d-9dd9-12fef7b43808', 2000000, 'B-momo'),
  ('a5dcdbb1-dc5f-4157-bdf2-1f33e1059f80', 'momo', '9fc1ce97-1a75-4ea0-aff2-1b9c3b1f74c5', 648567, 'B-momo'),
  ('273fb82a-9cd8-4182-95fd-9b40a20cbfcd', 'float', null, 3000000, 'B-cfo'),
  ('ec9f94cc-66af-4036-ab4d-3e55d5084f69', 'float', null, 100000, 'B-other'),
  ('cf10b429-00c0-4897-9583-63cbde92d797', 'momo', 'bda46660-d625-400b-b9bf-359dff0e3fcb', 3182580, 'B-momo'),
  ('cf10b429-00c0-4897-9583-63cbde92d797', 'momo', '9cdf51b6-a952-4939-9415-ecfba2ad640c', 2000000, 'B-momo'),
  ('205fd3c1-4b30-4f99-9d46-d58fa83827c4', 'momo', 'bda46660-d625-400b-b9bf-359dff0e3fcb', 1217420, 'B-momo'),
  ('205fd3c1-4b30-4f99-9d46-d58fa83827c4', 'momo', '8896c67e-13f4-4130-b064-adb64c71afba', 1200000, 'B-momo'),
  ('1a908a17-0f57-49b1-9e64-8c1f4bea3a19', 'float', null, 1000000, 'B-merchant'),
  ('9e9ecaae-2f4d-4080-a0aa-513117233a13', 'momo', 'a07da3d2-284f-4ef9-98f2-bb3c928ab5f8', 5000000, 'B-momo'),
  ('c041ee44-d52a-4e63-bdd2-3e8b08bf571d', 'float', null, 2500000, 'B-merchant'),
  ('25f933d5-9931-4f85-bcb5-7434135075b9', 'momo', 'a7622c0c-7d2f-428f-8b96-905b2ccc3971', 500000, 'B-momo'),
  ('6669c29c-783a-48bb-9822-75209e4d6100', 'float', null, 2000000, 'B-merchant'),
  ('a44899c1-153e-4188-900c-0d2e96b2466c', 'float', null, 50000, 'B-cfo'),
  ('b6bfb6e5-d13b-4cc0-be2e-2d70ca314462', 'momo', '16ef34bf-f29b-46ee-96b0-31d9c880b8bc', 2761359, 'B-momo'),
  ('5ab5ebe8-7f63-40f0-b04e-45147777efde', 'momo', '16ef34bf-f29b-46ee-96b0-31d9c880b8bc', 1000000, 'B-momo'),
  ('9a119421-b52d-45f2-91c3-44f2df5a3254', 'momo', '16ef34bf-f29b-46ee-96b0-31d9c880b8bc', 100000, 'B-momo'),
  ('c336074d-bab9-4944-a733-33d7de3bb8df', 'momo', 'f4a0ee69-adb5-4e8f-ae56-cdd0e0abd742', 138641, 'B-momo'),
  ('c336074d-bab9-4944-a733-33d7de3bb8df', 'momo', 'fdba31bb-a206-48ad-8459-c60a370174df', 61359, 'B-momo'),
  ('f0dec2b0-af47-4da2-b278-513ddc5a7c35', 'float', null, 404226, 'B-cfo'),
  ('98fdcce1-271e-4e74-852e-5fb337c85ed5', 'momo', 'b2545f99-54e4-41a4-8fe2-380dd977ff28', 5000000, 'B-momo'),
  ('98fdcce1-271e-4e74-852e-5fb337c85ed5', 'momo', '0ab8ec1c-6e9d-4d77-a6b0-5dd9bdb1fcd2', 5000000, 'B-momo'),
  ('98fdcce1-271e-4e74-852e-5fb337c85ed5', 'momo', 'f4a0ee69-adb5-4e8f-ae56-cdd0e0abd742', 3861359, 'B-momo'),
  ('98fdcce1-271e-4e74-852e-5fb337c85ed5', 'momo', '16ef34bf-f29b-46ee-96b0-31d9c880b8bc', 1138641, 'B-momo'),
  ('d1fe9a5f-4a1e-490a-83d1-54c04d46c17e', 'momo', 'fdba31bb-a206-48ad-8459-c60a370174df', 3500000, 'B-momo'),
  ('2c2aea03-4c80-428b-8194-1e7bede4b6ca', 'float', null, 10000, 'B-cfo'),
  ('deda66c7-4844-4253-8b3b-a43e5f5606f8', 'momo', 'c595940f-0144-4df1-84ee-f3a486639fee', 2500000, 'B-momo'),
  ('11a0a01e-751b-420d-b755-df3c7516d3a2', 'momo', 'f0cbbb0c-3d9f-48dc-ad10-6f6a9aeecf66', 100000, 'B-momo'),
  ('d491b408-8b0e-424f-b629-e554abc1def8', 'float', null, 10000000, 'B-cfo'),
  ('1bc213b3-41b6-425b-8fc7-908ac9018f58', 'momo', 'fdba31bb-a206-48ad-8459-c60a370174df', 500000, 'B-momo'),
  ('94eb9e8c-2670-4676-9357-415d5bb45e60', 'momo', '0a773366-3b97-49b7-bd6e-88e8e949d338', 500000, 'B-momo'),
  ('355dc0dd-23d0-48db-9d7f-bce9f5e8b0ce', 'momo', 'e9e2e335-0ef0-41ca-801c-0acee29a2efc', 2000000, 'B-momo'),
  ('b65181a9-293a-4998-b69c-51afb78018e4', 'momo', '84664daa-92e8-4298-a4e5-65e2063e3227', 500000, 'B-momo'),
  ('2c28d3a2-f088-4ef3-a720-cf64634ec0f3', 'momo', 'b56d3653-f291-4de1-9fdd-7c11a255bcfd', 3000000, 'B-momo'),
  ('26c8ae8e-24ef-477f-a938-8d7cd7700688', 'float', null, 4000000, 'B-merchant'),
  ('9b5140ad-2bc7-4349-9c99-5ebcd0031f51', 'float', null, 1900000, 'B-merchant'),
  ('225ecaef-7778-408f-8726-1b6045714125', 'float', null, 1000000, 'B-merchant'),
  ('6d896650-642f-408c-829d-523a1fc2fe9a', 'float', null, 1000000, 'B-merchant'),
  ('aefb172e-5fd6-4f77-94a3-3b37f9793515', 'float', null, 1000000, 'B-merchant'),
  ('5b4408de-7c9e-4efd-9a12-3b5b1eacae32', 'momo', '4546fd7b-e063-446f-86cf-58a02c38e92b', 340000, 'B-momo'),
  ('5b4408de-7c9e-4efd-9a12-3b5b1eacae32', 'momo', 'aabd9a5b-b892-4a18-a1c6-092f655f4da4', 170000, 'B-momo'),
  ('cb0fb866-fbd0-4f0a-9e8e-67d2241a8bff', 'float', null, 1789201, 'B-merchant'),
  ('cb0fb866-fbd0-4f0a-9e8e-67d2241a8bff', 'momo', '2704bfed-458a-4500-86ca-c36bcfd53dc6', 292860, 'B-momo'),
  ('b019dc68-2ec1-4847-a332-5f1433dc488f', 'momo', '5ed48e82-eebf-4ce9-ad7d-107c105b1609', 100000, 'B-momo'),
  ('61051ea9-d1b6-424b-920a-d0ef060f588e', 'momo', 'de4a24a2-ce0f-4672-a6c9-19a008608f61', 1000000, 'B-momo'),
  ('8b5eaf29-d10f-4243-ad28-5a7c8768ea10', 'momo', '347a6eab-46c1-4e71-b41a-4c5f85319772', 5000000, 'B-momo'),
  ('8b5eaf29-d10f-4243-ad28-5a7c8768ea10', 'momo', 'e8537db9-a76f-465f-972b-4bce1007658f', 3000000, 'B-momo'),
  ('3bd053af-c8c8-46e1-8dad-26fea1f28e35', 'momo', 'd5fd3c5e-242b-41d1-ba63-da59f29960d2', 400000, 'B-momo'),
  ('ac9b7978-baa2-4047-836f-1e173499f0ad', 'momo', 'd3d48f1a-1d91-4329-b80d-cda5b376d391', 1000000, 'B-momo'),
  ('ac9b7978-baa2-4047-836f-1e173499f0ad', 'momo', '77600d41-274c-49ee-a96b-ec3054dabdd5', 100000, 'B-momo'),
  ('1658b409-bd41-4d0e-8f0d-c79b72301ed5', 'momo', '4b4cf1c2-58c5-4f1a-9791-31c0a908ccdd', 310000, 'B-momo'),
  ('b1c0f55d-f9ee-408e-b62f-396292df5e89', 'momo', 'c25a7f81-c108-4392-b5dd-5a09481b9c27', 1000000, 'B-momo'),
  ('bb0223a0-7b66-4663-be73-90172a127480', 'momo', '70057322-0bab-4dbc-b3bf-564e747a6bc9', 102000, 'B-momo'),
  ('50f76686-1321-4d99-8090-cc959503bfc8', 'momo', 'f7e5dc8e-ec6b-49dc-9bb9-b6af1411f095', 3700000, 'B-momo'),
  ('c677a1fe-f9d7-4469-aa78-4ffd756e8cb1', 'momo', '9381c8a7-82cf-410f-b1be-7fb9f239dc55', 3000000, 'B-momo'),
  ('51ee2d7f-3458-4fd8-9feb-241f52160189', 'momo', 'deb7e03e-c274-467f-b407-6a588d3ab27a', 1000000, 'B-momo'),
  ('b1dd1672-7944-4edf-9110-9051084b5c65', 'momo', 'a1dd44ad-5e80-4639-975d-5c6c59d45e49', 4180378, 'B-momo'),
  ('1a54900b-81f7-4dfd-bee9-fc7b145577ed', 'momo', 'ee752105-43a1-4e88-bb40-ba6be6baa5f3', 910000, 'B-momo'),
  ('0f9387c8-7726-461a-a89f-68a8a802c56d', 'momo', 'e66b681e-fe42-4795-a976-e604bd381487', 201412, 'B-momo'),
  ('42d2afe2-87c4-40ba-8440-e75e3046032a', 'momo', 'b6496b3e-69a9-4579-bb46-1bbbf532de0d', 298300, 'B-momo'),
  ('42d2afe2-87c4-40ba-8440-e75e3046032a', 'momo', 'b424fcf3-776a-4dc4-88aa-50f9c6fb31c6', 1700, 'B-momo'),
  ('441c5bf8-33cf-4029-b6ad-41c8b2a9ded5', 'momo', '9ccfbfcb-eee4-4dfc-b544-c621aede7fea', 750000, 'B-momo'),
  ('3ddbc1ed-325c-4c4f-8b75-130f32d1a154', 'momo', 'eb77bcf0-950b-41ab-972b-22527e3d9647', 500000, 'B-momo'),
  ('74301a10-368f-4914-ae16-86236c26100a', 'float', null, 300000, 'B-cfo'),
  ('7b452f35-103a-4ee1-a548-987579ec8a87', 'momo', '0d8b5ba3-9b14-41fc-8d0d-25e6580a3f8a', 50000, 'B-momo'),
  ('9b6d518f-7556-4e10-ae7f-6a2e8265e7ce', 'momo', 'cf720174-ce29-4a75-8102-c60dff8d1217', 100000, 'B-momo'),
  ('c67bacf9-667c-4ace-966b-70432cabc356', 'momo', 'a4896059-92b0-4429-b7d7-70fec4578c8d', 1138860, 'B-momo'),
  ('1a371d05-1da7-4887-9084-d17380d793a0', 'momo', 'a4896059-92b0-4429-b7d7-70fec4578c8d', 2200000, 'B-momo'),
  ('6f1d6c04-ae15-4c8d-9352-c1ca3a0746ea', 'momo', 'a4896059-92b0-4429-b7d7-70fec4578c8d', 300000, 'B-momo'),
  ('7dcfe534-c3d2-4638-90b8-d6ed56649944', 'momo', '71d635b8-c1a4-4220-88c4-cb40ad868b36', 52800, 'B-momo'),
  ('c9c4dd0c-c9bf-42bf-83f0-0f7e676b7257', 'momo', '6e2b7bc2-1a3c-4e24-997e-221174d9632b', 5000000, 'B-momo'),
  ('c9c4dd0c-c9bf-42bf-83f0-0f7e676b7257', 'momo', '921c5344-ab7f-4b60-b7d1-b6d25fe27cb2', 2000000, 'B-momo'),
  ('397aafc6-7fd1-4d70-a537-2f345e2adf36', 'momo', 'f78429f3-33e8-4795-a9c7-3abafbc98747', 400000, 'B-momo'),
  ('29d4a67e-5797-4c7d-8951-f362e71b4995', 'momo', '9e06ea60-9c47-4d2b-854a-fba0f381228f', 203000, 'B-momo'),
  ('612832cb-357b-4328-8c06-76492b6bde77', 'momo', 'cc85face-37e3-474c-8442-cdd7b8772bf4', 500000, 'B-momo'),
  ('09a12310-179d-45fd-9ab0-076f9387c7d3', 'float', null, 200000, 'B-cfo'),
  ('7ca9e875-b1bd-435a-93ab-34cce97f684f', 'momo', 'c28fbd28-56e1-4184-bccb-c1f24a8381f9', 500000, 'B-momo'),
  ('414796c4-04f5-4482-bb96-976760edb263', 'momo', '93e5ece4-398f-4eaa-98e1-a97f6d3ef09f', 100000, 'B-momo'),
  ('832e0805-7bbe-46b6-81cd-778237aebc07', 'momo', '981220c7-41a5-4a5a-84e6-2bc619c0c1eb', 1888860, 'B-momo'),
  ('832e0805-7bbe-46b6-81cd-778237aebc07', 'momo', 'a4896059-92b0-4429-b7d7-70fec4578c8d', 1111140, 'B-momo'),
  ('94685ef8-6baf-4060-a428-5c4f19e24ed6', 'momo', '10a7e49d-0cac-47d5-8a8b-5a308f9f4abe', 50000, 'B-momo'),
  ('9ec253c1-cec9-4238-a76b-f1e62ddb2520', 'momo', 'a847723e-34ea-4b86-9be5-26d95decd805', 5000000, 'B-momo'),
  ('b4d23268-fefd-4826-a2eb-927c79f5dd77', 'momo', 'ad2697cd-3705-41ef-a124-5a73cab9722d', 200000, 'B-momo'),
  ('31a5b943-2c52-40e3-b15b-b5dd8c130393', 'momo', '03c456b7-038f-4d5c-b9a1-384c4da20655', 400000, 'B-momo'),
  ('f719adcd-d4b6-4c4b-bb17-be911db64640', 'momo', '3308ee62-e7fb-4387-8590-9e57d84895c6', 1000000, 'B-momo'),
  ('7bcb37d7-b370-4022-8c1f-10c2bf8d4f5a', 'momo', '4a436c69-8224-4c3e-83a0-37897fd3b769', 1500000, 'B-momo'),
  ('0717cfb9-ccb2-40c1-9a46-c4b14560bd71', 'momo', '751e50cd-4a7d-4765-af83-09866d44aff4', 500000, 'B-momo'),
  ('0717cfb9-ccb2-40c1-9a46-c4b14560bd71', 'float', null, 265000, 'B-cfo'),
  ('9be63a0d-7360-4f64-838c-1e739029bbce', 'momo', '0626c968-ceb6-4b22-8733-21d9fba43dbd', 300000, 'B-momo'),
  ('fd8b2b1e-f759-4f31-8cc5-aaaf5f857c2f', 'momo', '3b3652d9-d5d5-448f-8ce5-5fc851e2cf79', 550000, 'B-momo'),
  ('23a346ea-88d3-439c-b1a1-2d70e40ccbda', 'momo', '6d1b2dc4-096b-41a2-b455-9e3e8c5dd33f', 30000, 'B-momo'),
  ('d3cef606-bb8d-4fda-8390-86535ccb6305', 'float', null, 500000, 'B-cfo'),
  ('d25c9c63-6492-4c09-bb6a-f23aec700b12', 'momo', '7be7f582-8834-4a44-ab97-b3d2e321342c', 50000, 'B-momo'),
  ('94ea3b4e-eabf-4dfe-8633-5b2f1b0df6be', 'momo', '5b9d6a35-8ac2-43a8-be41-0d72378e59b2', 5000000, 'B-momo'),
  ('e374b6cd-5167-42da-87ad-f3a612f61e17', 'momo', 'e39451fb-d557-4f30-896e-17bb738cbc97', 5000000, 'B-momo'),
  ('c2c14d70-0f59-4c90-a6f6-eeb0a19b0a95', 'momo', 'f4009193-d409-4ff9-9cd4-719380b666f8', 500000, 'B-momo'),
  ('5e869308-944f-43b7-9b1b-5a86e3dfe1cc', 'momo', '0127ec7f-99a8-4967-9f8a-d3ac94192891', 152617, 'B-momo'),
  ('f03fd0f2-7f37-42ea-9904-3349c36df4d2', 'momo', '9229686c-fe51-4f7b-b7e4-6941f24db1ae', 2800000, 'B-momo'),
  ('93f296ef-8626-4c9d-9d78-cd667d28b93e', 'momo', 'fdba31bb-a206-48ad-8459-c60a370174df', 20000, 'B-momo'),
  ('18371989-7bed-46d8-8e27-70e24cd5a933', 'float', null, 100000, 'B-cfo'),
  ('3f0d1387-e2f9-483c-922d-b45ea5f64ab3', 'momo', '70b47275-1215-43e6-8504-d895a1f0fc70', 200000, 'B-momo')
;

do $corr$
declare
  c_batch constant text := 'acct_corr_202611_wallet_l1';
  c_cfo   constant uuid := '29a0cfa8-1eaf-453c-874c-0fc72fa4f74b';
  r record; e record; l jsonb; v_n int; v_x numeric; v_grp uuid; v_legs jsonb; v_key text;
  s_wallet_legs bigint; s_wallet_sum numeric; s_dep text; s_pf text;
begin
  if (select count(*) from public.ledger_account_map where category like 'wallet_correction_reclass_%') <> 10 then
    raise exception 'STOP: migration 20261125110000 is not installed';
  end if;
  if exists (select 1 from public.accounting_correction_register where batch = c_batch) then
    raise exception 'STOP: batch % is already posted', c_batch;
  end if;
  select * into e from _expected;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from _w;
  if v_n <> e.w_n or v_x <> e.w_amount then raise exception 'STOP: W input is % / %, approved % / %', v_n, v_x, e.w_n, e.w_amount; end if;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from _f;
  if v_n <> e.f_n or v_x <> e.f_amount then raise exception 'STOP: F input is % / %, approved % / %', v_n, v_x, e.f_n, e.f_amount; end if;

  -- 1. Every row still matches the evidence.
  for r in select w.*, g.id gid, g.amount gamt, g.direction, g.classification, g.wallet_bucket, g.source_table
           from _w w left join public.general_ledger g on g.id = w.leg loop
    if r.gid is null or r.gamt <> r.amount or r.direction <> 'cash_out' or r.classification <> 'admin_correction'
       or r.wallet_bucket not in ('withdrawable', 'locked') or r.source_table <> 'cfo_direct_credit' then
      raise exception 'STOP: CFO debit % no longer matches the evidence', r.leg;
    end if;
  end loop;
  for r in select f.payment_leg, sum(f.amount) amt, g.id gid, g.amount gamt, g.category, g.wallet_bucket, g.direction, g.source_table
           from _f f left join public.general_ledger g on g.id = f.payment_leg group by 1, 3, 4, 5, 6, 7, 8 loop
    if r.gid is null or r.category <> 'partner_funding' or r.wallet_bucket <> 'float' or r.direction <> 'cash_out'
       or r.source_table not in ('investor_portfolios', 'wallets', 'partner_self_funding_lines') or r.amt > r.gamt + 0.5 then
      raise exception 'STOP: top-up % no longer matches the evidence (% of %)', r.payment_leg, r.amt, r.gamt;
    end if;
  end loop;
  if exists (select 1 from _f f where f.kind = 'momo' and not exists (
               select 1 from public.deposit_requests d where d.id = f.deposit_id and d.status = 'approved' and d.provider in ('airtel', 'mtn'))) then
    raise exception 'STOP: a mobile-money deposit is no longer an approved airtel/mtn deposit';
  end if;

  -- 2. Money-safety snapshot.
  select count(*), coalesce(sum(amount), 0) into s_wallet_legs, s_wallet_sum from public.general_ledger where ledger_scope = 'wallet';
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_dep from public.deposit_requests t where t.id in (select deposit_id from _f where deposit_id is not null);
  select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) into s_pf from public.investor_portfolios t;

  -- 3W. Reclassify each CFO debit that reversed an earlier credit to that credit's accounts.
  for r in select w.*, g.transaction_date td, g.transaction_group_id grp from _w w join public.general_ledger g on g.id = w.leg order by g.transaction_date, w.leg loop
    v_legs := '[]'::jsonb;
    for l in select * from jsonb_array_elements(r.legs) loop
      v_legs := v_legs || jsonb_build_array(jsonb_build_object('ledger_scope', 'platform', 'direction', l->>1, 'amount', (l->>2)::numeric,
        'category', 'wallet_correction_reclass_' || lower(l->>0), 'source_table', 'general_ledger', 'source_id', r.leg,
        'reference_id', r.grp::text, 'currency', 'UGX', 'classification', 'production', 'transaction_date', r.td,
        'description', format('Correction (accounting only, no money moved): CFO wallet debit of UGX %s reversed an earlier credit; moved from Legacy Opening Balance Adjustments to %s, where that credit was booked', r.amount, l->>0)));
    end loop;
    v_grp := public.create_ledger_transaction(v_legs, c_batch || ':w:' || r.leg::text, false);
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, original_group_id,
      correction_group_id, amount, before_value, after_value, detail, created_by)
    values (c_batch, 'W', 'wallet_debit_reclassified_to_original_account', 'general_ledger', r.leg, r.grp, v_grp, r.amount, r.amount, 0,
      jsonb_build_object('legs', r.legs), c_cfo);
  end loop;

  -- 3F. Company float used for Partner top-ups.
  for r in select f.*, g.transaction_date td, g.transaction_group_id grp, g.source_id pid, d.provider, d.transaction_id
           from _f f join public.general_ledger g on g.id = f.payment_leg left join public.deposit_requests d on d.id = f.deposit_id
           order by g.transaction_date, f.payment_leg, f.kind loop
    v_key := c_batch || ':f:' || r.payment_leg::text || ':' || coalesce(r.deposit_id::text, 'float');
    if r.kind = 'momo' then
      v_grp := public.create_ledger_transaction(jsonb_build_array(
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amount, 'category', 'verified_bank_cash_recognised',
          'source_table', 'deposit_requests', 'source_id', r.deposit_id, 'reference_id', r.payment_leg::text, 'currency', 'UGX', 'classification', 'production', 'transaction_date', r.td,
          'description', format('Correction (accounting only, no money moved): %s float payment %s (UGX %s) was received on the company''s mobile-money line and paid for a Partner top-up; records it as cash.', r.provider, coalesce(r.transaction_id, r.deposit_id::text), r.amount)),
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amount, 'category', 'agent_float_deposit',
          'source_table', 'deposit_requests', 'source_id', r.deposit_id, 'reference_id', r.payment_leg::text, 'currency', 'UGX', 'classification', 'production', 'transaction_date', r.td,
          'description', 'Correction (accounting only, no money moved): reverses the float-cycle credit for the part of this mobile-money float used for a Partner top-up.'),
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'cash_custody_payable',
          'source_table', 'deposit_requests', 'source_id', r.deposit_id, 'reference_id', r.payment_leg::text, 'currency', 'UGX', 'classification', 'production', 'transaction_date', r.td,
          'description', 'Correction (accounting only, no money moved): the money is held for the Supporter until it funds the top-up (closed by the existing top-up entry).'),
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'agent_float_cash_offset',
          'source_table', 'deposit_requests', 'source_id', r.deposit_id, 'reference_id', r.payment_leg::text, 'currency', 'UGX', 'classification', 'production', 'transaction_date', r.td,
          'description', 'Correction (accounting only, no money moved): reverses the agent-float debit for this part of the deposit; the money was received by the company.')),
        v_key, false);
      insert into public.money_in_report_exclusions (transaction_group_id, reason, correction_item)
      values (v_grp, 'Reclassification of a mobile-money receipt already received (accounting only): not new money', 'F');
    else
      v_grp := public.create_ledger_transaction(jsonb_build_array(
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_in', 'amount', r.amount, 'category', 'agent_float_deposit',
          'source_table', 'general_ledger', 'source_id', r.payment_leg, 'reference_id', r.grp::text, 'currency', 'UGX', 'classification', 'production', 'transaction_date', r.td,
          'description', format('Correction (accounting only, no money moved): company float (%s) used for a Partner top-up (UGX %s) closes the float cycle; the Supporter''s cash stays with the agent.', r.classes, r.amount)),
        jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', r.amount, 'category', 'cash_custody_payable',
          'source_table', 'general_ledger', 'source_id', r.payment_leg, 'reference_id', r.grp::text, 'currency', 'UGX', 'classification', 'production', 'transaction_date', r.td,
          'description', 'Correction (accounting only, no money moved): restores Wallet Custody charged for a top-up that was paid from company float, not from the Supporter''s money held by Welile.')),
        v_key, false);
    end if;
    insert into public.accounting_correction_register (batch, correction_item, action, source_table, source_id, original_group_id,
      correction_group_id, amount, before_value, after_value, detail, created_by)
    values (c_batch, 'F', case when r.kind = 'momo' then 'company_line_momo_float_to_custody' else 'company_float_used_for_topup' end,
      'general_ledger', r.payment_leg, r.grp, v_grp, r.amount, r.amount, 0,
      jsonb_build_object('portfolio_id', r.pid, 'deposit_id', r.deposit_id, 'classes', r.classes), c_cfo);
  end loop;

  -- 4. Checks.
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.accounting_correction_register where batch = c_batch and correction_item = 'W';
  if v_n <> e.w_n or v_x <> e.w_amount then raise exception 'STOP: W posted % / %', v_n, v_x; end if;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.accounting_correction_register where batch = c_batch and correction_item = 'F';
  if v_n <> e.f_n or v_x <> e.f_amount then raise exception 'STOP: F posted % / %', v_n, v_x; end if;
  if exists (select 1 from public.general_ledger g where g.idempotency_key like c_batch || ':%' and g.ledger_scope <> 'platform') then
    raise exception 'STOP: a correction leg is not platform-scope';
  end if;
  select count(*), coalesce(sum(amount), 0) into v_n, v_x from public.general_ledger where ledger_scope = 'wallet';
  if v_n <> s_wallet_legs or v_x <> s_wallet_sum then raise exception 'STOP: a wallet-scope ledger leg was written'; end if;
  if (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.deposit_requests t where t.id in (select deposit_id from _f where deposit_id is not null)) <> s_dep then
    raise exception 'STOP: a deposit record changed';
  end if;
  if (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.investor_portfolios t) <> s_pf then
    raise exception 'STOP: a portfolio changed';
  end if;

  insert into public.audit_logs (user_id, action_type, action, table_name, record_id, reason, metadata)
  values (c_cfo, 'accounting_correction_batch_posted', 'wallet_corrections_and_company_float', 'accounting_correction_register', c_batch,
    'Wallet corrections reclassified to the accounts they reversed; company float used for Partner top-ups (accounting only)',
    jsonb_build_object('w', e.w_n, 'w_amount', e.w_amount, 'f', e.f_n, 'f_amount', e.f_amount));
  raise notice 'batch % posted: W % / UGX %, F % / UGX %', c_batch, e.w_n, e.w_amount, e.f_n, e.f_amount;
end $corr$;

commit;

-- ROLLBACK (only on CFO instruction): for each register row of this batch, post the same legs with directions swapped,
-- idempotency key acct_corr_202611_wallet_l1:rb:<register id>, dated today, exclude the mobile-money ones from Money In,
-- and set rolled_back_at.
